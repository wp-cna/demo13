// Anthropic-backed Community Posting vetting for WPCNA.
//
// Mirrors the structured-review contract the rest of the worker expects, but
// uses the Anthropic Messages API instead of OpenAI. The WPCNA owner's key is
// supplied as the `ANTHROPIC_API_KEY` worker secret and never reaches the
// browser. This module only *vets*; it never publishes or replies to the
// submitter. The deterministic checks in posting-review.js remain the first
// guardrail; this adds graded judgment against the published guidelines.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Sonnet 4.6 is the default: at this site's low volume the cost is pennies
// per month, so judgment quality on borderline/sensitive submissions wins.
// Override with POSTING_REVIEW_MODEL (e.g. claude-haiku-4-5-20251001) to cut
// cost if volume ever grows.
const DEFAULT_MODEL = "claude-sonnet-4-6";

// The three buckets the WPCNA owner asked for. ESCALATE is not a fourth
// bucket; it is a flag that can ride on NEEDS_REVIEW or NOT_QUALIFIED for
// sensitive material a human must look at carefully.
const RECOMMENDATIONS = new Set(["READY_TO_POST", "NEEDS_REVIEW", "NOT_QUALIFIED"]);

const CHECKLIST_KEYS = [
  "relevantToWhitePlainsResidents",
  "communityServing",
  "civicEducationalPublicInterestPurpose",
  "notPrivateClassifiedListing",
  "notCommercialAdvertising",
  "notPersonalDisputeOrComplaint",
  "notUrgentEmergencyMessaging",
  "includesDateIfTimeBased",
  "includesTimeIfTimeBased",
  "includesLocationIfLocationBased",
  "includesOrganizerSource",
  "includesContactInformationForFollowUp"
];

const FALLBACK_REVIEW = {
  recommendation: "NEEDS_REVIEW",
  escalate: true,
  confidence: 0,
  reason:
    "The AI vetting step could not complete, so this submission is being routed to a person for manual review.",
  missingInformation: ["Manual review required"],
  suggestedFollowUp: "Please review the original submission directly before taking any action.",
  cleanedUpDraftSummary: "",
  checklist: Object.fromEntries(CHECKLIST_KEYS.map((key) => [key, "unclear"]))
};

const SYSTEM_PROMPT = [
  "You privately assist the White Plains Council of Neighborhood Associations (WPCNA) with Community Posting intake review.",
  "This is advisory vetting only. You never approve for publication, reject, publish, or send anything to the submitter. A WPCNA person makes the final call.",
  "",
  "WPCNA Community Posting standards (from the public guidelines):",
  "WELCOME: neighborhood events, school picnics, cleanups, and local meetings; civic or educational efforts including awareness campaigns and newsletters; city-related notices such as hydrant flushing, road work, or public-interest updates; local initiatives that help White Plains residents stay informed or get involved.",
  "NOT WELCOME: yard sales, personal listings, or private services; business advertising, promotions, or commercial offers; anything that must appear immediately / urgent emergency messaging; items unrelated to White Plains residents or neighborhood life.",
  "Good submissions include the practical basics: what it is, who it is for, when it happens, where it takes place, and any relevant link.",
  "",
  "Decide ONE recommendation:",
  "- READY_TO_POST: clearly local, community-serving, on-topic, and complete enough that a person could post it with little or no edits.",
  "- NEEDS_REVIEW: plausibly appropriate but missing practical details, ambiguous, borderline, or sensitive enough that a person should look closely.",
  "- NOT_QUALIFIED: clearly outside the guidelines (commercial/advertising, classifieds/private listings, unrelated to White Plains, spam/scam, or otherwise disallowed).",
  "",
  "Be conservative. When genuinely uncertain between buckets, choose NEEDS_REVIEW rather than guessing READY_TO_POST or NOT_QUALIFIED.",
  "Set escalate=true (and use NEEDS_REVIEW unless the content is clearly disallowed) whenever the submission is defamatory, accusatory, naming a personal dispute, political-campaign content, legal, medical, emergency/safety-critical, discriminatory, or threatening. A person must handle those carefully.",
  "Do not invent facts about the submission. Judge only what is provided.",
  "",
  "Return ONLY a single JSON object, no prose, no markdown, with exactly these keys:",
  "recommendation (READY_TO_POST | NEEDS_REVIEW | NOT_QUALIFIED), escalate (boolean), confidence (number 0..1), reason (string, one or two sentences for the WPCNA reviewer), missingInformation (array of short strings; empty if nothing missing), suggestedFollowUp (string; empty if none), cleanedUpDraftSummary (string; a tidy one-line summary WPCNA could start from, or empty if the item is unsuitable or too unclear), checklist (object).",
  "checklist must contain exactly these keys, each valued yes, no, or unclear:",
  CHECKLIST_KEYS.join(", "),
  "."
].join("\n");

function clampConfidence(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

function normalizeRecommendation(value = "") {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  return RECOMMENDATIONS.has(normalized) ? normalized : "NEEDS_REVIEW";
}

function normalizeChecklistValue(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "yes" || normalized === "no" ? normalized : "unclear";
}

function normalizeReview(review) {
  if (!review || typeof review !== "object") {
    return { ...FALLBACK_REVIEW };
  }

  const sourceChecklist =
    review.checklist && typeof review.checklist === "object" ? review.checklist : {};
  const checklist = Object.fromEntries(
    CHECKLIST_KEYS.map((key) => [key, normalizeChecklistValue(sourceChecklist[key])])
  );

  const missingInformation = Array.isArray(review.missingInformation)
    ? review.missingInformation.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    : String(review.missingInformation || "")
        .split(/\n|;/)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 8);

  const recommendation = normalizeRecommendation(review.recommendation);

  return {
    recommendation,
    escalate: review.escalate === true || review.escalate === "true",
    confidence: clampConfidence(review.confidence),
    reason: String(review.reason || FALLBACK_REVIEW.reason).trim().slice(0, 900),
    missingInformation,
    suggestedFollowUp: String(review.suggestedFollowUp || "").trim().slice(0, 600),
    cleanedUpDraftSummary: String(review.cleanedUpDraftSummary || "").trim().slice(0, 600),
    checklist
  };
}

function extractJsonObject(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function extractTextFromMessage(payload = {}) {
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

// Compact view of the submission for the model. Keeps the prompt small and
// avoids passing along honeypot/internal fields.
function submissionForModel(submission = {}, ruleReview = null) {
  const view = {
    title: submission.subject || submission.title || "",
    category: submission.category || "",
    postingType: submission.postingType || "",
    organization: submission.organization || submission.organizationName || "",
    eventDate: submission.eventDate || "",
    eventTime: submission.eventTime || "",
    location: submission.location || "",
    intendedAudience: submission.audience || submission.intendedAudience || [],
    whitePlainsAffiliation: submission.whitePlainsAffiliation || "",
    fundraising: submission.fundraising || "",
    linksIncluded: submission.linksIncluded || "",
    description: submission.message || submission.description || ""
  };

  if (ruleReview) {
    view.deterministicSignals = {
      triggeredFlags: ruleReview.triggeredFlags || [],
      missingInformation: ruleReview.missingInformation || []
    };
  }

  return view;
}

export async function reviewPostingWithAnthropic({ env, submission, ruleReview = null }) {
  if (!env || !env.ANTHROPIC_API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY");
  }

  const model = env.POSTING_REVIEW_MODEL || env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const userText = [
    "Vet this Community Posting submission against the WPCNA standards.",
    'The "deterministicSignals" are advisory output from rule-based pre-checks; weigh them but do not treat them as final.',
    "",
    "Submission:",
    JSON.stringify(submissionForModel(submission, ruleReview), null, 2)
  ].join("\n");

  const response = await fetch(env.ANTHROPIC_API_URL || ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": env.ANTHROPIC_VERSION || ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: userText }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Anthropic request failed with ${response.status}: ${detail.slice(0, 300)}`);
  }

  const payload = await response.json();
  const text = extractTextFromMessage(payload);
  const parsed = extractJsonObject(text);

  return normalizeReview(parsed);
}

export { CHECKLIST_KEYS, FALLBACK_REVIEW, normalizeReview };

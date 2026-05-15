# Community Posting Review Endpoint

This demo runs in advisory review mode. The Community Posting form sends structured intake data to a private Cloudflare Worker, which performs deterministic guideline checks, sends a private audit email, and returns a neutral confirmation to the browser.

It does not auto-publish, auto-approve, auto-reject, or create public posting pages.

## Runtime

The Worker entrypoint is `worker/src/posting-worker.js`, with review logic in `worker/src/posting-review.js`.

Supported routes:

- `/`
- `/posting-review`
- `/api/posting-review`

The static site receives the deployed Worker URL through the `POSTING_API_URL` build variable.

## Private Worker Configuration

Set secrets with `wrangler secret put`; do not commit real values.

Preferred email path:

- `RESEND_API_KEY`
- `POSTING_EMAIL_FROM`
- `POSTING_RECIPIENT_EMAILS`

Fallback webhook path:

- `POSTING_EMAIL_WEBHOOK_URL`
- `POSTING_CC_EMAILS`

Some browser-oriented form services challenge server-side Worker requests. If the Worker returns an email handoff error, use the Resend path with a verified sender instead of FormSubmit.

Worker vars:

- `ALLOWED_ORIGINS=https://wp-cna.github.io`

No recipient email addresses, API keys, or webhook URLs should appear in public HTML or frontend JavaScript.

## Flow

1. The resident submits the Community Posting intake form.
2. The frontend sends structured JSON to `POSTING_API_URL`.
3. The Worker validates required fields, email format, field lengths, honeypot state, and rate limits.
4. The Worker runs rule-based civic posting review.
5. The Worker emails a scannable audit report with the original submission, recommendation, triggered flags, missing information, checklist, and cleaned-up draft summary when appropriate.
6. The browser receives only a neutral confirmation message.

## Recommendations

The rule-based review can return:

- `READY FOR HUMAN REVIEW`
- `NEEDS MORE INFORMATION`
- `LIKELY OUTSIDE GUIDELINES`
- `ESCALATE TO HUMAN`

The recommendation is advisory only.

## Test Curl

Replace the URL with the deployed Worker endpoint.

```bash
curl -i -X POST "https://YOUR-WORKER.workers.dev/posting-review" \
  -H "Origin: https://wp-cna.github.io" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sarah Klein",
    "email": "sarah@example.com",
    "subject": "Battle Hill Block Cleanup",
    "category": "Volunteer / Cleanup",
    "postingType": "Event",
    "organization": "Battle Hill Neighborhood Association",
    "eventDate": "2026-06-14",
    "eventTime": "09:00",
    "location": "Battle Hill Park",
    "audience": ["Neighborhood residents", "Families"],
    "whitePlainsAffiliation": "White Plains resident or neighborhood group",
    "fundraising": "No",
    "linksIncluded": "No",
    "guidelinesConfirmed": "yes",
    "message": "The Battle Hill neighborhood association is organizing a volunteer cleanup morning at Battle Hill Park for residents and families.",
    "pageSource": "/demo12/posting/"
  }'
```

Expected browser response:

```json
{
  "ok": true,
  "message": "Submission received. WPCNA will review it before anything is posted."
}
```

## Demo12 Deployment Notes

For the GitHub Pages demo build, set:

- `SITE_BASE_URL=https://wp-cna.github.io`
- `SITE_PATH_PREFIX=/demo12`
- `CANONICAL_PATH_PREFIX=/demo12`
- repository variable `POSTING_API_URL` to the deployed Worker `/posting-review` URL

The deploy workflow fails if `POSTING_API_URL` is missing so the live form cannot silently ship with an empty backend endpoint.

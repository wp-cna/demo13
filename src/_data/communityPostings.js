// Community postings are stored as plain data in communityPostings.json so the
// list is easy to edit by hand and safe for the approval Worker to append to.
// This module loads that data and adds the derived fields the templates use.
const rawPostings = require("./communityPostings.json").postings;

function toSearchText(posting) {
  return [
    posting.title,
    posting.category,
    posting.sourceLabel,
    posting.locationName,
    posting.locationAddress,
    posting.shortSummary
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function withDerivedFields(posting) {
  const detailUrl = `/posting/${posting.slug}/`;
  const monthKey = posting.startDate.slice(0, 7);

  return {
    ...posting,
    organizer: posting.sourceLabel,
    source: posting.sourceLabel,
    detailUrl,
    monthKey,
    cardActionLabel: "Posting details",
    primaryAction: {
      label: "Posting details",
      url: `${detailUrl}#about-this-posting`
    },
    searchText: toSearchText(posting)
  };
}

const all = rawPostings
  .map(withDerivedFields)
  .sort((a, b) => `${a.startDate}T${a.startTime}`.localeCompare(`${b.startDate}T${b.startTime}`));

module.exports = {
  all,
  upcoming: all.filter((posting) => posting.status === "upcoming"),
  categories: [...new Set(all.map((posting) => posting.category))]
};

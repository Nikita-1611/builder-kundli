// Client-side matching against the ~19-row builder index. Small enough that
// a full linear scan on every keystroke is not worth optimizing.

const MAX_SUGGESTIONS = 6;

function normalize(text) {
  return text.trim().toLowerCase();
}

// Every string this builder could plausibly be typed as -- its canonical
// name plus every raw name variant merged into it (see build.py).
function searchableNames(entry) {
  return [entry.name, ...(entry.aliases || [])];
}

// Ranks a builder's best-matching name against the query: 0 = starts with
// the query, 1 = contains it elsewhere, Infinity = no match at all.
function bestRank(entry, query) {
  let rank = Infinity;
  for (const name of searchableNames(entry)) {
    const normalized = normalize(name);
    if (normalized.startsWith(query)) rank = Math.min(rank, 0);
    else if (normalized.includes(query)) rank = Math.min(rank, 1);
  }
  return rank;
}

// Suggestions shown live as the user types. Autocomplete is intentionally
// closed-world: only builders actually in the dataset can ever appear here.
export function suggestBuilders(query, index) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];

  return index
    .map((entry) => ({ entry, rank: bestRank(entry, normalizedQuery) }))
    .filter(({ rank }) => rank !== Infinity)
    .sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ entry }) => entry);
}

// An exact match for whatever the user actually typed and submitted --
// used on Enter/search-button so a full correct name always resolves even
// if the user never opened the suggestion dropdown.
export function findExactMatch(query, index) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return null;
  return index.find((entry) => searchableNames(entry).some((name) => normalize(name) === normalizedQuery)) ?? null;
}

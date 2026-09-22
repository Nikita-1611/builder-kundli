// Everything the site knows comes from static files under public/builders/,
// synced from ../builders/*.json (stage 5 output) by scripts/sync-builders.mjs.
// No backend, no database -- see ARCHITECTURE.md.

let indexPromise = null;

// The full list of {id, name, aliases, score} for every builder in the
// dataset. Fetched once and cached in memory for the life of the tab --
// it's ~19 small rows, not worth re-fetching per keystroke.
export function fetchBuilderIndex() {
  if (!indexPromise) {
    indexPromise = fetch("/builders/index.json").then((res) => {
      if (!res.ok) throw new Error(`failed to load builder index: ${res.status}`);
      return res.json();
    });
  }
  return indexPromise;
}

// One builder's full scored record. Returns null if this id isn't in the
// dataset (a bad/old link, or a guessed URL) rather than throwing --
// callers render the empty state for that case, not an error screen.
export async function fetchBuilder(id) {
  const res = await fetch(`/builders/${id}.json`);
  if (!res.ok) return null;
  return res.json();
}

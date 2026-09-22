// The homepage stats strip's warrant/project/amount totals -- computed at
// sync time (scripts/sync-builders.mjs) from the same raw/warrants.json
// the pipeline and README/ARCHITECTURE.md cite, instead of a hand-typed
// constant that can silently drift from the real registry total. Cached
// the same way fetchDistricts is: one small file, fetched once per tab.
let statsPromise = null;

export function fetchStats() {
  if (!statsPromise) {
    statsPromise = fetch("/stats.json").then((res) => {
      if (!res.ok) throw new Error(`failed to load stats: ${res.status}`);
      return res.json();
    });
  }
  return statsPromise;
}

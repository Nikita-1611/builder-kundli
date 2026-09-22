// The district-level warrant map, precomputed at sync time from
// raw/warrants.json by scripts/sync-builders.mjs (see that file for why --
// no later pipeline stage keeps a district field). Cached the same way
// fetchBuilderIndex is: it's one small file, fetched once per tab.
let districtsPromise = null;

export function fetchDistricts() {
  if (!districtsPromise) {
    districtsPromise = fetch("/districts.json").then((res) => {
      if (!res.ok) throw new Error(`failed to load districts: ${res.status}`);
      return res.json();
    });
  }
  return districtsPromise;
}

// Every district a builder has warrants in, with their warrant count AND
// distinct project count *in that district* (not the builder's state-wide
// project_count -- see sync-builders.mjs), sorted highest first. A builder
// can only ever be linked to a district through this builders[] list (see
// sync-builders.mjs) -- there's no district field on builders/*.json itself.
export function findBuilderDistricts(districtsData, builderId) {
  const rows = [];
  for (const [district, entry] of Object.entries(districtsData || {})) {
    const match = entry.builders.find((b) => b.id === builderId);
    if (match) rows.push({ district, count: match.count, projectCount: match.project_count });
  }
  return rows.sort((a, b) => b.count - a.count);
}

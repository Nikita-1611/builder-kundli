// Maps the extraction schema's relief_type vocabulary -- legal/schema
// language, e.g. "refund_of_consideration", "structural_defect_rectification"
// -- to plain-English categories a first-time flat buyer understands. This
// grouping and wording was decided by hand after checking what's actually in
// the data (see conversation), not derived automatically. Three categories
// were considered and dropped for having zero records anywhere in the
// current extractions: carpet area, amenities, and deed of conveyance.
export const CATEGORIES = [
  {
    id: "late-possession",
    reliefTypes: ["delay_interest", "possession_and_completion"],
    label: "Flat handed over late",
    explainer: "Buyers didn't get their flat on the promised date.",
  },
  {
    id: "refund",
    reliefTypes: ["refund_of_consideration"],
    label: "Money not returned",
    explainer: "Buyers wanted to walk away and get their money back.",
  },
  {
    id: "compensation",
    reliefTypes: ["compensation"],
    label: "Ordered to pay buyers",
    explainer: "MahaRERA said the builder owed buyers money for losses caused.",
  },
  {
    id: "defects",
    reliefTypes: ["structural_defect_rectification"],
    label: "Building problems",
    explainer: "Cracks, leaks or defects the builder was told to fix.",
  },
  {
    id: "paperwork",
    reliefTypes: ["agreement_for_sale_execution"],
    label: "Paperwork not done",
    explainer: "Builder took money but never signed the legal sale agreement.",
  },
  {
    id: "other",
    reliefTypes: ["cost", "other"],
    label: "Other",
    explainer: "Legal costs and miscellaneous directions.",
  },
];

// Plain-language description of what a granted relief actually ordered the
// builder to do, for when the order didn't state a settled amount to show
// instead (see formatAmount in lib/format.js) -- e.g. an order to sign an
// agreement has no rupee figure at all.
export const ORDERED_FALLBACK = {
  delay_interest: "Ordered to pay interest for the delay.",
  possession_and_completion: "Ordered to complete the project and hand over the flat.",
  refund_of_consideration: "Ordered to refund the buyer's money.",
  compensation: "Ordered to pay compensation.",
  structural_defect_rectification: "Ordered to fix the defects.",
  agreement_for_sale_execution: "Ordered to sign the sale agreement.",
  cost: "Ordered to pay costs.",
  other: "Ordered in the buyer's favor.",
};

const CATEGORY_BY_RELIEF_TYPE = new Map(
  CATEGORIES.flatMap((category) => category.reliefTypes.map((reliefType) => [reliefType, category])),
);

// Falls back to "Other" for any relief_type this table doesn't yet know
// about, rather than dropping it silently.
export function categoryForReliefType(reliefType) {
  return CATEGORY_BY_RELIEF_TYPE.get(reliefType) || CATEGORIES[CATEGORIES.length - 1];
}

export function findCategory(id) {
  return CATEGORIES.find((category) => category.id === id) || null;
}

// One row per category with at least one matching buyer, counting distinct
// buyers -- NOT relief entries, and not orders. Reads builder.categories,
// precomputed by scripts/build.py from queries/complaints_per_category.sql
// (COUNT(DISTINCT complaint_no), grouped by category, run once in SQL) --
// not recomputed from raw orders/reliefs here. lib/categoryGrouping.js's
// categoryFacts reads the exact same array, so the count on this bar
// always matches what categoryFacts shows after clicking it -- there's one
// number, not two calculations that happen to agree. See
// scripts/check-consistency.mjs, which still asserts this at build time,
// and ARCHITECTURE.md stage 4.5 for why the counting moved out of
// JavaScript in the first place.
export function summarizeCategories(builder) {
  const buyersById = new Map((builder?.categories || []).map((c) => [c.id, c.buyers]));
  return CATEGORIES.map((category) => ({ ...category, count: buyersById.get(category.id) || 0 })).filter(
    (category) => category.count > 0,
  );
}

// Compensation is something a ruling adds on top of a real complaint
// (delay, refund, a defect), not something a buyer complains about on its
// own -- almost every compensation relief in the data rides alongside a
// refund_of_consideration or delay_interest relief in the same order. So it
// stays a real category (for "what was ordered" wording, filters, etc.) but
// is excluded wherever a page lets someone browse "what buyers complained
// about" -- the report's category bars and this list of switcher chips.
export function summarizeComplaintCategories(builder) {
  return summarizeCategories(builder).filter((category) => category.id !== "compensation");
}

// The single most-represented category among a list of reliefs (e.g. one
// order's reliefs), by relief count. Ties go to whichever category comes
// first in CATEGORIES, the same tie-break summarizeCategories' ordering
// implies. Returns null for an empty list rather than a fake category.
export function dominantCategory(reliefs) {
  const counts = new Map();
  for (const relief of reliefs || []) {
    const category = categoryForReliefType(relief.relief_type);
    counts.set(category.id, (counts.get(category.id) || 0) + 1);
  }
  if (counts.size === 0) return null;
  return CATEGORIES.reduce(
    (best, category) => ((counts.get(category.id) || 0) > (counts.get(best?.id) || 0) ? category : best),
    null,
  );
}

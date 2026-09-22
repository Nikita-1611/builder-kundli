// Build-time guard against the exact bug this exists to prevent: the report
// page's category bars, the category-switch tabs, and a category detail
// page's header facts each showing a *different* buyer count for the same
// builder and category, because each screen re-derived the number its own
// way (some counting reliefs, some counting orders, some counting buyers).
//
// Since scripts/build.py started baking buyer counts into builder.categories
// (queries/complaints_per_category.sql, run once per builder in SQL --
// see ARCHITECTURE.md stage 4.5), lib/categories.js's summarizeCategories
// and lib/categoryGrouping.js's categoryFacts both just read that same
// array -- comparing them to each other would be near-tautological now.
// So this check does something more useful: it independently recounts
// buyers straight from the raw orders/reliefs data the JSON also carries
// (for the category detail page's narrative rendering), using its own
// from-scratch tally, and asserts it matches what the SQL query baked in.
// This is the one place a second, deliberately separate implementation of
// the count still exists -- specifically so it can catch the SQL pipeline
// and the raw data drifting apart.
//
// Usage:
//   node scripts/check-consistency.mjs
// Run as part of `npm run build` (see package.json), after sync-data so
// public/builders/ is current.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CATEGORIES, categoryForReliefType } from "../src/lib/categories.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILDERS_DIR = join(__dirname, "..", "public", "builders");

const files = readdirSync(BUILDERS_DIR).filter((f) => f.endsWith(".json") && f !== "index.json");
if (files.length === 0) {
  console.error(`No builder files found in ${BUILDERS_DIR} -- run npm run sync-data first.`);
  process.exit(1);
}

const failures = [];

for (const file of files) {
  const builder = JSON.parse(readFileSync(join(BUILDERS_DIR, file), "utf-8"));
  const precomputed = new Map((builder.categories || []).map((c) => [c.id, c.buyers]));

  // Deliberately independent recount, straight from builder.orders --
  // globally deduped by complaint_no across every order (not scoped
  // per-order -- that scoping bug is exactly what once caused this page
  // and the category page to disagree; see queries/schema.sql).
  const buyersByCategory = new Map();
  for (const order of builder.orders || []) {
    for (const relief of order.reliefs) {
      const category = categoryForReliefType(relief.relief_type);
      if (!buyersByCategory.has(category.id)) buyersByCategory.set(category.id, new Set());
      buyersByCategory.get(category.id).add(relief.complaint_no);
    }
  }

  for (const category of CATEGORIES) {
    const expected = buyersByCategory.get(category.id)?.size || 0;
    const actual = precomputed.get(category.id) || 0;
    if (expected !== actual) {
      failures.push(
        `${builder.builder_id}: category "${category.id}" -- SQL-precomputed builder.categories shows ${actual} ` +
          `buyers, an independent recount from builder.orders finds ${expected}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`Buyer-count consistency check FAILED (${failures.length} mismatch${failures.length === 1 ? "" : "es"}):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`Buyer-count consistency check passed: ${files.length} builders x ${CATEGORIES.length} categories, all agree.`);

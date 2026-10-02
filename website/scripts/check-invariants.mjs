// Site invariants -- structural sanity checks that fail the build if
// violated, on top of check-consistency.mjs's narrower buyer-count check.
// Read-only: reads public/builders/*.json and public/districts.json,
// changes nothing. See EVALS.md for what these are and why.
//
// 1. A builder with buyers_won > 0 must never have its "ordered to pay"
//    figure render as a bare "Rs0.00 cr" -- see ReportScreen.jsx's
//    OutcomeSection, fixed once already (a builder with 72 unstated
//    amounts and one Rs20,000 legal cost was rounding to Rs0.00 and
//    reading as "buyers got nothing"). The data shape that triggers this
//    (real but tiny stated amounts alongside many unstated ones) is
//    normal and not itself a bug -- OutcomeSection.jsx already guards it
//    with a text fallback. What this checks is that the guard is still
//    THERE: it confirms at least one builder's data currently exercises
//    that data shape (so the guard isn't dead code protecting against a
//    case that can't happen), then asserts OutcomeSection.jsx's source
//    still contains the fallback condition. A script here can't render
//    React, so this is a source-text assertion, not a rendered-output
//    one -- someone could still edit the fallback text without breaking
//    this check, but removing the underlying guard logic will fail it.
// 2. A district's project count for a builder can never exceed that
//    builder's own total project_count, and the distinct projects across
//    every district that builder appears in must equal it exactly. This
//    is a union, not a sum: the register can list the same project under
//    two benches (Nirmal Lifestyle's P51800004719 has warrants in both
//    Mumbai Suburban and Thane), so per-district counts can legitimately
//    add up to more than the total.
// 3. Warrant counts must agree wherever they're shown: the sum of a
//    builder's warrant count across every district in districts.json
//    must equal that builder's own warrant_count in builders/*.json.
//
// Usage:
//   node scripts/check-invariants.mjs

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILDERS_DIR = join(__dirname, "..", "public", "builders");
const DISTRICTS_PATH = join(__dirname, "..", "public", "districts.json");

function formatCr(amountRupees) {
  return `₹${(amountRupees / 1e7).toFixed(2)} cr`;
}

function sumOrderedAmount(orders) {
  let total = 0;
  for (const order of orders || []) {
    for (const relief of order.reliefs) {
      if (relief.granted && relief.amount?.value != null) total += relief.amount.value;
    }
  }
  return total;
}

const files = readdirSync(BUILDERS_DIR).filter((f) => f.endsWith(".json") && f !== "index.json");
if (files.length === 0) {
  console.error(`No builder files found in ${BUILDERS_DIR} -- run npm run sync-data first.`);
  process.exit(1);
}
const districtsData = JSON.parse(readFileSync(DISTRICTS_PATH, "utf-8")).districts;
const outcomeSectionSource = readFileSync(join(__dirname, "..", "src", "screens", "ReportScreen.jsx"), "utf-8");

const failures = [];
let sawZeroRoundingCase = false;

for (const file of files) {
  const builder = JSON.parse(readFileSync(join(BUILDERS_DIR, file), "utf-8"));
  const id = builder.builder_id;

  // 1. Note (don't fail) when a builder's data hits the "rounds to
  // Rs0.00" shape -- see the guard check after this loop, which fails if
  // OutcomeSection.jsx's fallback for exactly this shape has gone missing.
  const orderedAmount = sumOrderedAmount(builder.orders);
  if ((builder.buyers_won || 0) > 0 && orderedAmount > 0 && formatCr(orderedAmount) === "₹0.00 cr") {
    sawZeroRoundingCase = true;
  }

  // 2 + 3. district-level project/warrant counts vs the builder's own totals
  const districtProjects = new Set();
  let districtWarrantSum = 0;
  for (const entry of Object.values(districtsData)) {
    const match = entry.builders.find((b) => b.id === id);
    if (!match) continue;
    districtWarrantSum += match.count;
    for (const projectNo of match.project_nos || []) districtProjects.add(projectNo);
    if (match.project_count > builder.project_count) {
      failures.push(
        `${id}: a single district's project count (${match.project_count}) exceeds the builder's total project_count (${builder.project_count})`,
      );
    }
  }
  if (districtWarrantSum > 0 && districtProjects.size !== builder.project_count) {
    failures.push(
      `${id}: ${districtProjects.size} distinct projects across districts, builder's total project_count says ${builder.project_count}`,
    );
  }
  if (districtWarrantSum !== builder.warrant_count) {
    failures.push(
      `${id}: district warrant counts sum to ${districtWarrantSum}, builder.warrant_count says ${builder.warrant_count}`,
    );
  }
}

if (sawZeroRoundingCase && !outcomeSectionSource.includes('formatCr(orderedAmount) !== "₹0.00 cr"')) {
  failures.push(
    "OutcomeSection.jsx no longer guards the buyers-won-but-rounds-to-Rs0.00 case " +
      '(expected to find formatCr(orderedAmount) !== "₹0.00 cr" in ReportScreen.jsx) -- at least one builder\'s ' +
      "data currently hits that shape, so removing the guard would ship a misleading Rs0.00 figure again.",
  );
}

if (failures.length > 0) {
  console.error(`Site invariants FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(`Site invariants passed: ${files.length} builders checked.`);

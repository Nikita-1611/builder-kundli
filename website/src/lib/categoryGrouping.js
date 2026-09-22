import { ORDERED_FALLBACK, categoryForReliefType } from "./categories.js";
import { classifyDenial, OUTCOME_LABEL } from "./denial.js";

// One buyer's (complaint_no's) reliefs across every order that mentions
// them -- the unit "same ruling" grouping, and every buyer count on the
// site, works on. A single order can bundle many buyers (a MahaRERA
// "common order" covering a whole project); the reverse is also true and
// easy to miss -- a single buyer's complaint can show up in more than one
// order PDF (a final order, then a later non-execution application filed
// as its own order). The dedupe map below is keyed by complaint_no across
// ALL orders passed in, not reset per order, specifically because of that:
// an earlier version scoped the map inside the orders loop, so a buyer
// present in N orders counted as N separate cases -- e.g. JVPD's refund
// category showed 61 buyers on the report page but 157 "cases" here, since
// 43 of those 61 buyers' refund reliefs span more than one order. That's
// the bug scripts/check-consistency.mjs now guards against.
// reliefTypes is optional -- omit it (as builderBuyerStats does) to group
// every relief regardless of category, for a builder-wide buyer count.
function buildCases(orders, reliefTypes) {
  const byComplaint = new Map();
  for (const order of orders || []) {
    for (const relief of order.reliefs) {
      if (reliefTypes && !reliefTypes.has(relief.relief_type)) continue;
      const key = relief.complaint_no;
      if (!byComplaint.has(key)) {
        byComplaint.set(key, {
          complaintNo: relief.complaint_no,
          complainantNames: relief.complainant_names,
          orderIds: new Set(),
          orderDate: order.order_date,
          projectName: order.project_name,
          projectRegNo: order.project_reg_no,
          reliefs: [],
        });
      }
      const c = byComplaint.get(key);
      c.orderIds.add(order.order_id);
      // Most recent proceeding for this buyer, when their case spans more
      // than one order -- ISO date strings sort correctly as text.
      if (order.order_date && (!c.orderDate || order.order_date > c.orderDate)) c.orderDate = order.order_date;
      c.reliefs.push(relief);
    }
  }
  return [...byComplaint.values()].map((c) => ({ ...c, orderIds: [...c.orderIds] }));
}

// What makes two buyers' cases "the same ruling": the same relief types,
// the same granted/denied split, and the same interest-rate/amount-type
// pattern -- deliberately NOT the exact rupee amount or the reasoning
// text, since those are buyer-specific even in a common order (the amount
// differs per flat, and the reasoning paragraph usually repeats the same
// template with that buyer's flat number swapped in). Two buyers in the
// same bulk order who both got "refund + 10.25% interest" are the same
// ruling even though their amounts differ.
// Interest rate descriptions are free-text from the LLM extraction, so the
// same 10.25% rate shows up as "10.25% p.a.", "10.25% per annum", "10.25%
// p.a. from the date/s of their payment till they are refunded." and more
// -- all the same ruling, worded differently order to order. Pull out just
// the number so those don't fragment into separate ruling groups; fall
// back to the raw (lowercased) text for the rare description with no
// extractable percentage (e.g. "as prescribed under Rule 18 of ..."),
// which is genuinely a different, non-numeric ruling.
function normalizedRate(description) {
  if (!description) return "";
  const match = description.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? `${match[1]}%` : description.trim().toLowerCase();
}

function rulingSignature(reliefs) {
  return reliefs
    .map((relief) => [relief.relief_type, relief.granted, normalizedRate(relief.amount?.interest_rate_description), relief.amount?.type || ""].join(":"))
    .sort()
    .join("|");
}

function caseHasWarrant(c) {
  return c.reliefs.some((relief) => relief.has_warrant);
}

function caseWon(c) {
  return c.reliefs.some((relief) => relief.granted);
}

function distinctBy(list, keyFn) {
  const seen = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

// Everything a ruling card needs to render: who won, what was granted and
// denied (plain-language, deduped by relief_type), a representative
// reasoning line, and -- for a granted ruling -- how many of the buyers it
// covers have an actual recovery warrant against them.
export function summarizeRuling(group) {
  const reliefs = group.reliefs;
  const granted = reliefs.filter((relief) => relief.granted);
  const denied = reliefs.filter((relief) => !relief.granted);

  // Dedupe by the label actually shown, not relief_type -- different
  // relief_types can share the same display label (e.g. via
  // categoryForReliefType's grouping), and deduping on relief_type first
  // would let two of those through as identical-looking duplicate lines.
  const orderedItems = distinctBy(
    granted.map((relief) => ORDERED_FALLBACK[relief.relief_type] || "Ordered in the buyer's favor."),
    (label) => label,
  );
  const deniedItems = distinctBy(
    denied.map((relief) => {
      const outcome = classifyDenial(relief.reasoning);
      return `${categoryForReliefType(relief.relief_type).label} — ${OUTCOME_LABEL[outcome.bucket]}`;
    }),
    (label) => label,
  );

  let whoWon;
  if (granted.length > 0 && denied.length === 0) whoWon = "Buyer";
  else if (denied.length > 0 && granted.length === 0) {
    const buckets = denied.map((relief) => classifyDenial(relief.reasoning).bucket);
    whoWon = buckets.every((bucket) => bucket === "decided-against-buyer") ? "Builder" : "Not decided";
  } else whoWon = "Partly";

  const wonCases = group.cases.filter(caseWon);
  const warrantCount = wonCases.filter(caseHasWarrant).length;

  return {
    whoWon,
    orderedItems,
    deniedItems,
    reasoning: group.cases[0]?.reliefs[0]?.reasoning,
    orderIds: [...new Set(group.cases.flatMap((c) => c.orderIds))],
    warrantEligible: wonCases.length,
    warrantCount,
    buyerCount: group.cases.length,
  };
}

// Complaints for this category, grouped by project, and within each
// project grouped by ruling (see rulingSignature above). A project with
// one ruling signature across all its buyers renders as "same ruling for
// many buyers"; a project with more than one renders as a list of
// distinct rulings a visitor can open one at a time. Sorted so the
// project/ruling with the most buyers leads.
export function groupCategoryCases(builder, category) {
  const reliefTypes = new Set(category.reliefTypes);
  const cases = buildCases(builder.orders, reliefTypes);

  const byProject = new Map();
  for (const c of cases) {
    const key = c.projectRegNo || c.projectName || "unknown-project";
    if (!byProject.has(key)) {
      byProject.set(key, { projectRegNo: c.projectRegNo, projectName: c.projectName, cases: [] });
    }
    byProject.get(key).cases.push(c);
  }

  const projects = [...byProject.values()].map((project) => {
    const bySignature = new Map();
    for (const c of project.cases) {
      const sig = rulingSignature(c.reliefs);
      if (!bySignature.has(sig)) bySignature.set(sig, { signature: sig, reliefs: c.reliefs, cases: [] });
      bySignature.get(sig).cases.push(c);
    }
    const rulings = [...bySignature.values()]
      .sort((a, b) => b.cases.length - a.cases.length)
      .map((group) => ({ ...group, summary: summarizeRuling(group) }));
    return { ...project, rulings, caseCount: project.cases.length };
  });

  return projects.sort((a, b) => b.caseCount - a.caseCount);
}

// Header fact row: distinct buyers, projects, "won" count, and how many of
// those buyers already have a recovery warrant on record. Reads
// builder.categories, precomputed by scripts/build.py from
// queries/complaints_per_category.sql -- not recomputed here. That query
// counts the exact same way (COUNT(DISTINCT complaint_no) per category) as
// lib/categories.js's summarizeCategories, which reads the same array, so
// this always matches the category bar/tab that led here -- they're
// reading one shared number, not running two calculations that happen to
// agree. See ARCHITECTURE.md, stage 4.5, for why this moved out of a
// buildCases-based JS aggregation (a per-order-scoped dedupe bug here is
// exactly what caused the report and category pages to disagree once).
export function categoryFacts(builder, category) {
  const entry = (builder.categories || []).find((c) => c.id === category.id);
  return {
    buyers: entry?.buyers || 0,
    projects: entry?.project_count || 0,
    buyersWon: entry?.buyers_won || 0,
    warrants: entry?.warranted_buyers || 0,
  };
}

// Builder-wide version of the same buyer count, across every category --
// reads builder.total_buyers/buyers_won/warranted_buyers, precomputed by
// scripts/build.py from queries/buyers_won_per_builder.sql. VerdictCard's
// fact row, the headline, and the "Buyer won X of Y" outcome box on
// ReportScreen.jsx all call this, so they read the same three numbers
// instead of each re-deriving their own.
export function builderBuyerStats(builder) {
  return {
    totalBuyers: builder.total_buyers || 0,
    buyersWon: builder.buyers_won || 0,
    // Distinct from builder.warrant_count: that's a row count straight from
    // MahaRERA's warrant list (raw/warrants.json); this is how many of the
    // buyers who won something in an order we read also carry that list's
    // has_warrant flag. Related, not interchangeable -- keep them labeled
    // separately wherever both appear (see ReportScreen.jsx).
    warrantedBuyers: builder.warranted_buyers || 0,
  };
}

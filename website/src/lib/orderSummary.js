import { dominantCategory } from "./categories";
import { classifyDenial } from "./denial";

// Short verb phrase for what a granted relief actually got the buyer, used
// in an order's one-line outcome ("Buyer won · refund ordered"). Never a
// specific rupee figure here -- an order can bundle many buyers with
// different amounts, so this is deliberately the generic action, not one
// buyer's number standing in for all of them.
const GRANTED_VERB = {
  delay_interest: "interest ordered",
  possession_and_completion: "possession ordered",
  refund_of_consideration: "refund ordered",
  compensation: "compensation ordered",
  structural_defect_rectification: "repairs ordered",
  agreement_for_sale_execution: "agreement ordered",
  cost: "costs ordered",
  other: "ordered in buyer's favor",
};

function dominantGrantedVerb(grantedReliefs) {
  const category = dominantCategory(grantedReliefs);
  if (!category) return "ordered in buyer's favor";
  // dominantCategory groups by plain-English category; recover a relief_type
  // within it to look up the specific verb phrase.
  const reliefType = grantedReliefs.find((relief) => category.reliefTypes.includes(relief.relief_type))?.relief_type;
  return GRANTED_VERB[reliefType] || "ordered in buyer's favor";
}

// One line describing what happened in an order that had at least one
// denied (never granted) relief and nothing granted -- "Builder won" only
// when every denial was an actual merit-based loss for the buyer, not a
// procedural non-decision.
function deniedOutcome(deniedReliefs) {
  const buckets = deniedReliefs.map((relief) => classifyDenial(relief.reasoning).bucket);
  if (buckets.every((bucket) => bucket === "decided-against-buyer")) return "Builder won · dismissed";
  if (buckets.some((bucket) => bucket === "not-decided")) return "MahaRERA didn't rule on this";
  return "Case closed without a ruling";
}

// Everything the "Every order we read" row needs, computed once per order:
// the dominant complaint category, a single complaint-number label (or a
// count, when an order bundles several complainants), a one-line outcome,
// and the warrant tag. See ARCHITECTURE.md / schema.json for why one order
// can carry many reliefs across many buyers.
export function summarizeOrder(order) {
  const reliefs = order.reliefs || [];
  const granted = reliefs.filter((relief) => relief.granted);
  const denied = reliefs.filter((relief) => !relief.granted);
  const hasWarrant = reliefs.some((relief) => relief.has_warrant);
  const distinctComplaints = new Set(reliefs.map((relief) => relief.complaint_no));

  const category = dominantCategory(reliefs);

  let outcome;
  if (granted.length > 0 && denied.length === 0) {
    outcome = `Buyer won · ${dominantGrantedVerb(granted)}`;
  } else if (granted.length > 0 && denied.length > 0) {
    outcome = "Partly allowed";
  } else {
    outcome = deniedOutcome(denied);
  }

  const tag = hasWarrant
    ? { label: "Warrant issued", tone: "red" }
    : granted.length > 0
      ? { label: "No warrant", tone: "green" }
      : { label: "—", tone: "grey" };

  return {
    categoryLabel: category ? category.label : "Uncategorized",
    complaintLabel: distinctComplaints.size === 1 ? [...distinctComplaints][0] : `${distinctComplaints.size} complaints`,
    outcome,
    tag,
    granted,
    denied,
  };
}

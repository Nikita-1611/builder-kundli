// A denied relief was never necessarily a merit-based loss for the buyer --
// most weren't. MahaRERA either never ruled on it (too early, outside its
// powers, or paused by an insolvency court), the case closed without a
// ruling (conciliation, or the buyer stopped showing up), or it genuinely
// went against the buyer on the facts. Classified from the reasoning prose
// since extraction doesn't carry a structured field for this. Order
// matters: "premature" cases also say "not maintainable", so premature is
// checked before the generic jurisdiction/not-maintainable catch-all.
// Shared by CategoryScreen and ReportScreen so a denial reads the same way
// in both places.
export function classifyDenial(reasoning) {
  const text = (reasoning || "").toLowerCase();
  if (text.includes("nclt")) {
    return { bucket: "not-decided", why: "Paused — an insolvency court has this case on hold." };
  }
  if (text.includes("premature")) {
    return { bucket: "not-decided", why: "Too early — the deadline in question hadn't passed yet." };
  }
  if (text.includes("jurisdiction") || text.includes("not maintainable")) {
    return { bucket: "not-decided", why: "Outside MahaRERA's powers to decide." };
  }
  if (text.includes("settl") || text.includes("conciliat") || text.includes("absen") || text.includes("prosecution")) {
    return { bucket: "settled" };
  }
  return { bucket: "decided-against-buyer" };
}

export const OUTCOME_LABEL = {
  "not-decided": "MahaRERA didn't rule on this",
  settled: "Case closed without a ruling",
  "decided-against-buyer": "MahaRERA ruled for the builder",
};

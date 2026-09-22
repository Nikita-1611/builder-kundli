// Shared by ReportScreen's VerdictCard and LandingScreen's HeroPreviewCard
// so the two headlines can never say different things about the same
// builder. Short, number-first headline + (when there's a warrant) one
// small explanatory line -- no em dashes in either, and the subline never
// claims every warrant is a buyer's money: some recovery warrants are
// penalties owed directly to MahaRERA, not to a buyer (see conversation).
export function verdictHeadline(builder) {
  if (builder.warrant_count > 0) {
    return `${builder.warrant_count} unpaid RERA order${builder.warrant_count === 1 ? "" : "s"}.`;
  }
  const buyersNoWarrant = builder.buyers_won_no_warrant || 0;
  if (buyersNoWarrant > 0) {
    return `${buyersNoWarrant} buyer${buyersNoWarrant === 1 ? "" : "s"} won something, with no recovery warrant issued yet.`;
  }
  return "No adverse orders or recovery warrants on record.";
}

export function verdictSubline(builder) {
  if (builder.warrant_count > 0) {
    return "MahaRERA ruled against this builder and issued recovery warrants when it didn't pay.";
  }
  return null;
}

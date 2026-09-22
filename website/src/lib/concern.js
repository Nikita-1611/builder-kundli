// Shared concern-level bands, derived from the display score (0-10) --
// the same bands ReportScreen's scoreLabel used before this got pulled out
// so the landing page's table/chips and the report page can agree on what
// "Some concerns" means. "Adverse record" was dropped -- it read as an
// accusation even for a builder with one old, minor signal.
export const CONCERN_LEVELS = [
  { id: "clean", label: "Clean record", color: "var(--concern-clean)" },
  { id: "minor", label: "Minor concerns", color: "var(--concern-minor)" },
  { id: "some", label: "Some concerns", color: "var(--concern-some)" },
  { id: "significant", label: "Significant concerns", color: "var(--concern-significant)" },
];

export function concernLevel(score) {
  if (score === 0) return CONCERN_LEVELS[0];
  if (score < 3) return CONCERN_LEVELS[1];
  if (score <= 6) return CONCERN_LEVELS[2];
  return CONCERN_LEVELS[3];
}

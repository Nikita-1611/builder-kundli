// Mirrors the real scoring formula in scripts/score.py and scripts/build.py
// (stages 4-5 of the pipeline) so "How we calculated this" shows the exact
// constants the pipeline used, not a paraphrase. Kept in sync by hand --
// there are only two numbers and one small formula, see ARCHITECTURE.md.
export const POINTS_RECOVERY_WARRANT = 30;
export const POINTS_ADVERSE_ORDER_NO_WARRANT = 10;
export const HALF_LIFE_YEARS = 3;
export const PROJECT_COUNT_LOG_WEIGHT = 0.08;
export const SCORE_SCALE = 600;

// raw_points -> the 0-10 display score, run through a saturating curve
// (1 - e^-x) so scores spread out instead of clustering at the top, with a
// small log-scaled bonus for spread across more projects (not a divisor --
// see build.py's comment on why dividing by project count got the ranking
// backwards).
export function adjustedPoints(rawPoints, projectCount) {
  if (!projectCount) return rawPoints;
  return rawPoints * (1 + PROJECT_COUNT_LOG_WEIGHT * Math.log(projectCount));
}

export function scoreFromPoints(rawPoints, projectCount) {
  const adjusted = adjustedPoints(rawPoints, projectCount);
  return Math.round(10 * (1 - Math.exp(-adjusted / SCORE_SCALE)) * 10) / 10;
}

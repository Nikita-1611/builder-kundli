// Choropleth shading for the district map. 5 shades total: "none" for a
// district with zero scraped warrants, plus 4 steps interpolated evenly
// from #F1F0EC to #A8432A for districts that have some. Bucketed rather
// than a continuous scale because the real counts are extremely skewed
// (1 warrant in Chandrapur vs. 709 in Mumbai) -- a linear scale would
// leave everything except Mumbai looking blank.
const NONE_COLOR = "#F1F0EC";
const MOST_COLOR = "#A8432A";

function interpolate(t) {
  const from = [0xf1, 0xf0, 0xec];
  const to = [0xa8, 0x43, 0x2a];
  const rgb = from.map((c, i) => Math.round(c + (to[i] - from[i]) * t));
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export const DISTRICT_SHADES = [
  { id: "none", label: "No warrants scraped yet", min: 0, max: 0, color: NONE_COLOR },
  { id: "low", label: "1–10", min: 1, max: 10, color: interpolate(0.25) },
  { id: "mid", label: "11–50", min: 11, max: 50, color: interpolate(0.5) },
  { id: "high", label: "51–150", min: 51, max: 150, color: interpolate(0.75) },
  { id: "most", label: "150+", min: 151, max: Infinity, color: MOST_COLOR },
];

export function shadeForCount(count) {
  if (!count) return DISTRICT_SHADES[0];
  return DISTRICT_SHADES.find((band) => count >= band.min && count <= band.max) || DISTRICT_SHADES[DISTRICT_SHADES.length - 1];
}

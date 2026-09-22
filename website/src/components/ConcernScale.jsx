import { concernLevel, CONCERN_LEVELS } from "../lib/concern";
import "./ConcernScale.css";

// The four-band gradient bar used to show where a score (0-10) falls.
// `variant="full"` (hero/report use) draws the legend labels underneath;
// `variant="compact"` (table rows) draws just the bar, dot and level label,
// sized for a table cell. Both read the same band boundaries from
// lib/concern.js so a builder never shows a different level in two places.
export default function ConcernScale({ score, variant = "full" }) {
  const level = concernLevel(score);
  const position = `${Math.min(100, Math.max(0, (score / 10) * 100))}%`;

  return (
    <div className={`concern-scale concern-scale--${variant}`}>
      <div className="concern-scale__track">
        <div className="concern-scale__marker" style={{ left: position }} />
      </div>
      {variant === "full" ? (
        <div className="concern-scale__legend">
          {CONCERN_LEVELS.map((band) => (
            <span key={band.id}>{band.label}</span>
          ))}
        </div>
      ) : (
        <span className="concern-scale__label">
          <span className="concern-scale__dot" style={{ background: level.color }} />
          {level.label}
        </span>
      )}
    </div>
  );
}

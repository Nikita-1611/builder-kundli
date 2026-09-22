import DISTRICTS from "../data/maharashtraDistricts.json";
import { shadeForCount } from "../lib/districtShade";
import "./MaharashtraMap.css";

// Pure SVG choropleth -- one <path> per district, traced in
// design/maharashtra-map.svg. Fill comes from the real per-district
// warrant count (see lib/districtShade.js); everything else about the
// path (id, shape) is copied from that design file as-is.
export default function MaharashtraMap({ data, selected, onSelect }) {
  return (
    <svg viewBox="0 0 820 676" className="mh-map" role="img" aria-label="Warrant count by Maharashtra district">
      {DISTRICTS.map((district) => {
        const entry = data[district.name];
        const count = entry ? entry.count : 0;
        const shade = shadeForCount(count);
        const isSelected = selected === district.name;
        return (
          <path
            key={district.id}
            d={district.d}
            data-district={district.name}
            fill={shade.color}
            stroke={isSelected ? "#1a1a1a" : "#ffffff"}
            strokeWidth={isSelected ? 2.2 : 1.2}
            className="mh-map__district"
            role="button"
            tabIndex={0}
            aria-pressed={isSelected}
            onClick={() => onSelect(district.name)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(district.name);
              }
            }}
          >
            <title>
              {district.name}: {count} warrant{count === 1 ? "" : "s"}
            </title>
          </path>
        );
      })}
      {DISTRICTS.filter((district) => data[district.name]).map((district) => {
        const entry = data[district.name];
        const shade = shadeForCount(entry.count);
        return (
          <text
            key={`${district.id}-label`}
            x={district.cx}
            y={district.cy}
            className="mh-map__label"
            fill={shade.id === "most" || shade.id === "high" ? "#ffffff" : "#1a1a1a"}
          >
            {entry.count}
          </text>
        );
      })}
    </svg>
  );
}

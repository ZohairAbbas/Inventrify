import { toPolyline, type Series } from "../lib/sparklines";

interface Props {
  series: Series | null;
  color: string;
  width?: number;
  height?: number;
}

/**
 * Trend line for a KPI card.
 *
 * Renders nothing when `series` is null — a shop without enough history gets a card with
 * no chart rather than a flat line implying a fortnight of no activity. Callers should
 * reserve no space for it: the KPI cards let the value row collapse rather than leaving a
 * gap where a chart would be.
 *
 * `preserveAspectRatio="none"` deliberately stretches the viewBox to the given box: these
 * are shape-only, and the vertical exaggeration is what makes a 3% move legible at 20px
 * tall. Anything where the true gradient matters belongs in a real chart.
 */
export function Sparkline({ series, color, width = 62, height = 20 }: Props) {
  if (!series || series.points.length === 0) return null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width={width}
      height={height}
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <polyline
        points={toPolyline(series.points, width, height)}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

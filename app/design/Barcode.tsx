import { encodeCode128 } from "../lib/barcode";

interface Props {
  value: string;
  /** Width of one narrow bar, in px. Larger = easier to scan, wider label. */
  moduleWidth?: number;
  height?: number;
  /** Print the human-readable value under the bars (standard for retail labels). */
  showText?: boolean;
  fontSize?: number;
}

/**
 * A scannable Code 128 barcode, rendered as inline SVG.
 *
 * Uses the same pure encoder as the print path, so what a merchant sees on screen is
 * exactly what prints. Renders nothing for a value the symbology cannot represent (empty,
 * or non-ASCII) rather than a broken barcode — the caller decides what to show instead.
 *
 * The 10-module quiet zone on each side is not optional decoration: scanners need the
 * clear margin, and bars printed flush against other content frequently will not read.
 */
export function Barcode({
  value,
  moduleWidth = 2,
  height = 56,
  showText = true,
  fontSize = 12,
}: Props) {
  const encoded = encodeCode128(value);
  if (!encoded) return null;

  const quiet = 10;
  const totalWidth = (encoded.totalModules + quiet * 2) * moduleWidth;

  const rects: { x: number; w: number }[] = [];
  let x = quiet * moduleWidth;
  let isBar = true;
  for (const w of encoded.modules) {
    const width = w * moduleWidth;
    if (isBar) rects.push({ x, w: width });
    x += width;
    isBar = !isBar;
  }

  return (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: showText ? "3px" : 0 }}>
      <svg
        width={totalWidth}
        height={height}
        viewBox={`0 0 ${totalWidth} ${height}`}
        shapeRendering="crispEdges"
        style={{ display: "block", background: "#fff" }}
        role="img"
        aria-label={`Barcode ${value}`}
      >
        {rects.map((r, i) => (
          <rect key={i} x={r.x} y={0} width={r.w} height={height} fill="#000" />
        ))}
      </svg>
      {showText && (
        <span
          style={{
            fontFamily: "var(--inv-font-mono)",
            fontSize: `${fontSize}px`,
            letterSpacing: "1px",
            color: "#000",
          }}
        >
          {value}
        </span>
      )}
    </div>
  );
}

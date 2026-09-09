import type { ReactNode } from "react";

export interface PipelineSegment {
  key: string;
  label: string;
  units: number;
  /** Text/figure colour for the tile. */
  fg: string;
  /** Tile background and border. */
  bg: string;
  border: string;
  /** Colour of this segment in the stacked bar. */
  bar: string;
  /** Small caption under the figure, e.g. a rate. */
  note?: string;
  /** Makes the tile a button. */
  onClick?: () => void;
}

interface Props {
  title: string;
  subtitle: string;
  /** Right-hand side of the header: a total figure, or a link button. */
  headerRight?: ReactNode;
  badge?: string;
  segments: readonly PipelineSegment[];
  footnote?: ReactNode;
}

/**
 * Fulfilment card: a row of stage tiles over a stacked proportion bar.
 *
 * Used twice on the dashboard — once for units still in route, once for how resolved
 * shipments ended up. One component rather than two because the only real difference is
 * which stages are passed in, and having a single implementation is what keeps the two
 * cards reading as halves of one picture rather than as two designs that drifted.
 *
 * The bar is proportional to the segments given, so callers must pass every stage that
 * makes up the whole. Omitting one silently rescales the rest.
 */
export function PipelineCard({
  title,
  subtitle,
  headerRight,
  badge,
  segments,
  footnote,
}: Props) {
  const total = segments.reduce((sum, s) => sum + s.units, 0);

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid var(--inv-border)",
        borderRadius: "var(--inv-radius-card)",
        padding: "17px 19px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          marginBottom: "14px",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "14.5px",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            {title}
            {badge && (
              <span
                style={{
                  fontSize: "9.5px",
                  fontWeight: 600,
                  letterSpacing: ".3px",
                  color: "var(--inv-transit-fg)",
                  background: "#e9ecfa",
                  padding: "2px 8px",
                  borderRadius: "var(--inv-radius-pill)",
                }}
              >
                {badge}
              </span>
            )}
          </div>
          <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginTop: "3px" }}>
            {subtitle}
          </div>
        </div>
        {headerRight}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(92px,1fr))",
          gap: "10px",
          marginBottom: "13px",
        }}
      >
        {segments.map((s) => {
          const content = (
            <>
              <div
                style={{
                  fontSize: "10.5px",
                  color: s.fg,
                  fontWeight: 600,
                  marginBottom: "6px",
                }}
              >
                {s.label}
              </div>
              <div
                style={{
                  fontFamily: "var(--inv-font-mono)",
                  fontSize: "19px",
                  fontWeight: 600,
                  color: s.units > 0 ? s.fg : "var(--inv-faint)",
                }}
              >
                {s.units.toLocaleString()}
              </div>
              {s.note && (
                <div style={{ fontSize: "10.5px", color: "var(--inv-text-2)", marginTop: "4px" }}>
                  {s.note}
                </div>
              )}
            </>
          );

          const style = {
            background: s.bg,
            border: `1px solid ${s.border}`,
            borderRadius: "11px",
            padding: "11px 12px",
            textAlign: "left" as const,
          };

          return s.onClick ? (
            <button key={s.key} type="button" onClick={s.onClick} style={{ ...style, font: "inherit", cursor: "pointer" }}>
              {content}
            </button>
          ) : (
            <div key={s.key} style={style}>
              {content}
            </div>
          );
        })}
      </div>

      {/*
        Zero-width segments are dropped rather than clamped to a visible minimum. Giving a
        stage with no units a sliver of bar invents a category that is not there — and a
        merchant with no damaged stock should see no damage in the bar at all.
      */}
      <div
        style={{
          display: "flex",
          height: "8px",
          borderRadius: "5px",
          overflow: "hidden",
          background: "#f0eee7",
        }}
      >
        {total > 0 &&
          segments
            .filter((s) => s.units > 0)
            .map((s) => (
              <div
                key={s.key}
                title={`${s.label}: ${s.units.toLocaleString()}`}
                style={{ width: `${(s.units / total) * 100}%`, background: s.bar }}
              />
            ))}
      </div>

      {footnote && (
        <div style={{ fontSize: "11px", color: "#8b877d", marginTop: "9px", lineHeight: 1.5 }}>
          {footnote}
        </div>
      )}
    </div>
  );
}

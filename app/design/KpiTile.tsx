import type { ReactNode } from "react";
import { Sparkline } from "./Sparkline";
import type { Series } from "../lib/sparklines";

interface Props {
  label: string;
  value: string | number;
  /** Caption under the value — a delta, a secondary figure, or a qualifier. */
  sub?: ReactNode;
  /** Colour for the value and, unless `sparkColor` overrides it, the trend line. */
  valueColor?: string;
  subColor?: string;
  /** Left edge bar, for the one card that should pull the eye first. */
  accentBar?: string;
  series?: Series | null;
  sparkColor?: string;
  /**
   * Values that run long (currency totals) get a smaller size so they stay on one line.
   * Counts keep the display size.
   */
  size?: "count" | "currency";
}

/**
 * Dashboard KPI card: label, figure, caption, and an optional trend line to its right.
 *
 * Distinct from `KpiCard`, which the rest of the app uses and which has no chart. Kept
 * separate rather than extended so the twenty other routes rendering KpiCard are not
 * touched by dashboard-only layout changes.
 */
export function KpiTile({
  label,
  value,
  sub,
  valueColor,
  subColor,
  accentBar,
  series,
  sparkColor,
  size = "count",
}: Props) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid var(--inv-border)",
        borderRadius: "14px",
        padding: "15px 16px",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {accentBar && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: "3px",
            background: accentBar,
          }}
        />
      )}

      <div style={{ fontSize: "11.5px", color: "#8b877d", marginBottom: "9px" }}>{label}</div>

      <div
        style={{
          fontFamily: "var(--inv-font-mono)",
          fontSize: size === "currency" ? "19px" : "26px",
          fontWeight: 600,
          letterSpacing: size === "currency" ? "-.6px" : "-1px",
          lineHeight: size === "currency" ? 1.15 : 1,
          color: valueColor ?? "var(--inv-ink)",
        }}
      >
        {value}
      </div>

      {/*
        The caption and the chart share a row. When the series is null the Sparkline
        renders nothing and the caption simply occupies the full width — no reserved gap,
        so a card without history reads as complete rather than as one that failed to load.
      */}
      {(sub || series) && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: "8px",
            marginTop: "10px",
          }}
        >
          <span style={{ fontSize: "11.5px", color: subColor ?? "var(--inv-text-2)", minWidth: 0 }}>
            {sub}
          </span>
          <Sparkline series={series ?? null} color={sparkColor ?? valueColor ?? "#8b877d"} />
        </div>
      )}
    </div>
  );
}

import { useState, type ReactNode } from "react";
import { Segmented } from "./Segmented";

export interface StockBucket {
  key: string;
  label: string;
  units: number;
  /** Value of these units at cost. */
  cost: number;
  /** One line on what the bucket means, or a figure that qualifies it. */
  note: string;
  color: string;
}

interface Props {
  buckets: readonly StockBucket[];
  formatMoney: (n: number) => string;
  /** Under the header, e.g. a coverage caveat. */
  footnote?: ReactNode;
}

type Basis = "units" | "value";

/**
 * "Where your stock is": every unit the merchant owns or has ordered, split by where it
 * is right now, as one proportional bar over a legend of figures.
 *
 * The buckets must not overlap — each unit belongs to exactly one — or the bar's shares
 * stop meaning anything. Callers own that invariant; see the dashboard loader.
 */
export function StockPositionCard({ buckets, formatMoney, footnote }: Props) {
  const [basis, setBasis] = useState<Basis>("units");
  const totalUnits = buckets.reduce((s, b) => s + b.units, 0);
  const totalCost = buckets.reduce((s, b) => s + b.cost, 0);
  const denom = basis === "units" ? totalUnits : totalCost;

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid var(--inv-border)",
        borderRadius: "var(--inv-radius-card-lg)",
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
        <div>
          <div style={{ fontSize: "15px", fontWeight: 600 }}>Where your stock is</div>
          <div style={{ fontSize: "12px", color: "var(--inv-text-2)", marginTop: "3px" }}>
            Every unit you own or have ordered, by where it is right now
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "18px", fontWeight: 600, letterSpacing: "-.4px" }}>
              {basis === "units" ? `${totalUnits.toLocaleString("en-US")} units` : formatMoney(totalCost)}
            </div>
            <div style={{ fontSize: "11px", color: "var(--inv-muted)" }}>
              {basis === "units" ? `${formatMoney(totalCost)} at cost` : `${totalUnits.toLocaleString("en-US")} units`}
            </div>
          </div>
          <Segmented
            label="Measure stock by"
            tone="sunken"
            value={basis}
            onChange={setBasis}
            options={[
              { value: "units", label: "Units" },
              { value: "value", label: "Value" },
            ]}
          />
        </div>
      </div>

      <div
        role="img"
        aria-label={buckets.map((b) => `${b.label} ${b.units} units`).join(", ")}
        style={{ display: "flex", height: "16px", borderRadius: "8px", overflow: "hidden", background: "var(--inv-divider-3)", gap: "2px" }}
      >
        {denom > 0 &&
          buckets.map((b) => {
            const share = (basis === "units" ? b.units : b.cost) / denom;
            if (share <= 0) return null;
            return (
              <div
                key={b.key}
                title={b.label}
                style={{ flex: "none", width: `${(share * 100).toFixed(2)}%`, minWidth: "3px", background: b.color }}
              />
            );
          })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px" }}>
        {buckets.map((b) => (
          <div
            key={b.key}
            style={{
              border: "1px solid var(--inv-divider)",
              borderRadius: "12px",
              padding: "11px 12px",
              background: "var(--inv-subtle)",
              display: "flex",
              flexDirection: "column",
              gap: "4px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12px", fontWeight: 600 }}>
              <span style={{ width: "9px", height: "9px", borderRadius: "3px", flex: "none", background: b.color }} />
              {b.label}
            </div>
            <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "19px", fontWeight: 600, letterSpacing: "-.4px" }}>
              {b.units.toLocaleString("en-US")} <span style={{ fontSize: "11px", fontWeight: 500, color: "var(--inv-muted)" }}>units</span>
            </div>
            <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "11.5px", color: "var(--inv-text-2)" }}>
              {formatMoney(b.cost)} at cost
            </div>
            <div style={{ fontSize: "11px", color: "var(--inv-text-2)", lineHeight: 1.4 }}>{b.note}</div>
          </div>
        ))}
      </div>

      {footnote && <div style={{ fontSize: "11.5px", color: "var(--inv-text-2)" }}>{footnote}</div>}
    </div>
  );
}

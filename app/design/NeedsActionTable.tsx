import type { ReactNode } from "react";
import { Link } from "@remix-run/react";
import { statusMeta, type StockStatus } from "./StatusBadge";

export interface NeedsActionRow {
  productId: string;
  title: string;
  sku: string | null;
  stock: number;
  /** Days of cover left; null when the SKU has no demand and therefore no runway. */
  daysRemaining: number | null;
  suggestedQty: number;
  status: StockStatus;
  /** Pre-formatted currency, or null when no alert has priced this SKU's exposure. */
  riskLabel: string | null;
  createPoHref: string;
}

interface Props {
  rows: readonly NeedsActionRow[];
  /** Rendered above the rows — the filter control. */
  filters: ReactNode;
  footer: ReactNode;
  /** Right-hand footer links. */
  actions: ReactNode;
}

const GRID =
  "minmax(0,2.4fr) minmax(52px,.8fr) minmax(52px,.8fr) minmax(74px,1fr) minmax(96px,1.05fr)";

/**
 * The dashboard's single work queue: what to reorder, how urgent, how much, and what it
 * is costing to leave alone.
 *
 * Replaces three separate panels — a reorder queue, an alerts list and a stock-status
 * table — which between them showed the same SKU up to three times in three different
 * orderings, and made "what should I do now" a question the merchant had to answer by
 * cross-referencing. One row per SKU, worst first.
 */
export function NeedsActionTable({ rows, filters, footer, actions }: Props) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid var(--inv-border)",
        borderRadius: "var(--inv-radius-card)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "16px 18px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "14px",
          flexWrap: "wrap",
          borderBottom: "1px solid var(--inv-divider)",
        }}
      >
        <div>
          <div style={{ fontSize: "15px", fontWeight: 600 }}>Needs action</div>
          <div style={{ fontSize: "12px", color: "var(--inv-muted)", marginTop: "2px" }}>
            Stock level, cover, suggested quantity and value at risk — one row per SKU
          </div>
        </div>
        {filters}
      </div>

      {/* Column header. Presentational only: the rows below are not a semantic table
          because each carries an action, so a grid keeps the markup honest. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: GRID,
          gap: "12px",
          padding: "9px 18px",
          background: "var(--inv-subtle)",
          borderBottom: "1px solid var(--inv-divider)",
          fontFamily: "var(--inv-font-mono)",
          fontSize: "10px",
          letterSpacing: ".7px",
          textTransform: "uppercase",
          color: "var(--inv-muted)",
        }}
      >
        <span>Product</span>
        <span style={{ textAlign: "right" }}>Stock</span>
        <span style={{ textAlign: "right" }}>Cover</span>
        <span style={{ textAlign: "right" }}>Suggested</span>
        <span />
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: "24px 18px", fontSize: "13px", color: "var(--inv-muted)" }}>
          Nothing needs action in this view.
        </div>
      ) : (
        rows.map((row) => (
          <div
            key={row.productId}
            style={{
              display: "grid",
              gridTemplateColumns: GRID,
              gap: "12px",
              padding: "11px 18px",
              borderBottom: "1px solid var(--inv-divider-3)",
              alignItems: "center",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span
                  style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    flex: "none",
                    background: statusMeta(row.status).dot,
                  }}
                />
                <span
                  style={{
                    fontSize: "13px",
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.title}
                </span>
              </div>
              <div
                style={{
                  fontFamily: "var(--inv-font-mono)",
                  fontSize: "10.5px",
                  color: "var(--inv-muted)",
                  marginTop: "3px",
                  paddingLeft: "14px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {row.sku ?? "—"} · {statusMeta(row.status).label}
                {/* Only shown when an alert has actually priced this SKU — see the loader.
                    A dash would read as "nothing at risk" rather than "not computed". */}
                {row.riskLabel && ` · ${row.riskLabel} at risk`}
              </div>
            </div>

            <span
              style={{
                fontFamily: "var(--inv-font-mono)",
                fontSize: "13.5px",
                fontWeight: 600,
                textAlign: "right",
                color: row.stock <= 0 ? "var(--inv-status-stockout-fg)" : "var(--inv-ink)",
              }}
            >
              {row.stock}
            </span>

            <span
              style={{
                fontFamily: "var(--inv-font-mono)",
                fontSize: "12.5px",
                textAlign: "right",
                color: "var(--inv-text-2)",
              }}
            >
              {row.daysRemaining === null ? "none" : `${row.daysRemaining}d`}
            </span>

            <span
              style={{
                fontFamily: "var(--inv-font-mono)",
                fontSize: "13px",
                fontWeight: 600,
                textAlign: "right",
                color: "var(--inv-ink)",
              }}
            >
              +{row.suggestedQty}
            </span>

            <div style={{ textAlign: "right" }}>
              <Link
                to={row.createPoHref}
                style={{
                  display: "inline-block",
                  background: "var(--inv-ink)",
                  color: "#fff",
                  fontSize: "11.5px",
                  fontWeight: 600,
                  padding: "7px 13px",
                  borderRadius: "8px",
                }}
              >
                Create PO
              </Link>
            </div>
          </div>
        ))
      )}

      <div
        style={{
          padding: "13px 18px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: "11.5px", color: "var(--inv-muted)" }}>{footer}</span>
        <div style={{ display: "flex", gap: "9px" }}>{actions}</div>
      </div>
    </div>
  );
}

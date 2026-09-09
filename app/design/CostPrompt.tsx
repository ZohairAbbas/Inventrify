interface Props {
  coverage: string;
  onAction: () => void;
}

/**
 * Dashed banner warning that the capital figures are understated.
 *
 * Every money figure on the dashboard is derived from unit cost, which many shops never
 * populate. Showing a total computed over a fifth of the catalogue without saying so
 * presents a wrong number as the inventory value — so the caveat is given the same weight
 * as the figures it qualifies, rather than being a footnote under one card.
 *
 * Render only when coverage is incomplete; a shop with costs on every SKU should not be
 * nagged.
 */
export function CostPrompt({ coverage, onAction }: Props) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        flexWrap: "wrap",
        background: "#fbfaf6",
        border: "1px dashed #cfc8b6",
        borderRadius: "13px",
        padding: "13px 16px",
        marginBottom: "16px",
      }}
    >
      <span style={{ fontSize: "15px", color: "var(--inv-status-low-fg)", flex: "none" }}>◐</span>
      <div style={{ flex: 1, minWidth: "200px" }}>
        <div style={{ fontSize: "12.5px", fontWeight: 600, color: "#3f3d37" }}>
          Capital figures are understated
        </div>
        <div style={{ fontSize: "11.5px", color: "#8b877d", marginTop: "3px" }}>
          {coverage} — add unit costs to see true tied-up capital, margin and dead stock.
        </div>
      </div>
      <button
        type="button"
        onClick={onAction}
        style={{
          flex: "none",
          border: "1px solid var(--inv-input-border-2)",
          background: "#fff",
          color: "var(--inv-ink)",
          fontSize: "12px",
          fontWeight: 500,
          padding: "7px 13px",
          borderRadius: "9px",
          cursor: "pointer",
        }}
      >
        Add cost data →
      </button>
    </div>
  );
}

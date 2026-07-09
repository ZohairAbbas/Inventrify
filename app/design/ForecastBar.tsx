interface Props {
  gross: number;
  net: number;
}

export function ForecastBar({ gross, net }: Props) {
  const leak = gross - net;
  const netPct = Math.max(6, Math.round((net / Math.max(gross, 1)) * 100));

  return (
    <div style={{ marginTop: "18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--inv-text-2)", marginBottom: "8px" }}>
        <span>Gross demand (orders placed)</span>
        <span style={{ fontFamily: "var(--inv-font-mono)", fontWeight: 600, color: "var(--inv-ink)" }}>{gross} units</span>
      </div>
      <div style={{ position: "relative", height: "46px", borderRadius: "11px", overflow: "hidden", background: "#ece9e1", display: "flex" }}>
        <div
          style={{
            width: netPct + "%",
            background: "var(--inv-accent)",
            display: "flex",
            alignItems: "center",
            padding: "0 12px",
            color: "#fff",
            fontSize: "12px",
            fontWeight: 600,
            transformOrigin: "left",
            animation: "invBar .7s ease",
          }}
        >
          Net {net}
        </div>
        <div
          style={{
            flex: 1,
            background: "repeating-linear-gradient(45deg,#f4ddd7,#f4ddd7 6px,#efd0c8 6px,#efd0c8 12px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--inv-status-stockout-fg)",
            fontSize: "11px",
            fontWeight: 600,
          }}
        >
          {leak > 0 ? `− ${leak} COD returns` : "no leak"}
        </div>
      </div>
      <div style={{ display: "flex", gap: "18px", marginTop: "10px", fontSize: "11.5px", color: "var(--inv-muted)" }}>
        <span>
          <span style={{ color: "var(--inv-accent)" }}>■ </span>
          Net — what you&apos;ll actually deliver
        </span>
        <span>
          <span style={{ color: "#d9a99e" }}>▨ </span>
          returns leak
        </span>
      </div>
    </div>
  );
}

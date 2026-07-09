interface Props {
  label: string;
  value: string | number;
  sub?: string;
  valueColor?: string;
  accentBar?: string;
}

export function KpiCard({ label, value, sub, valueColor, accentBar }: Props) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid var(--inv-border)",
        borderRadius: "var(--inv-radius-card)",
        padding: "16px 17px",
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
      <div style={{ fontSize: "12px", color: "#8b877d", marginBottom: "10px" }}>{label}</div>
      <div
        style={{
          fontFamily: "var(--inv-font-mono)",
          fontSize: "29px",
          fontWeight: 600,
          letterSpacing: "-1px",
          color: valueColor,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: "11.5px",
            color: valueColor && accentBar ? valueColor : "var(--inv-muted)",
            marginTop: "6px",
            fontWeight: accentBar ? 500 : 400,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

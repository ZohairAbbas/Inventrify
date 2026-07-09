interface Props {
  label: string;
  value: string | number;
  sub?: string;
  valueColor?: string;
}

export function Stat({ label, value, sub, valueColor }: Props) {
  return (
    <div>
      <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "5px" }}>
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--inv-font-mono)",
          fontSize: "19px",
          fontWeight: 600,
          color: valueColor,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: "10.5px", color: "var(--inv-muted)" }}>{sub}</div>
      )}
    </div>
  );
}

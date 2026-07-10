interface Props {
  values: number[];
  labels?: [string, string];
}

export function BarChart({ values, labels }: Props) {
  const max = Math.max(...values, 1);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "3px", height: "90px" }}>
        {values.map((v, i) => (
          <div
            key={i}
            title={`${v} units`}
            style={{
              flex: 1,
              height: Math.max(3, (v / max) * 100) + "%",
              background: v > 0 ? "var(--inv-accent)" : "var(--inv-input-border)",
              borderRadius: "3px 3px 0 0",
              opacity: v > 0 ? 1 : 0.55,
            }}
          />
        ))}
      </div>
      {labels && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: "8px",
            fontSize: "10.5px",
            color: "var(--inv-muted)",
            fontFamily: "var(--inv-font-mono)",
          }}
        >
          <span>{labels[0]}</span>
          <span>{labels[1]}</span>
        </div>
      )}
    </div>
  );
}

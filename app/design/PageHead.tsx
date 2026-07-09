import type { ReactNode } from "react";

interface Props {
  title: string;
  eyebrow: string;
  right?: ReactNode;
}

export function PageHead({ title, eyebrow, right }: Props) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: "16px",
        marginBottom: "18px",
      }}
    >
      <div>
        <div
          style={{
            fontFamily: "var(--inv-font-mono)",
            fontSize: "11px",
            letterSpacing: "1px",
            color: "var(--inv-muted)",
            textTransform: "uppercase",
            marginBottom: "6px",
          }}
        >
          {eyebrow}
        </div>
        <h1 style={{ margin: 0, fontSize: "25px", fontWeight: 600, letterSpacing: "-.5px" }}>
          {title}
        </h1>
      </div>
      {right}
    </div>
  );
}

import type { CSSProperties, ReactNode } from "react";

interface Props {
  children: ReactNode;
  padding?: string;
  style?: CSSProperties;
}

export function Card({ children, padding = "17px 18px", style }: Props) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid var(--inv-border)",
        borderRadius: "var(--inv-radius-card)",
        padding,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

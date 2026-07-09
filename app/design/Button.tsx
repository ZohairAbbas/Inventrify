import type { ButtonHTMLAttributes } from "react";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "variant"> {
  variant?: "primary" | "accent" | "ghost";
}

const base: React.CSSProperties = {
  fontSize: "13px",
  fontWeight: 500,
  padding: "9px 15px",
  borderRadius: "var(--inv-radius-control)",
  cursor: "pointer",
  border: "1px solid transparent",
  whiteSpace: "nowrap",
  transition: "filter .12s ease",
};

const variantStyles: Record<NonNullable<Props["variant"]>, React.CSSProperties> = {
  primary: { background: "var(--inv-ink)", color: "#fff" },
  accent: { background: "var(--inv-accent)", color: "#fff" },
  ghost: {
    background: "#fff",
    border: "1px solid var(--inv-input-border-2)",
    color: "var(--inv-ink)",
  },
};

export function Button({ variant = "primary", style, ...rest }: Props) {
  return (
    <button
      {...rest}
      style={{ ...base, ...variantStyles[variant], ...style }}
      onMouseEnter={(e) => {
        e.currentTarget.style.filter = "brightness(1.07)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.filter = "none";
      }}
    />
  );
}

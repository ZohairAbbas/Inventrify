import { useEffect } from "react";

interface Props {
  message: string;
  onDismiss: () => void;
  durationMs?: number;
}

export function Toast({ message, onDismiss, durationMs = 2600 }: Props) {
  useEffect(() => {
    const t = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(t);
  }, [message, durationMs, onDismiss]);

  if (!message) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: "22px",
        left: "50%",
        transform: "translateX(-50%)",
        background: "var(--inv-ink)",
        color: "#f1efe8",
        padding: "12px 18px",
        borderRadius: "12px",
        fontSize: "13px",
        fontWeight: 500,
        boxShadow: "0 12px 34px rgba(0,0,0,.28)",
        zIndex: 60,
        animation: "invToast .25s ease",
        display: "flex",
        alignItems: "center",
        gap: "10px",
      }}
    >
      <span style={{ color: "var(--inv-accent)" }}>✓</span>
      {message}
    </div>
  );
}

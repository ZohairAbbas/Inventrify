import type { ReactNode } from "react";

interface Props {
  alertLabel?: string;
  headline: ReactNode;
  body: string;
  primaryAction?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
}

export function HeroBand({ alertLabel, headline, body, primaryAction, secondaryAction }: Props) {
  return (
    <div
      style={{
        background: "linear-gradient(145deg,#211f1b 0%,#141310 100%)",
        borderRadius: "var(--inv-radius-card-lg)",
        padding: "26px 28px",
        color: "#f1efe8",
        position: "relative",
        overflow: "hidden",
        marginBottom: "16px",
      }}
    >
      <div
        style={{
          position: "absolute",
          right: "-40px",
          top: "-40px",
          width: "220px",
          height: "220px",
          borderRadius: "50%",
          background: "radial-gradient(circle, var(--inv-accent-glow) 0%, transparent 70%)",
          opacity: 0.5,
        }}
      />
      <div
        style={{
          position: "relative",
          display: "flex",
          gap: "34px",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <div style={{ flex: 1, minWidth: "280px" }}>
          {alertLabel && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "7px",
                background: "rgba(209,73,63,.16)",
                border: "1px solid rgba(209,73,63,.35)",
                color: "#f0a89f",
                fontSize: "11.5px",
                fontWeight: 500,
                padding: "4px 10px",
                borderRadius: "var(--inv-radius-pill)",
                marginBottom: "14px",
              }}
            >
              <span
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background: "#e0574c",
                  animation: "invPulse 1.6s infinite",
                }}
              />
              {alertLabel}
            </div>
          )}
          <div
            style={{
              fontSize: "30px",
              fontWeight: 600,
              letterSpacing: "-.6px",
              lineHeight: 1.15,
              marginBottom: "8px",
            }}
          >
            {headline}
          </div>
          <div style={{ fontSize: "14px", color: "#a8a49a", lineHeight: 1.5, maxWidth: "440px" }}>
            {body}
          </div>
        </div>
        {(primaryAction || secondaryAction) && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", minWidth: "200px" }}>
            {primaryAction && (
              <button
                onClick={primaryAction.onClick}
                style={{
                  background: "var(--inv-accent)",
                  color: "#fff",
                  border: "none",
                  fontSize: "13.5px",
                  fontWeight: 600,
                  padding: "12px 18px",
                  borderRadius: "11px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.filter = "brightness(1.08)")}
                onMouseLeave={(e) => (e.currentTarget.style.filter = "none")}
              >
                {primaryAction.label} <span>→</span>
              </button>
            )}
            {secondaryAction && (
              <button
                onClick={secondaryAction.onClick}
                style={{
                  background: "rgba(255,255,255,.08)",
                  color: "#eceae3",
                  border: "1px solid rgba(255,255,255,.14)",
                  fontSize: "13px",
                  fontWeight: 500,
                  padding: "11px 18px",
                  borderRadius: "11px",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,.14)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,.08)")}
              >
                {secondaryAction.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

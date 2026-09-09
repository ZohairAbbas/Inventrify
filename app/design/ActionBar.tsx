import type { ReactNode } from "react";

interface Action {
  label: string;
  onClick: () => void;
}

interface Props {
  headline: ReactNode;
  body: string;
  primary: Action;
  secondary?: Action;
}

/**
 * Slim dark banner at the top of the dashboard, replacing the tall hero band.
 *
 * The hero it supersedes occupied roughly a third of the first screen to say one number
 * and offer two links, pushing the KPI row below the fold. This says the same thing in
 * one row. It is only rendered when there is something to act on, so its presence is
 * itself the signal — which is why the dot pulses rather than sitting static.
 */
export function ActionBar({ headline, body, primary, secondary }: Props) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "16px",
        flexWrap: "wrap",
        background: "var(--inv-ink)",
        borderRadius: "13px",
        padding: "12px 16px",
        marginBottom: "16px",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: "7px", flex: "none" }}>
        <span
          style={{
            width: "7px",
            height: "7px",
            borderRadius: "50%",
            background: "#e0574c",
            animation: "invPulse 1.6s infinite",
          }}
        />
        <span style={{ fontSize: "14px", fontWeight: 600, color: "#f1efe8" }}>{headline}</span>
      </span>

      <span style={{ fontSize: "12.5px", color: "#a8a49a", flex: 1, minWidth: "180px" }}>
        {body}
      </span>

      <button
        type="button"
        onClick={primary.onClick}
        style={{
          flex: "none",
          background: "var(--inv-accent)",
          color: "#fff",
          border: "none",
          fontSize: "12.5px",
          fontWeight: 600,
          padding: "8px 14px",
          borderRadius: "9px",
          cursor: "pointer",
        }}
      >
        {primary.label}
      </button>

      {secondary && (
        <button
          type="button"
          onClick={secondary.onClick}
          style={{
            flex: "none",
            background: "rgba(255,255,255,.08)",
            color: "#eceae3",
            border: "1px solid rgba(255,255,255,.16)",
            fontSize: "12.5px",
            fontWeight: 500,
            padding: "8px 14px",
            borderRadius: "9px",
            cursor: "pointer",
          }}
        >
          {secondary.label}
        </button>
      )}
    </div>
  );
}

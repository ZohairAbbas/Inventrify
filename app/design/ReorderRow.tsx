import { statusMeta, type StockStatus } from "./StatusBadge";
import { Link } from "@remix-run/react";

interface Props {
  title: string;
  sub: string;
  suggestedQty: number;
  status: StockStatus;
  createPoHref: string;
  isFirst: boolean;
}

export function ReorderRow({ title, sub, suggestedQty, status, createPoHref, isFirst }: Props) {
  const dot = statusMeta(status).dot;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "var(--inv-row-pad)",
        borderTop: isFirst ? "none" : "1px solid var(--inv-divider-3)",
      }}
    >
      <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: dot, flex: "none" }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "13px",
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginTop: "1px" }}>{sub}</div>
      </div>
      <div style={{ textAlign: "right", flex: "none" }}>
        <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "13px", fontWeight: 600 }}>
          +{suggestedQty}
        </div>
        <div style={{ fontSize: "10.5px", color: "var(--inv-muted)" }}>suggested</div>
      </div>
      <Link to={createPoHref} style={{ flex: "none" }}>
        <button
          style={{
            border: "1px solid var(--inv-ink)",
            background: "var(--inv-ink)",
            color: "#fff",
            fontSize: "12px",
            fontWeight: 500,
            padding: "7px 12px",
            borderRadius: "9px",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#000")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "var(--inv-ink)")}
        >
          Create PO
        </button>
      </Link>
    </div>
  );
}

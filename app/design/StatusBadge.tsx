export type StockStatus = "healthy" | "low" | "critical" | "stockout";

const STATUS: Record<StockStatus, { bg: string; fg: string; dot: string; label: string }> = {
  healthy: { bg: "var(--inv-status-healthy-bg)", fg: "var(--inv-status-healthy-fg)", dot: "var(--inv-status-healthy-dot)", label: "Healthy" },
  low: { bg: "var(--inv-status-low-bg)", fg: "var(--inv-status-low-fg)", dot: "var(--inv-status-low-dot)", label: "Low" },
  critical: { bg: "var(--inv-status-critical-bg)", fg: "var(--inv-status-critical-fg)", dot: "var(--inv-status-critical-dot)", label: "Critical" },
  stockout: { bg: "var(--inv-status-stockout-bg)", fg: "var(--inv-status-stockout-fg)", dot: "var(--inv-status-stockout-dot)", label: "Stockout" },
};

export function statusMeta(status: StockStatus) {
  return STATUS[status];
}

export function StatusBadge({ status }: { status: StockStatus }) {
  const s = STATUS[status];
  return (
    <span
      style={{
        fontSize: "11px",
        fontWeight: 600,
        padding: "3px 9px",
        borderRadius: "var(--inv-radius-badge)",
        background: s.bg,
        color: s.fg,
        whiteSpace: "nowrap",
      }}
    >
      {s.label}
    </span>
  );
}

import { PO_STATUS_LABELS, type POStatus } from "../lib/purchase-order-status";

export type { POStatus };

interface Props {
  label: string;
  bg: string;
  fg: string;
}

export function Pill({ label, bg, fg }: Props) {
  return (
    <span
      style={{
        fontSize: "11px",
        fontWeight: 600,
        padding: "3px 9px",
        borderRadius: "var(--inv-radius-badge)",
        background: bg,
        color: fg,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

const PO_STATUS: Record<POStatus, { bg: string; fg: string }> = {
  draft: { bg: "var(--inv-divider-3)", fg: "var(--inv-text-2)" },
  sent: { bg: "var(--inv-status-low-bg)", fg: "var(--inv-status-low-fg)" },
  // Still waiting on the rest, so it reads as "in progress" like sent, not as done.
  partially_received: { bg: "var(--inv-status-low-bg)", fg: "var(--inv-status-low-fg)" },
  received: { bg: "var(--inv-status-healthy-bg)", fg: "var(--inv-status-healthy-fg)" },
  // Finished, but short — neutral rather than green so it is not mistaken for complete.
  closed: { bg: "var(--inv-divider-3)", fg: "var(--inv-text-2)" },
};

export function poStatusMeta(status: string) {
  return PO_STATUS[status as POStatus] ?? PO_STATUS.draft;
}

export function POStatusPill({ status }: { status: string }) {
  const s = poStatusMeta(status);
  return <Pill label={PO_STATUS_LABELS[status as POStatus] ?? status} bg={s.bg} fg={s.fg} />;
}

export type TransferStatus = "draft" | "in-transit" | "received";

const TRANSFER_STATUS: Record<TransferStatus, { bg: string; fg: string }> = {
  draft: { bg: "var(--inv-divider-3)", fg: "var(--inv-text-2)" },
  "in-transit": { bg: "var(--inv-status-low-bg)", fg: "var(--inv-status-low-fg)" },
  received: { bg: "var(--inv-status-healthy-bg)", fg: "var(--inv-status-healthy-fg)" },
};

export function transferStatusMeta(status: string) {
  return TRANSFER_STATUS[status as TransferStatus] ?? TRANSFER_STATUS.draft;
}

export function TransferStatusPill({ status }: { status: string }) {
  const s = transferStatusMeta(status);
  return <Pill label={status} bg={s.bg} fg={s.fg} />;
}

import { PAGE_SIZES, pageNumbers, type Page } from "../lib/pagination";

interface Props {
  page: Page;
  /** Called with the new page number. */
  onPageChange: (page: number) => void;
  /** Omit to hide the rows-per-page control. */
  onPageSizeChange?: (pageSize: number) => void;
  /** What is being counted, for the summary line. */
  itemLabel?: string;
  /** Set while a navigation is in flight, to stop double-clicks stacking requests. */
  busy?: boolean;
}

const buttonStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
  minWidth: "30px",
  height: "30px",
  padding: "0 8px",
  fontSize: "12px",
  fontWeight: active ? 600 : 500,
  fontFamily: "var(--inv-font-mono)",
  border: "1px solid " + (active ? "var(--inv-accent)" : "var(--inv-input-border-2)"),
  background: active ? "var(--inv-accent-soft)" : "#fff",
  color: active ? "var(--inv-accent)" : "var(--inv-text-2)",
  borderRadius: "8px",
  cursor: disabled ? "default" : "pointer",
  opacity: disabled ? 0.45 : 1,
});

/**
 * Page control for the list views.
 *
 * Always renders the count summary, even for a single page — "Showing 1–7 of 7" is how a
 * merchant confirms a filter did what they expected, and hiding it on short lists means
 * it disappears exactly when someone is checking a narrow search.
 */
export function Pagination({
  page,
  onPageChange,
  onPageSizeChange,
  itemLabel = "items",
  busy = false,
}: Props) {
  const { totalItems, firstItem, lastItem, totalPages, hasPrevious, hasNext } = page;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        flexWrap: "wrap",
        marginTop: "12px",
      }}
    >
      <div style={{ fontSize: "11.5px", color: "var(--inv-muted)" }}>
        {totalItems === 0
          ? `No ${itemLabel}`
          : `Showing ${firstItem.toLocaleString()}–${lastItem.toLocaleString()} of ${totalItems.toLocaleString()} ${itemLabel}`}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        {onPageSizeChange && totalItems > PAGE_SIZES[0] && (
          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11.5px", color: "var(--inv-muted)" }}>
            Rows
            <select
              value={page.pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              disabled={busy}
              style={{
                height: "30px",
                fontSize: "12px",
                border: "1px solid var(--inv-input-border-2)",
                borderRadius: "8px",
                background: "#fff",
                color: "var(--inv-ink)",
                padding: "0 6px",
                cursor: busy ? "default" : "pointer",
              }}
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </label>
        )}

        {totalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
            <button
              onClick={() => onPageChange(page.page - 1)}
              disabled={!hasPrevious || busy}
              aria-label="Previous page"
              style={buttonStyle(false, !hasPrevious || busy)}
            >
              ←
            </button>

            {pageNumbers(page.page, totalPages).map((n, i) =>
              n === null ? (
                <span key={`gap-${i}`} style={{ fontSize: "12px", color: "var(--inv-faint)", padding: "0 2px" }}>
                  …
                </span>
              ) : (
                <button
                  key={n}
                  onClick={() => onPageChange(n)}
                  disabled={busy}
                  aria-current={n === page.page ? "page" : undefined}
                  style={buttonStyle(n === page.page, busy)}
                >
                  {n}
                </button>
              ),
            )}

            <button
              onClick={() => onPageChange(page.page + 1)}
              disabled={!hasNext || busy}
              aria-label="Next page"
              style={buttonStyle(false, !hasNext || busy)}
            >
              →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

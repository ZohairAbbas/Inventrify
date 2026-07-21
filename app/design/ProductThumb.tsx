interface Props {
  src?: string | null;
  /** Product/variant name — used for the alt text and the initials fallback. */
  name: string;
  size?: number;
}

/** Initials shown when a SKU has no image, so the cell still reads as a product. */
function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/**
 * Small square product image for list rows.
 *
 * Shopify serves CDN images at their original size, which for a 2000px product photo is
 * wasteful in a 34px cell, so a width hint is appended. Falls back to initials rather
 * than a broken-image icon when a variant has no media.
 */
export function ProductThumb({ src, name, size = 34 }: Props) {
  const sized = src ? withWidth(src, size * 2) : null;

  return (
    <span
      aria-hidden={false}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        flex: `0 0 ${size}px`,
        borderRadius: "8px",
        overflow: "hidden",
        background: "var(--inv-subtle)",
        border: "1px solid var(--inv-divider)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: `${Math.max(10, Math.round(size * 0.34))}px`,
        fontWeight: 600,
        color: "var(--inv-text-2)",
        userSelect: "none",
      }}
    >
      {sized ? (
        <img
          src={sized}
          alt={name}
          loading="lazy"
          width={size}
          height={size}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <span title={name}>{initials(name)}</span>
      )}
    </span>
  );
}

/** Append Shopify's CDN width parameter without disturbing existing query params. */
function withWidth(url: string, width: number): string {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("shopify")) return url;
    u.searchParams.set("width", String(width));
    return u.toString();
  } catch {
    return url;
  }
}

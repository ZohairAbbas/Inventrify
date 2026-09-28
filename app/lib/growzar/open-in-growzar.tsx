import { useState } from "react";
import { Button } from "../../design";

/**
 * "Open in Growzar" (D-10). Asks the server for a claim token, then opens Growzar's
 * /claim page with the token in the URL fragment, top-level and outside the admin iframe.
 *
 * The new tab is opened synchronously inside the click, while the browser still counts
 * it as a user gesture, and pointed at Growzar once the token arrives — opening it after
 * the await would be a popup and get blocked. If the browser blocks it anyway, a plain
 * link is shown, which the merchant's own click opens.
 */
export function OpenInGrowzar() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    setFallbackUrl(null);
    const tab = window.open("about:blank", "_blank");

    try {
      // App Bridge adds the session token to same-origin fetches.
      const response = await fetch("/api/growzar/claim-token", { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !body.url) {
        tab?.close();
        setError(body.error ?? "Could not open Growzar. Try again.");
        return;
      }
      if (tab && !tab.closed) {
        tab.opener = null;
        tab.location.replace(body.url);
      } else {
        setFallbackUrl(body.url);
      }
    } catch {
      tab?.close();
      setError("Could not open Growzar. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button variant="accent" onClick={open} disabled={busy}>
        {busy ? "Opening…" : "Open in Growzar"}
      </Button>
      {fallbackUrl && (
        <div style={{ marginTop: "8px", fontSize: "13px" }}>
          Your browser blocked the new tab.{" "}
          <a href={fallbackUrl} target="_blank" rel="noopener noreferrer" onClick={() => setFallbackUrl(null)}>
            Continue to Growzar
          </a>{" "}
          (link expires in 5 minutes).
        </div>
      )}
      {error && (
        <div style={{ marginTop: "8px", fontSize: "13px", color: "var(--inv-status-critical-fg)" }}>{error}</div>
      )}
    </div>
  );
}

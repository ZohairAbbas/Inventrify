import type { ActionFunctionArgs } from "@remix-run/node";
import { confirmCosts, openCostWrite } from "../lib/growzar/costs.server";
import { growzarError } from "../lib/growzar/platform-auth.server";

/**
 * POST /api/v1/growzar/costs/confirm — step two: writes a preview's "set" items to
 * Shopify (inventoryItemUpdate) and to Inventorify's stored unit cost (G-INV-C1).
 *
 * Body `{ previewId }`, with an `Idempotency-Key` header (API-CONTRACT §8). Per-item
 * results; see lib/growzar/costs.server.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const opened = await openCostWrite(request);
  if (!opened.ok) return opened.response;
  const { shop, actor, body } = opened.value;

  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return growzarError(400, "idempotency_key_required", "An Idempotency-Key header is required.");
  }

  let previewId: unknown;
  try {
    previewId = (JSON.parse(body) as { previewId?: unknown })?.previewId;
  } catch {
    return growzarError(400, "bad_request", "The body must be JSON.");
  }
  if (typeof previewId !== "string" || !previewId.trim()) {
    return growzarError(400, "bad_request", "previewId is required.");
  }

  try {
    return await confirmCosts({ shop, actor, previewId: previewId.trim(), idempotencyKey });
  } catch (err) {
    console.error("[growzar] cost confirm failed:", err instanceof Error ? err.message : err);
    return growzarError(500, "internal_error", "Could not confirm costs.");
  }
};

export const loader = async () => growzarError(405, "bad_request", "Confirms are made with POST.");

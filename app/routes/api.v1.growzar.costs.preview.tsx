import type { ActionFunctionArgs } from "@remix-run/node";
import { openCostWrite, parsePreviewBody, previewCosts } from "../lib/growzar/costs.server";
import { growzarError } from "../lib/growzar/platform-auth.server";

/**
 * POST /api/v1/growzar/costs/preview — step one of setting Shopify's cost per item from
 * Growzar's Books (G-INV-C1). Reads Shopify and changes nothing; see lib/growzar/costs.server.
 *
 * Body `{ items: [{ variantId, cost: { amount, currency } }] }`, at most 250 items.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const opened = await openCostWrite(request);
  if (!opened.ok) return opened.response;
  const { shop, actor, body } = opened.value;

  const parsed = parsePreviewBody(body);
  if (!parsed.ok) return growzarError(400, "bad_request", parsed.error);

  try {
    return await previewCosts({ shop, actor, items: parsed.items });
  } catch (err) {
    console.error("[growzar] cost preview failed:", err instanceof Error ? err.message : err);
    return growzarError(500, "internal_error", "Could not preview costs.");
  }
};

export const loader = async () => growzarError(405, "bad_request", "Previews are made with POST.");

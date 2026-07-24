import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { resolveScan } from "../lib/scan.server";

/**
 * Resolve one scanned code to a product.
 *
 * Shop-scoped by the embedded admin session, so a scan can never reach across tenants
 * regardless of what the client sends.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const code = new URL(request.url).searchParams.get("code") ?? "";
  return json(await resolveScan(session.shop, code));
};

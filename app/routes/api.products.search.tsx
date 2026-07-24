import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseSearch } from "../lib/pagination";

/**
 * Product lookup for the searchable pickers.
 *
 * The forms used to render every variant in the catalogue into a `<select>` — the PO
 * builder, the transfer builder, the returns assignment dropdown and the adjustment form
 * each shipped the whole product list on every page load, and a `<select>` with ten
 * thousand `<option>`s is unusable even once it arrives. They ask this endpoint instead.
 *
 * Authenticated as an embedded admin request, so results are scoped to the calling shop
 * by the session rather than by anything the client sends.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = parseSearch(url.searchParams, "q");

  // Capped hard: this feeds a dropdown a human reads, and an uncapped "show me
  // everything" would put the original problem straight back.
  const LIMIT = 20;

  const products = await prisma.product.findMany({
    where: {
      shop: session.shop,
      isArchived: false,
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: "insensitive" as const } },
              { sku: { contains: search, mode: "insensitive" as const } },
              { variantTitle: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    select: { id: true, title: true, variantTitle: true, sku: true, currentStock: true, unitCost: true },
    orderBy: [{ title: "asc" }, { id: "asc" }],
    take: LIMIT,
  });

  return json({
    products: products.map((p) => ({
      id: p.id,
      label: p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title,
      sku: p.sku,
      currentStock: p.currentStock,
      // Lets a PO line seed its cost from the product instead of defaulting to zero,
      // which is how generated POs used to end up with a total of 0.
      unitCost: p.unitCost,
    })),
    // Lets the picker say "refine your search" rather than silently truncating.
    truncated: products.length === LIMIT,
  });
};

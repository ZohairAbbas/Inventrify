import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import {
  createdKeysetOrder,
  dayOf,
  feedPartner,
  iso,
  keysetWhere,
  money,
  openFeed,
  pagedResponse,
  pageTake,
  settledWhere,
} from "../lib/growzar/feed.server";
import { growzarError } from "../lib/growzar/platform-auth.server";

/**
 * GET /api/v1/growzar/supplier-ledger — every supplier ledger entry, for Growzar's Books
 * and Financify's. /api/v1/financify/supplier-ledger re-exports this route, so both
 * partners get the same body; the partner comes from the path (openFeed).
 *
 * Append-only like receipts: an entry is never edited or deleted. A correction is a new
 * `reversal` row whose `reversalOf` names the entry it undoes, at most once per entry.
 *
 * `amount` is signed as stored: positive means the merchant owes the supplier more (bill,
 * refund, owe-more adjustment), negative means less (payment, credit note, owe-less
 * adjustment). `sourceKey` says what posted an automatic entry: `receipt:<id>` for a
 * receipt's bill, `claim:<id>:bill` for units invoiced but never sent, and so on; it is
 * null for entries the merchant typed in.
 *
 * `date` is the entry's day in the shop's time zone; `occurredAt` the stored value.
 * Staff ids and free-text notes are left out; `reference` is the invoice or bank
 * reference the merchant gave.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const feed = await openFeed(request);
  if (!feed.ok) return feed.response;
  const { facts, params } = feed.value;

  try {
    const rows = await prisma.supplierLedgerEntry.findMany({
      where: { shop: facts.shop, AND: [settledWhere(), keysetWhere(params, "createdAt")] },
      orderBy: createdKeysetOrder,
      take: pageTake(params),
      select: {
        id: true,
        supplierId: true,
        type: true,
        amount: true,
        currency: true,
        occurredAt: true,
        reference: true,
        sourceKey: true,
        purchaseOrderId: true,
        receiptId: true,
        claimId: true,
        reversalOf: true,
        createdAt: true,
      },
    });

    return await pagedResponse(
      feed.value,
      rows,
      (e) => e.createdAt,
      (e) => ({
        id: e.id,
        supplierId: e.supplierId,
        kind: e.type,
        amount: money(e.amount.toNumber(), e.currency),
        currency: e.currency,
        occurredAt: iso(e.occurredAt),
        date: dayOf(e.occurredAt, facts.shopTimezone),
        sourceKey: e.sourceKey,
        reference: e.reference,
        poId: e.purchaseOrderId,
        receiptId: e.receiptId,
        claimId: e.claimId,
        reversalOf: e.reversalOf,
        createdAt: iso(e.createdAt),
      }),
    );
  } catch (err) {
    const partner = feedPartner(new URL(request.url).pathname);
    console.error(`[${partner}] supplier-ledger feed failed:`, err instanceof Error ? err.message : err);
    return growzarError(500, "internal_error", "Could not read the supplier ledger.");
  }
};

export const action = async () => growzarError(405, "bad_request", "Feeds are read with GET.");

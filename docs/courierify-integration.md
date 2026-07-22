# Courierify ↔ Inventorify integration contract

`app/lib/courierify.server.ts` referenced `Plans/courierify-inventrify-contract.md` as its
source of truth. That path is gitignored and the file does not exist in the repository, so
the only real description of the contract was the implementation. This document records
what the code actually consumes, derived from the implementation, and is the file the code
now cites.

If Courierify's own spec disagrees with anything here, Courierify wins — but update this
file and the types in `courierify.server.ts` together.

## Transport

- Base URL: `COURIERIFY_BASE_URL` (defaults to `https://courierify.growzar.com`).
- All endpoints live under `/api/external`.
- Auth: `Authorization: Bearer <shop's courierifyApiKey>`.
  The key is stored encrypted (see `app/lib/crypto.server.ts`) and decrypted at call time.
- Every response is enveloped: `{ timestamp, rows: [...] }`.
- Errors are `{ error, errorType }` and may accompany a non-2xx status.
- `fetchExternal()` never throws; it returns `{ rows }` or `{ error }`. Every sync is
  best-effort and reports its own error rather than aborting a batch.

## Endpoints

### `GET /api/external/inventrify/return-rates?shop=<domain>`

Per-SKU COD return (RTO) rate from real delivery outcomes.

| Field        | Type     | Notes                       |
| ------------ | -------- | --------------------------- |
| `sku`        | string   | Matched against `Product.sku` |
| `returnRate` | number   | 0.0–1.0, clamped on ingest  |

Written to `Product.courierRtoRate` and mirrored into the resolved `Product.codReturnRate`
with `returnRateSource = "courierify"`.

**This endpoint is the authoritative source of RTO rate.** Nothing else may write
`courierRtoRate`. See `resolveReturnRate()` in `app/lib/planning.server.ts` for precedence.

The shop-level `/api/external/delivery` RTS analysis is *not* usable here: it has no SKU
dimension and is Growzar-gated.

### `GET /api/external/inventrify/status-summary?shop=<domain>`

Live per-SKU fulfilment pipeline snapshot.

| Field       | Type   | Notes                    |
| ----------- | ------ | ------------------------ |
| `sku`       | string |                          |
| `delivered` | number | cumulative units         |
| `inTransit` | number | currently in forward transit |
| `returned`  | number | cumulative RTO units     |

Cached onto `Product.fulfilledDelivered / fulfilledInTransit / fulfilledReturned` with
`fulfilmentSyncedAt`.

**Damaged is deliberately absent.** Damage is Inventorify's own concept, derived from
`StockAdjustment(reason="damage")` plus `ReturnItem(status="written_off")`. Courierify must
never be asked for it.

### `GET /api/external/inventrify/returns?shop=<domain>[&updatedSince=<ISO>]`

Return-received events, feeding the returns-to-restock queue.

| Field                  | Type            | Notes                                            |
| ---------------------- | --------------- | ------------------------------------------------ |
| `shipmentId`           | string          | Part of the idempotency key                      |
| `lineItemId`           | string          | Courierify `ShipmentLineItem.id`; **always present** — the other half of the key |
| `shopifyOrderName`     | string \| null  | Display only                                     |
| `sku`                  | string \| null  | Nullable: SKU-less products exist                |
| `shopifyVariantId`     | string \| null  | Fallback match key (equals `Product.id`)         |
| `title`, `variantTitle`| string \| null  | Display for unmatched lines                      |
| `quantity`             | number          | Floored at 1                                     |
| `returnReceivedAt`     | ISO \| null     |                                                  |
| `updatedAt`            | ISO \| null     | **The field the `updatedSince` filter applies to** |
| `isShopifyReturnClosed`| boolean         | Reconciliation only                              |
| `reasonCategory`       | string \| null  | From Courierify `ReturnReason.category`          |
| `courier`              | string \| null  | Optional. Read if present, never required — enables carrier-level RTO breakdown |

Idempotency key is `(shipmentId, lineItemId)`, *not* `(shipmentId, sku)` — two SKU-less
lines on one shipment must stay distinct.

Matching order for `productId`: `sku` first, then `shopifyVariantId`. Unmatched rows are
still queued, with `productId = null`, so they are visible rather than silently dropped.

## Cursor semantics

`ShopSettings.courierifyReturnsCursor` drives `updatedSince`. Rules, all load-bearing:

1. Advance to the **maximum `updatedAt` actually observed**, never to `now()` — anything
   Courierify updated between the request and the write would otherwise be skipped forever.
2. Subtract a 60s overlap buffer. Re-pulling is free because the upsert is idempotent;
   missing a return is not.
3. **Never advance on an empty pull.** An empty result means "nothing new", not "we are
   caught up to now".
4. Never move the cursor backwards.

## Invariants

- An already-resolved `ReturnItem` (`restocked` / `written_off`) is never reopened. Repeat
  pulls refresh descriptive fields only.
- Restocking a return goes through `applyStockDelta()` so it is audited and pushed to
  Shopify; writing one off records damage and moves no stock.
- Both syncs report `unmatched` — SKUs Courierify knows about that have no local product.
  A non-zero count means the RTO data has gaps, which otherwise looks identical to full
  coverage.

## Regional attribution

Returns are attributed to a delivery city so RTO can be broken down by route
(`getRtoByRegion` in `app/lib/analytics.server.ts`). The city does **not** come from
Courierify — it is resolved at ingest by joining `shopifyOrderName` against `OrderRegion`,
which the Shopify order sync populates from the order's shipping address.

That means regional analysis works with no additional Courierify surface. If Courierify
later exposes a carrier per shipment, `courier` is already read opportunistically and the
same breakdown extends to carriers.

Denominator rules:

- Only COD orders count. A refused prepaid order is not an RTO in the sense that matters.
- Cities below a minimum shipped volume are excluded — 1 return out of 2 shipments is not
  a 50% RTO route.

## Proposed: `GET /api/external/inventrify/order-outcomes` (NOT YET IMPLEMENTED)

The three endpoints above all group on `ShipmentLineItem.sku`. In practice that column is
almost never populated — `lineItems` is optional at booking and only one booking path
passes it — so per-SKU RTO comes back empty for shops with thousands of real returns.

Measured on one production shop: 1,594 shipments, 31 with any line item, **0 with a SKU**.
Across the platform, four of the largest shops had **zero** line items between them across
147,000 shipments.

Order-level outcomes avoid the problem entirely. Every shipment already carries
`shopifyOrderName` (100% populated on the rows sampled), and Inventorify already knows
which SKUs were in which order (`OrderLineItem`, captured during the Shopify order sync).
Joining the two reconstructs per-SKU RTO locally, with **no backfill required**.

Proposed shape, mirroring its ungated siblings:

```
GET /api/external/inventrify/order-outcomes?shop=<domain>[&updatedSince=<ISO>]
Scope: analytics:read · ungated · non-billable

{ "timestamp": "...", "rows": [
  { "shipmentId": "...", "shopifyOrderName": "#2688",
    "status": "returned", "updatedAt": "...", "courier": "postex" }
] }
```

Cursor semantics identical to `inventrify/returns`.

The Inventorify consumer is already written and tested
(`syncCourierifyOrderOutcomes` + `rto-attribution.server.ts`). It is inert until this
endpoint exists: an absent or gated endpoint is reported as `available: false` and nothing
is written. Verified against the live store's real 1,590 shipment outcomes by standing in
for the endpoint, producing per-SKU rates of 48.6% / 45.7% / 21.4% where the SKU-keyed
endpoints returned nothing at all.

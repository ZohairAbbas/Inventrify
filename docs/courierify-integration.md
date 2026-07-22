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

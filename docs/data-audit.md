# Data-point audit

Every figure the app displays, checked against independently computed ground truth on
live production data. Re-run these when changing anything that writes them.

## Clean

| Area | Checked |
| --- | --- |
| Per-location stock | `Product.currentStock` equals `sum(ProductLocationStock.onHand)` for every product |
| Rate bounds | No `codReturnRate` outside 0–1, no `avgMargin >= 1`, no negative cost/safety stock/reorder point |
| Forecasts | Every live product has exactly 30/60/90 rows; `net <= gross`; `procurement <= gross`; `pi80Low <= pi80High`; confidence within 0–1; no past-dated forecast; 90d never below 30d |
| Alerts | No duplicate `dedupeKey`; open stockout alerts exactly match products at or below zero (169 = 169); none against archived products |
| Purchase orders | `totalCost` equals the sum of its line totals; no received-above-ordered; no negative quantities |
| Transfers | No received-above-sent; no same-location transfers |
| Suppliers | No negative lead times; no variance recorded against fewer than two receipts |
| Returns | No resolved row missing `resolvedAt`; no quantity below 1 |
| Order data | No `OrderOutcome` without matching `OrderLineItem`; no line quantity below 1 |
| Seasonal events | No inverted date ranges; no non-positive multipliers |

## Fixed as a result

- **Inventory value understated by oversold stock.** 24 products carry negative
  `currentStock` (Shopify permits it), and multiplying by cost subtracted real money —
  one shop's stock-at-cost read Rs 194,475 below what was on its shelves. Clamped at zero
  per product.
- **Negative days of cover.** "-136d", "-57d". A shop that has oversold has no runway to
  count down; now zero, with the stockout badge carrying the signal.
- **Reorder points drifted from their own demand.** `avgDailySales` is rewritten by every
  sync while `reorderPoint` was only refreshed nightly, so the app showed a reorder point
  derived from a demand figure it was no longer displaying. Thirteen products had a
  reorder point *below* their own formula, which no seasonal multiplier can produce.
  `recomputeReorderPoints()` now runs after each sync.

## Legitimate, not bugs

- **Negative `currentStock`** mirrors Shopify, which allows overselling. Status correctly
  reads `stockout`.
- **`reserved > onHand`** on 14 rows. `available = onHand - reserved` is the model, and
  all 14 correspond to oversold products where available is genuinely negative.

## Known legacy inconsistency

Seven purchase orders are `status = received` with no received quantities and no
`actualDeliveryDate`, all created before the receipt path was fixed. They are excluded
from `onOrder` (which only counts `sent`) and from supplier lead-time statistics (which
require `sentAt`), so they affect no calculation — they only look odd on the PO list.
Left alone deliberately: silently rewriting a merchant's purchase-order records to tidy a
display is not the app's call.

Ten `sent`/`received` POs predate `sentAt` and so contribute nothing to lead-time
statistics. Correct behaviour — skipping them beats measuring from the wrong date.

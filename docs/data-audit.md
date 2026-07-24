# Data-point audit

Every figure the app displays, checked against independently computed ground truth on
live production data. Re-run these when changing anything that writes them.

Latest pass: 2026-07-23, 5 shops / 276 products.

## Clean

| Area | Checked |
| --- | --- |
| Per-location stock | `Product.currentStock` equals `sum(ProductLocationStock.onHand)` for every product |
| Rate bounds | No `codReturnRate` outside 0–1, no `avgMargin >= 1`, no negative cost/safety stock/reorder point |
| RTO precedence | `codReturnRate` equals `courierRtoRate → derivedRtoRate → estimatedRtoRate` resolution for all 276; `returnRateSource` agrees with which fields are populated |
| Derived RTO | Per-SKU rates recomputed from `OrderOutcome × OrderLineItem` match the stored values exactly (21/21); every SKU with ≥10 resolved units has one |
| Courier statuses | `CANCELED` correctly excluded from RTO (it is not a return journey); `FULFILLED` classified as dispatched, not delivered |
| Reorder points | Equal to their own formula for every product; the only 6 above it are on the one shop with an active 1.5× seasonal event |
| Forecasts | Every live product has exactly 30/60/90 rows; `net <= gross`; `procurement <= gross`; `pi80Low <= pi80High`; PI80 brackets gross; confidence within 0–1; no past-dated forecast; 90d never below 30d |
| Alerts | No duplicate `dedupeKey`; open stockout alerts exactly match products at or below zero on all five shops (40/40, 6/6, 27/27, 81/81, 15/15); none against archived products |
| Purchase orders | `totalCost` equals the sum of its line totals; no received-above-ordered; no negative quantities; no cross-shop line items |
| Transfers | No received-above-sent; no same-location transfers |
| Suppliers | No negative lead times; no variance recorded against fewer than two receipts |
| Returns | No resolved row missing `resolvedAt`; no quantity below 1; no restocked row without a matched product |
| Return-rate history | `cancelledUnits <= orderCount`; rates within 0–1; `weekStart` always a Monday |
| Cancellation rate | Matches the trailing four weeks of `ReturnRateHistory` for all 37 products carrying one |
| Order data | No `OrderOutcome` without matching `OrderLineItem` or `OrderRegion`; no line quantity below 1 |
| Sales records | No negative quantities, no future dates, all bucketed at midnight UTC, none cross-shop |
| Inventory position | `onOrder` counts only `sent` POs, so the corrupt received-POs below distort no calculation |
| Seasonal events | No inverted date ranges; no non-positive multipliers |

## Fixed as a result

### 2026-07-23

- **"Damaged" counted stock being added back.** The tally was `abs(sum(delta))` over every
  adjustment with reason `damage`. A merchant recorded **+15** with the note "they were
  missing, they came back"; the inventory pipeline and the dashboard both reported 15
  damaged units against a true count of zero. Summing before taking the absolute value
  also netted opposing movements, so 20 damaged plus a later +15 correction displayed 5.
  Now only negative deltas count, via `lib/damage.server.ts` — one helper for both pages,
  which is how the two copies drifted in the first place.
- **COD attrition double-counted cancellations, and the card contradicted itself.**
  `(placed − dispatched) / placed` counts cancelled orders as attrition. On live data the
  card showed a "Never dispatched" tile reading 42 directly above the sentence "9.1% of
  placed COD orders never reached dispatch" — 9.1% of 746 being 68, not 42. It also
  claimed demand was "overstated by roughly that much", but cancelled units are already
  removed from `SalesRecord` by the orders/cancelled webhook, so that correction was
  applied twice. Now `pending / (placed − cancelled)`: 9.2% → 6.0% and 1.3% → 0.5% on the
  two shops with real volume.
- **`firstSoldAt` disagreed with its own demand history.** 24 products had sales and no
  `firstSoldAt`; 4 had one set *later* than their earliest `SalesRecord`. The field bounds
  the demand-variance window, so NULL pads a SKU with zero-demand days it never existed
  for (inflating sigma and safety stock — the exact failure it was added to prevent) and a
  too-late value truncates the window instead. Cause: the order sync wrote the minimum
  date *within the 90-day window*, unconditionally, so every run pushed it forward. It now
  only ever moves the date earlier, and a migration repaired the 28 affected rows.
- **The forecast-accuracy ledger grew a row per run.** `ForecastAccuracy`'s unique key is
  `(productId, horizon, dueAt)`, and `dueAt` carried the time of day — so the nightly
  planning job and every "Recalculate Forecast" click inserted another pending row rather
  than updating that horizon-day's prediction. One shop held three rows per product per
  horizon from three runs minutes apart, and MAPE would later have been averaged across
  them, over-weighting whichever day ran most. `dueAt` is now truncated to midnight UTC;
  the backlog collapsed from 837 rows to 828, exactly 276 products × 3 horizons, with no
  evaluated row lost.

### Earlier

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
- **One product with no `ProductLocationStock` row** on a shop that has a location: "The
  3p Fulfilled Snowboard". Shopify does not report inventory levels at the merchant's own
  locations for third-party-fulfilled items, so the aggregate is all there is.
- **78 orders with `units = 0` and no line items.** Orders whose variants are not tracked
  (deleted from the catalogue, or never synced). They contribute to the order-count
  "Placed" tile and to nothing unit-based, which is correct.

## Known remaining

- **All supplier lead-time statistics are empty.** Every PO on live data has `sentAt =
  NULL`, so both suppliers show `totalPosReceived = 0` and `avgActualLeadTime = NULL`.
  The consequence is that `calculateSafetyStock`'s supply-side term
  (`Z × avgDailySales × sigma_leadTime`) has always evaluated to zero, and lead time
  always falls back to `Product.leadTimeDays`. The formula is correct; the input never
  existed, because the PO list page marked orders sent without stamping `sentAt`. Fixed
  going forward in `lib/purchase-order.server.ts`; historical POs cannot be recovered, so
  the figures will populate as new POs are received.
- **Seven purchase orders are `status = received` with no received quantities and no
  `actualDeliveryDate`** (772 outstanding units). These were still being created by the
  list page's shortcut receipt path until 2026-07-23. They are excluded from `onOrder`
  (which only counts `sent`) and from supplier lead-time statistics (which require
  `sentAt`), so they affect no calculation — they only look odd on the PO list. Left alone
  deliberately: silently rewriting a merchant's purchase-order records to tidy a display
  is not the app's call.
- **`forecastMape` and `forecastBias` are NULL for all 276 products.** The accuracy ledger
  only began recording on 2026-07-22 and the first horizons fall due 2026-08-21, so
  nothing has been scored yet. Until then the Forecast page's "confidence" is a model
  output, not a measured accuracy. Re-check after 2026-08-21.
- **`Product.returnRateSource` schema comment is stale.** It documents
  `"courierify" | "estimated" | "none"`, but `resolveReturnRate` also emits
  `shopify_tracking` (21 rows live) and `courierify_orders`.
- **One order (`#Glamish-15410`) has `OrderRegion.units = 2` but no `OrderLineItem`
  rows.** A single row; the two writers diverged once. Not worth a repair on its own.

## Running the audit

The checks are read-only SQL against the app database. To validate a schema change or a
data repair first, restore a dump into a scratch database and **truncate `Session`
immediately** — see `testing-against-production-data.md` for why that step is not
optional.

-- Two data repairs found by auditing displayed figures against recomputed ground truth.
-- Both are corrections to existing rows; neither changes the schema.

-- 1. Product.firstSoldAt, where it disagrees with the demand history it is supposed to
--    describe.
--
-- This field bounds the demand-variance window. When it is NULL the SKU is padded with
-- zero-demand days it never existed for, inflating sigma and therefore safety stock —
-- the exact failure the field was added to prevent. When it is *later* than the first
-- recorded sale the window is truncated instead, understating sigma.
--
-- On the audited data: 24 products had demand history and no firstSoldAt, and 4 had one
-- set later than their own earliest SalesRecord. Both are repaired by taking the earliest
-- sale actually on record. Products with no sales keep NULL, which is correct — they have
-- never sold, so there is no window to bound.
--
-- Only moves the date earlier, never later, matching the rule the order sync now follows.
UPDATE "Product" p
SET "firstSoldAt" = s.first_sale
FROM (
  SELECT "productId", min(date) AS first_sale
  FROM "SalesRecord"
  WHERE quantity > 0
  GROUP BY "productId"
) s
WHERE s."productId" = p.id
  AND (p."firstSoldAt" IS NULL OR p."firstSoldAt" > s.first_sale);

-- 2. Collapse duplicate ForecastAccuracy rows to one per (product, horizon, due day).
--
-- `dueAt` used to carry the time of day, so it identified an instant rather than a
-- horizon-day. Every re-run of the planning job — or a merchant clicking "Recalculate
-- Forecast" — inserted another pending row instead of updating that day's prediction.
-- One shop had three rows per product per horizon from three runs minutes apart, and MAPE
-- would later have been averaged across them, over-weighting whichever day ran most.
--
-- forecast.server.ts now truncates dueAt to midnight UTC, so future runs collapse on the
-- unique key. This clears the backlog: keep the most recently forecast row in each
-- horizon-day group (it carries the newest prediction) and drop the rest. Scored rows are
-- preserved in preference to unscored ones so no evaluated history is lost.
DELETE FROM "ForecastAccuracy" fa
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY "productId", horizon, date_trunc('day', "dueAt")
           ORDER BY ("evaluatedAt" IS NOT NULL) DESC, "forecastedAt" DESC, id DESC
         ) AS rn
  FROM "ForecastAccuracy"
) ranked
WHERE fa.id = ranked.id AND ranked.rn > 1;

-- Normalise the survivors onto the midnight-UTC boundary the code now writes, so today's
-- rows are updated in place by the next run instead of a second row appearing beside them.
UPDATE "ForecastAccuracy"
SET "dueAt" = date_trunc('day', "dueAt")
WHERE "dueAt" <> date_trunc('day', "dueAt");

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";

/**
 * Guards uninstall/redaction coverage.
 *
 * purgeShopData() has to delete every table that holds tenant data, and the failure mode
 * is silent: add a model, forget the purge, and that shop's rows quietly outlive the
 * uninstall. That is exactly what happened to OrderRegion — added for regional RTO
 * analysis weeks after the purge was written, and it holds customer delivery cities.
 *
 * Rather than trusting a human to remember, this reads the Prisma datamodel and asserts
 * every shop-scoped model is actually referenced in the purge. It needs no database, so
 * it runs in the normal test suite.
 */

const purgeSource = readFileSync(
  new URL("./shop-purge.server.ts", import.meta.url),
  "utf8",
);

const webhookSource = readFileSync(
  new URL("../routes/webhooks.tsx", import.meta.url),
  "utf8",
);

/** Models carrying their own `shop` column — i.e. directly tenant-scoped. */
const shopScopedModels = Prisma.dmmf.datamodel.models
  .filter((m) => m.fields.some((f) => f.name === "shop" && f.kind === "scalar"))
  .map((m) => m.name);

/**
 * Models with no `shop` column, scoped through a parent relation instead. These must
 * still be purged, via a nested `where`.
 */
const RELATION_SCOPED = ["PurchaseOrderItem", "StockTransferItem", "StockCountItem"];

/** `Product` -> `prisma.product` */
const clientProperty = (model: string) =>
  model.charAt(0).toLowerCase() + model.slice(1);

describe("purgeShopData coverage", () => {
  it("finds the shop-scoped models (sanity check on the DMMF query)", () => {
    expect(shopScopedModels).toContain("Product");
    expect(shopScopedModels).toContain("OrderRegion");
    expect(shopScopedModels.length).toBeGreaterThan(10);
  });

  it.each(shopScopedModels)("deletes %s", (model) => {
    expect(purgeSource).toContain(`prisma.${clientProperty(model)}.deleteMany`);
  });

  it.each(RELATION_SCOPED)("deletes %s via its parent relation", (model) => {
    expect(purgeSource).toContain(`prisma.${clientProperty(model)}.deleteMany`);
  });

  /**
   * The purge being correct is worth nothing if the handler declines to call it.
   *
   * `case "APP_UNINSTALLED": if (session) await purgeShopData(shop)` shipped for months.
   * Offline tokens expire and redeliveries arrive after the session row is gone, so
   * `session` was routinely undefined and the shop's rows survived the uninstall — then
   * reinstall + re-sync, both upsert-only, showed the merchant their original data back.
   */
  it("purges on uninstall unconditionally, not only when a session survives", () => {
    const branch = webhookSource.slice(
      webhookSource.indexOf(`case "APP_UNINSTALLED"`),
      webhookSource.indexOf(`case "SHOP_REDACT"`),
    );
    expect(branch).toContain("purgeShopData(shop)");
    expect(branch).not.toMatch(/if\s*\(\s*session\s*\)/);
  });

  /**
   * The dedupe claim is taken before the handler runs. If it is never released on failure,
   * Shopify's retries are all deduped away and a failed uninstall is lost for good.
   */
  it("releases the webhook claim when a handler throws", () => {
    expect(webhookSource).toContain("releaseDelivery(webhookId, topic)");
  });

  /**
   * ...but only for topics that can be re-run. ORDERS_CREATE and ORDERS_CANCELLED apply
   * relative changes outside a transaction, so releasing their claim would let a retry
   * re-count units the failed attempt had already committed — permanently inflating
   * demand, which is the very thing the claim exists to prevent.
   */
  it("does not release the claim for topics that apply relative changes", () => {
    const rerunnable = webhookSource.slice(
      webhookSource.indexOf("const RERUNNABLE_TOPICS"),
      webhookSource.indexOf("async function releaseDelivery"),
    );
    expect(rerunnable).toContain("APP_UNINSTALLED");
    expect(rerunnable).toContain("SHOP_REDACT");
    expect(rerunnable).not.toContain("ORDERS_CREATE");
    expect(rerunnable).not.toContain("ORDERS_CANCELLED");
  });

  it("leaves nothing tenant-scoped unaccounted for", () => {
    const covered = new Set([...shopScopedModels, ...RELATION_SCOPED]);
    const uncovered = Prisma.dmmf.datamodel.models
      .map((m) => m.name)
      .filter((name) => !covered.has(name));

    // Anything here is a model with no shop column and no parent scoping. If a new one
    // appears, decide deliberately whether it holds tenant data.
    expect(uncovered).toEqual([]);
  });
});

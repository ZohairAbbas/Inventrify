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

/** Models carrying their own `shop` column — i.e. directly tenant-scoped. */
const shopScopedModels = Prisma.dmmf.datamodel.models
  .filter((m) => m.fields.some((f) => f.name === "shop" && f.kind === "scalar"))
  .map((m) => m.name);

/**
 * Models with no `shop` column, scoped through a parent relation instead. These must
 * still be purged, via a nested `where`.
 */
const RELATION_SCOPED = ["PurchaseOrderItem", "StockTransferItem"];

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

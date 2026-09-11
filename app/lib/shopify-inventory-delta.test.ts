import { describe, expect, it } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { applyShopifyInventoryDelta } from "./shopify-sync.server";

/**
 * Guards the shape of the inventoryAdjustQuantities call.
 *
 * API 2026-04 made `changeFromQuantity` and an `@idempotent` key mandatory. The DB tests
 * mock Shopify by matching on the operation name alone, so they kept passing while every
 * real receipt, adjustment and transfer was rejected with "InventoryChangeInput must
 * include the following argument: changeFromQuantity". These assertions look at what is
 * actually sent.
 */

type Call = { query: string; variables: Record<string, unknown> };

function fakeAdmin(responses: { status: number; body?: unknown }[]) {
  const calls: Call[] = [];
  const admin = {
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: opts?.variables ?? {} });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      return {
        status: next.status,
        ok: next.status >= 200 && next.status < 300,
        json: async () => next.body,
      };
    },
  } as unknown as AdminApiContext;
  return { admin, calls };
}

const success = {
  status: 200,
  body: { data: { inventoryAdjustQuantities: { userErrors: [] } } },
};

describe("applyShopifyInventoryDelta", () => {
  it("sends changeFromQuantity on every change and an idempotency key", async () => {
    const { admin, calls } = fakeAdmin([success]);

    const res = await applyShopifyInventoryDelta(
      admin,
      "gid://shopify/InventoryItem/1",
      12,
      "gid://shopify/Location/1",
    );

    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toMatch(/@idempotent\(key: \$idempotencyKey\)/);

    const input = calls[0].variables.input as { changes: Record<string, unknown>[] };
    for (const change of input.changes) {
      expect(change).toHaveProperty("changeFromQuantity", null);
    }
    expect(calls[0].variables.idempotencyKey).toEqual(expect.any(String));
    expect((calls[0].variables.idempotencyKey as string).length).toBeGreaterThan(0);
  });

  it("reuses the same idempotency key when a failed attempt is retried", async () => {
    const { admin, calls } = fakeAdmin([{ status: 503 }, success]);

    const res = await applyShopifyInventoryDelta(
      admin,
      "gid://shopify/InventoryItem/1",
      -3,
      "gid://shopify/Location/1",
    );

    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[1].variables.idempotencyKey).toBe(calls[0].variables.idempotencyKey);
  });

  it("uses a fresh key for each separate movement", async () => {
    const { admin, calls } = fakeAdmin([success]);

    await applyShopifyInventoryDelta(admin, "gid://shopify/InventoryItem/1", 1, "gid://shopify/Location/1");
    await applyShopifyInventoryDelta(admin, "gid://shopify/InventoryItem/1", 1, "gid://shopify/Location/1");

    expect(calls[0].variables.idempotencyKey).not.toBe(calls[1].variables.idempotencyKey);
  });
});

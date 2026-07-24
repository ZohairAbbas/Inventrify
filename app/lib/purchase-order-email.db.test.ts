/**
 * Purchase-order email: guards, escaping, and when delivery is recorded.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let sendResult: { data?: unknown; error?: { message: string } | null } = {
  data: { id: "test" },
  error: null,
};
const sendSpy = vi.fn(async (_payload: Record<string, unknown>) => sendResult);
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendSpy };
  },
}));

process.env.RESEND_API_KEY = "test-key";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { emailPurchaseOrderToSupplier } = await import("./purchase-order-email.server");
const { default: prisma } = await import("../db.server");

const SHOP = "po-email-test.myshopify.com";
const RUN = Date.now().toString(36);
let seq = 0;

async function makePo(opts: {
  supplier?: { name: string; email: string | null; contactName?: string } | null;
  productTitle?: string;
  notes?: string | null;
  items?: { qty: number; cost: number }[];
} = {}) {
  // Unique per call and per run. A bare counter collided with rows left by an earlier
  // run of the suite against the same scratch database.
  const n = `${RUN}-${seq++}`;
  const supplier =
    opts.supplier === null
      ? null
      : await prisma.supplier.create({
          data: {
            shop: SHOP,
            name: opts.supplier?.name ?? "Acme Supplies",
            // `??` would treat an explicit null as "not supplied" and hand back the
            // default address — which is exactly the case the no-address test exercises.
            email:
              opts.supplier && "email" in opts.supplier
                ? opts.supplier.email
                : "supplier@example.com",
            contactName: opts.supplier?.contactName,
          },
        });

  const product = await prisma.product.create({
    data: {
      id: `gid://shopify/ProductVariant/po-${n}`,
      shop: SHOP,
      productGid: "gid://shopify/Product/1",
      title: opts.productTitle ?? "Kurta",
      sku: `SKU-${n}`,
    },
  });

  const po = await prisma.purchaseOrder.create({
    data: {
      shop: SHOP,
      poNumber: `PO-TEST-${n}`,
      status: "draft",
      supplierId: supplier?.id ?? null,
      notes: opts.notes ?? null,
      items: {
        create: (opts.items ?? [{ qty: 10, cost: 250 }]).map((i) => ({
          productId: product.id,
          quantityOrdered: i.qty,
          unitCost: i.cost,
        })),
      },
    },
  });
  return po;
}

const lastHtml = () => String((sendSpy.mock.calls.at(-1)?.[0] as { html: string }).html);

beforeEach(async () => {
  sendResult = { data: { id: "test" }, error: null };
  sendSpy.mockClear();
  await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { shop: SHOP } } });
  await prisma.purchaseOrder.deleteMany({ where: { shop: SHOP } });
  await prisma.product.deleteMany({ where: { shop: SHOP } });
  await prisma.supplier.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.create({
    data: { shop: SHOP, currency: "PKR", notificationEmail: "merchant@example.com" },
  });
});

describe("guards", () => {
  it("refuses a PO with no supplier, and explains what to do", async () => {
    const po = await makePo({ supplier: null });
    const r = await emailPurchaseOrderToSupplier(po.id, SHOP);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/assign a supplier/i);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses when the supplier has no address, naming the supplier", async () => {
    const po = await makePo({ supplier: { name: "Karachi Textiles", email: null } });
    const r = await emailPurchaseOrderToSupplier(po.id, SHOP);
    expect(r.error).toContain("Karachi Textiles");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses an obviously invalid address rather than letting the provider fail", async () => {
    const po = await makePo({ supplier: { name: "Acme", email: "not-an-email" } });
    const r = await emailPurchaseOrderToSupplier(po.id, SHOP);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid/i);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses an empty order", async () => {
    const po = await makePo({ items: [] });
    const r = await emailPurchaseOrderToSupplier(po.id, SHOP);
    expect(r.error).toMatch(/no line items/i);
  });

  it("will not send another shop's purchase order", async () => {
    const po = await makePo();
    const r = await emailPurchaseOrderToSupplier(po.id, "someone-else.myshopify.com");
    expect(r.ok).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("delivery is only recorded when it happened", () => {
  it("records the address after the provider accepts", async () => {
    const po = await makePo({ supplier: { name: "Acme", email: "ops@acme.test" } });
    const r = await emailPurchaseOrderToSupplier(po.id, SHOP);

    expect(r.ok).toBe(true);
    const saved = await prisma.purchaseOrder.findUnique({ where: { id: po.id } });
    expect(saved?.emailedTo).toBe("ops@acme.test");
    expect(saved?.emailedAt).not.toBeNull();
  });

  it("records nothing when the provider rejects it", async () => {
    sendResult = { error: { message: "domain not verified" } };
    const po = await makePo();
    const r = await emailPurchaseOrderToSupplier(po.id, SHOP);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("domain not verified");
    const saved = await prisma.purchaseOrder.findUnique({ where: { id: po.id } });
    // A failed send that looked delivered would be worse than an error.
    expect(saved?.emailedAt).toBeNull();
  });

  it("leaves sentAt alone — emailing is not the merchant's status change", async () => {
    const po = await makePo();
    await emailPurchaseOrderToSupplier(po.id, SHOP);
    const saved = await prisma.purchaseOrder.findUnique({ where: { id: po.id } });
    expect(saved?.sentAt).toBeNull();
    expect(saved?.status).toBe("draft");
  });
});

describe("message contents", () => {
  it("escapes merchant-controlled text", async () => {
    // Product titles and notes are free text and this is sent to a third party.
    const po = await makePo({
      productTitle: '<script>alert("xss")</script> Kurta',
      notes: "Ship via <b>air</b> & confirm",
    });
    await emailPurchaseOrderToSupplier(po.id, SHOP);

    const html = lastHtml();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("totals the lines rather than trusting a stored figure", async () => {
    const po = await makePo({ items: [{ qty: 3, cost: 100 }, { qty: 2, cost: 50 }] });
    // Deliberately corrupt the cached total; the supplier must still see the truth.
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { totalCost: 999999 } });

    await emailPurchaseOrderToSupplier(po.id, SHOP);
    const html = lastHtml();
    expect(html).not.toContain("999,999");
    expect(html).toContain("400"); // 3x100 + 2x50
    expect(html).toContain("5"); // total units
  });

  it("addresses a named contact when there is one", async () => {
    const po = await makePo({
      supplier: { name: "Acme", email: "ops@acme.test", contactName: "Bilal" },
    });
    await emailPurchaseOrderToSupplier(po.id, SHOP);
    expect(lastHtml()).toContain("Hello Bilal,");
  });

  it("sets reply-to to the merchant, not the app", async () => {
    const po = await makePo();
    await emailPurchaseOrderToSupplier(po.id, SHOP);
    const payload = sendSpy.mock.calls.at(-1)?.[0] as { replyTo?: string; subject: string };
    expect(payload.replyTo).toBe("merchant@example.com");
    expect(payload.subject).toContain("PO-TEST-");
  });
});

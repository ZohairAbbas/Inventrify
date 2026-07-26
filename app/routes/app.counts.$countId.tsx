import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatDate } from "../lib/format";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  addAllStockedItems,
  addCountItem,
  cancelStockCount,
  postStockCount,
  removeCountItem,
  setCountStatus,
  setCountedQuantity,
} from "../lib/stock-count.server";
import { Button, Card, PageHead, Pill, ScanInput, type DataTableColumn } from "../design";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const count = await prisma.stockCount.findFirst({
    where: { id: params.countId, shop: session.shop },
    include: {
      location: { select: { name: true } },
      items: {
        include: { product: { select: { title: true, variantTitle: true, sku: true, barcode: true } } },
        orderBy: { id: "asc" },
      },
    },
  });
  if (!count) throw new Response("Not found", { status: 404 });
  return { count };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const countId = params.countId as string;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "add_product": {
      const r = await addCountItem(shop, countId, formData.get("productId") as string);
      if (!r.ok) return { ok: false as const, intent, error: r.error ?? "Could not add" };
      return { ok: true as const, intent, message: r.alreadyPresent ? "Already on the count" : "Product added" };
    }
    case "add_all": {
      const r = await addAllStockedItems(shop, countId);
      if (!r.ok) return { ok: false as const, intent, error: r.error ?? "Could not add" };
      return { ok: true as const, intent, message: `${r.added} product${r.added === 1 ? "" : "s"} added${r.truncated ? " (list truncated — count in smaller passes)" : ""}` };
    }
    case "set_qty": {
      const raw = formData.get("countedQty") as string;
      const counted = raw === "" ? null : parseInt(raw, 10);
      if (counted !== null && Number.isNaN(counted)) return { ok: false as const, intent, error: "Enter a whole number" };
      const r = await setCountedQuantity(shop, countId, formData.get("itemId") as string, counted);
      if (!r.ok) return { ok: false as const, intent, error: r.error ?? "Could not save" };
      return { ok: true as const, intent, silent: true };
    }
    case "remove": {
      const r = await removeCountItem(shop, countId, formData.get("itemId") as string);
      if (!r.ok) return { ok: false as const, intent, error: r.error ?? "Could not remove" };
      return { ok: true as const, intent, silent: true };
    }
    case "to_review":
      return withStatus(await setCountStatus(shop, countId, "review"), intent, "Ready to review");
    case "to_counting":
      return withStatus(await setCountStatus(shop, countId, "counting"), intent, "Back to counting");
    case "cancel":
      return withStatus(await cancelStockCount(shop, countId), intent, "Count cancelled");
    case "post": {
      const r = await postStockCount(admin, shop, countId);
      if (!r.ok) return { ok: false as const, intent, error: r.error ?? "Could not post" };
      const warn = r.shopifyWarnings.length > 0 ? ` (${r.shopifyWarnings.length} Shopify sync warning${r.shopifyWarnings.length === 1 ? "" : "s"})` : "";
      const failed = r.failures.length > 0 ? ` · ${r.failures.length} line${r.failures.length === 1 ? "" : "s"} failed` : "";
      return { ok: true as const, intent, message: `Posted — ${r.applied} adjusted, ${r.unchanged} unchanged, ${r.uncounted} uncounted${failed}${warn}` };
    }
    default:
      return { ok: false as const, intent, error: "Unknown action" };
  }
};

function withStatus(r: { ok: boolean; error?: string }, intent: string, message: string) {
  return r.ok ? { ok: true as const, intent, message } : { ok: false as const, intent, error: r.error ?? "Could not update" };
}

type Item = Awaited<ReturnType<typeof loader>>["count"]["items"][number];

function variance(item: Item): number | null {
  return item.countedQty === null ? null : item.countedQty - item.snapshotQty;
}

export default function CountDetail() {
  const { count } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const { timezone = "UTC", theme = "emerald" } = useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  // Local echo of counted quantities so typing stays instant; each blur persists.
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>(
    Object.fromEntries(count.items.map((i) => [i.id, i.countedQty === null ? "" : String(i.countedQty)])),
  );

  useEffect(() => {
    const d = fetcher.data;
    if (!d || (d.ok && "silent" in d && d.silent)) return;
    if (d.ok) shopify.toast.show("message" in d ? (d.message as string) : "Done");
    else shopify.toast.show(d.error || "Something went wrong", { isError: true });
  }, [fetcher.data, shopify]);

  const isBusy = fetcher.state !== "idle";
  const editable = count.status === "counting";
  const reviewing = count.status === "review";
  const closed = count.status === "posted" || count.status === "cancelled";

  const countedLines = count.items.filter((i) => i.countedQty !== null).length;
  const withVariance = count.items.filter((i) => variance(i) !== null && variance(i) !== 0).length;

  const submit = (data: Record<string, string>) => fetcher.submit(data, { method: "POST" });

  const persistQty = (item: Item) => {
    const draft = qtyDraft[item.id] ?? "";
    const current = item.countedQty === null ? "" : String(item.countedQty);
    if (draft === current) return; // nothing changed
    submit({ intent: "set_qty", itemId: item.id, countedQty: draft });
  };

  const statusPill = closed
    ? count.status === "posted"
      ? { bg: "var(--inv-status-healthy-bg)", fg: "var(--inv-status-healthy-fg)", label: "Posted" }
      : { bg: "var(--inv-divider-3)", fg: "var(--inv-text-2)", label: "Cancelled" }
    : reviewing
      ? { bg: "var(--inv-accent-soft)", fg: "var(--inv-accent)", label: "In review" }
      : { bg: "var(--inv-status-low-bg)", fg: "var(--inv-status-low-fg)", label: "Counting" };

  // In a blind count the system quantity and variance stay hidden until review, so the
  // number entered is the shelf's, not a nudge toward what the system expected.
  const showSystem = !count.blind || reviewing || closed;

  const columns: DataTableColumn[] = [
    { header: "Product", width: "2.2fr" },
    { header: "SKU", width: "1fr" },
    ...(showSystem ? [{ header: "System", width: ".8fr", align: "right" as const }] : []),
    { header: "Counted", width: "1fr", align: "right" as const },
    ...(showSystem ? [{ header: "Variance", width: ".9fr", align: "right" as const }] : []),
    ...(editable ? [{ header: "", width: ".6fr", align: "right" as const }] : []),
  ];

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title={`Count ${count.countNumber}`} />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead
          eyebrow="Cycle count"
          title={count.countNumber}
          right={<Pill label={statusPill.label} bg={statusPill.bg} fg={statusPill.fg} />}
        />

        <Card style={{ marginBottom: "14px" }}>
          <div style={{ display: "flex", gap: "28px", flexWrap: "wrap", fontSize: "13px" }}>
            <div>
              <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "3px" }}>Location</div>
              {count.location.name}
            </div>
            <div>
              <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "3px" }}>Opened</div>
              {formatDate(count.createdAt, timezone)}
            </div>
            <div>
              <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "3px" }}>Progress</div>
              {countedLines} / {count.items.length} counted
            </div>
            <div>
              <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "3px" }}>Mode</div>
              {count.blind ? "Blind" : "Open"}
            </div>
            {count.notes && (
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "3px" }}>Notes</div>
                {count.notes}
              </div>
            )}
          </div>
        </Card>

        {editable && (
          <Card style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "10px" }}>Add products to count</div>
            <ScanInput
              // The scanner already resolved the code to a product (shop-scoped, via
              // /api/products/scan), so add that product by id. Re-resolving the raw code
              // server-side could land on a different product if one SKU happens to equal
              // another's barcode; addCountItem re-validates the id against this shop.
              hint="Scan an item to add it and snapshot its recorded quantity. A scanner — or your phone — types the code and presses Enter."
              onScan={(p) => submit({ intent: "add_product", productId: p.id })}
            />
            <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" }}>
              <Button variant="ghost" disabled={isBusy} onClick={() => {
                if (window.confirm(`Add every product currently stocked at ${count.location.name}? Their recorded quantities are snapshot now.`)) submit({ intent: "add_all" });
              }}>
                Add all stocked here
              </Button>
            </div>
          </Card>
        )}

        {count.items.length === 0 ? (
          <Card padding="40px 24px">
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>Nothing on this count yet</div>
              <div style={{ fontSize: "13px", color: "var(--inv-muted)" }}>Scan an item, or add everything stocked at this location.</div>
            </div>
          </Card>
        ) : (
          <div style={{ background: "#fff", border: "1px solid var(--inv-border)", borderRadius: "14px", overflow: "hidden", marginBottom: "16px" }}>
            <div style={{ display: "grid", gridTemplateColumns: columns.map((c) => c.width).join(" "), gap: "12px", padding: "10px 16px", background: "var(--inv-subtle)", borderBottom: "1px solid var(--inv-divider)", fontSize: "11px", color: "var(--inv-muted)", textTransform: "uppercase", letterSpacing: ".4px" }}>
              {columns.map((c, i) => (<div key={i} style={{ textAlign: c.align ?? "left" }}>{c.header}</div>))}
            </div>
            {count.items.map((item) => {
              const v = variance(item);
              const name = item.product.variantTitle ? `${item.product.title} — ${item.product.variantTitle}` : item.product.title;
              return (
                <div key={item.id} style={{ display: "grid", gridTemplateColumns: columns.map((c) => c.width).join(" "), gap: "12px", padding: "10px 16px", borderBottom: "1px solid var(--inv-divider)", alignItems: "center", fontSize: "13px" }}>
                  <div style={{ minWidth: 0, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
                  <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12px", color: "var(--inv-text-2)" }}>{item.product.sku ?? "—"}</div>
                  {showSystem && <div style={{ textAlign: "right", fontFamily: "var(--inv-font-mono)" }}>{item.snapshotQty}</div>}
                  <div style={{ textAlign: "right" }}>
                    {editable || reviewing ? (
                      <input
                        type="number"
                        min={0}
                        inputMode="numeric"
                        value={qtyDraft[item.id] ?? ""}
                        onChange={(e) => setQtyDraft((d) => ({ ...d, [item.id]: e.target.value }))}
                        onBlur={() => persistQty(item)}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        style={{ width: "80px", height: "32px", textAlign: "right", border: "1px solid var(--inv-input-border-2)", borderRadius: "8px", padding: "0 8px", fontFamily: "var(--inv-font-mono)" }}
                      />
                    ) : (
                      <span style={{ fontFamily: "var(--inv-font-mono)" }}>{item.countedQty ?? "—"}</span>
                    )}
                  </div>
                  {showSystem && (
                    <div style={{ textAlign: "right", fontFamily: "var(--inv-font-mono)", fontWeight: 600, color: v === null ? "var(--inv-faint)" : v === 0 ? "var(--inv-muted)" : v > 0 ? "var(--inv-status-healthy-fg)" : "var(--inv-status-critical-fg)" }}>
                      {v === null ? "—" : v > 0 ? `+${v}` : v}
                    </div>
                  )}
                  {editable && (
                    <div style={{ textAlign: "right" }}>
                      <button onClick={() => submit({ intent: "remove", itemId: item.id })} disabled={isBusy}
                        style={{ fontSize: "11px", border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-status-stockout-fg)", padding: "4px 8px", borderRadius: "7px", cursor: "pointer" }}>
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {reviewing && count.items.length > 0 && (
          <Card padding="12px 16px" style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "12.5px", color: "var(--inv-text-2)", lineHeight: 1.5 }}>
              {withVariance === 0 ? (
                <>Everything counted matches the system. Posting records the count and moves no stock.</>
              ) : (
                <>
                  <b>{withVariance}</b> line{withVariance === 1 ? "" : "s"} differ from the system. Posting applies each
                  difference as a stock adjustment and pushes it to Shopify. Uncounted lines are left untouched.
                </>
              )}
            </div>
          </Card>
        )}

        <div style={{ display: "flex", gap: "9px", flexWrap: "wrap" }}>
          <Link to="/app/counts"><Button variant="ghost">← All counts</Button></Link>
          {editable && (
            <Button variant="primary" disabled={isBusy || count.items.length === 0} onClick={() => submit({ intent: "to_review" })}>
              Review {countedLines} counted →
            </Button>
          )}
          {reviewing && (
            <>
              <Button variant="ghost" disabled={isBusy} onClick={() => submit({ intent: "to_counting" })}>← Back to counting</Button>
              <Button variant="primary" disabled={isBusy} onClick={() => {
                if (window.confirm(`Post this count? ${withVariance} adjustment${withVariance === 1 ? "" : "s"} will be applied to stock and pushed to Shopify.`)) submit({ intent: "post" });
              }}>
                Post count
              </Button>
            </>
          )}
          {!closed && (
            <button
              onClick={() => { if (window.confirm("Cancel this count? It cannot be reopened.")) submit({ intent: "cancel" }); }}
              disabled={isBusy}
              style={{ marginLeft: "auto", fontSize: "12px", border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-status-stockout-fg)", padding: "8px 14px", borderRadius: "10px", cursor: "pointer" }}
            >
              Cancel count
            </button>
          )}
          {count.status === "posted" && (
            <span style={{ marginLeft: "auto", fontSize: "12.5px", color: "var(--inv-status-healthy-fg)", fontWeight: 500, alignSelf: "center" }}>
              ✓ Posted {count.postedAt ? formatDate(count.postedAt, timezone) : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

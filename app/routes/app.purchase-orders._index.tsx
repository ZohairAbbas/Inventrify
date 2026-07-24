import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useNavigation, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatCurrency, formatDate } from "../lib/format";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Button, Card, DataTable, FilterChips, PageHead, Pagination, POStatusPill, type DataTableColumn } from "../design";
import { parsePageRequest, parseSearch, resolvePage } from "../lib/pagination";
import { useListParams } from "../lib/use-list-params";
import { markPurchaseOrderSent, receivePurchaseOrder } from "../lib/purchase-order.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") ?? "all";
  const search = parseSearch(url.searchParams);
  const pageRequest = parsePageRequest(url.searchParams);

  // Status and search both narrow in SQL. The tab used to filter an already-loaded
  // array, so switching to "Draft" still paid for every received PO ever raised.
  const where = {
    shop: session.shop,
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(search
      ? {
          OR: [
            { poNumber: { contains: search, mode: "insensitive" as const } },
            { supplier: { name: { contains: search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const page = resolvePage(pageRequest, await prisma.purchaseOrder.count({ where }));

  const pos = await prisma.purchaseOrder.findMany({
    where,
    include: {
      supplier: { select: { name: true } },
      // Only the quantities are read (line count, and the units in the receive
      // confirmation), so the product join is dropped — it fetched a title per line
      // that this page never rendered.
      items: { select: { quantityOrdered: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: page.skip,
    take: page.take,
  });

  return { pos, page, statusFilter, search };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const poId = formData.get("poId") as string;

  if (!poId) return { ok: false as const, error: "No purchase order selected", message: "" };

  // Both lifecycle actions go through lib/purchase-order.server so this quick-action
  // list behaves identically to the detail page. It previously incremented
  // Product.currentStock directly, which left per-location stock and Shopify untouched
  // and recorded neither received quantities nor a delivery date — the receipt then
  // vanished at the next sync, which recomputes currentStock from per-location on-hand.
  if (intent === "mark_received") {
    const result = await receivePurchaseOrder(admin, shop, poId);
    if (!result.ok) {
      return { ok: false as const, error: result.error ?? "Could not receive", message: "" };
    }

    const problems = [
      ...result.lines.filter((l) => l.error).map((l) => l.error as string),
      ...result.shopifyWarnings,
    ];
    return {
      ok: true as const,
      error: problems.length > 0 ? problems.join("; ") : "",
      message: "Received in full — stock updated",
    };
  }

  if (intent === "mark_sent") {
    const result = await markPurchaseOrderSent(shop, poId);
    if (!result.ok) {
      return { ok: false as const, error: result.error ?? "Could not mark sent", message: "" };
    }
    return { ok: true as const, error: "", message: "Marked as sent to supplier" };
  }

  if (intent === "delete") {
    const { count } = await prisma.purchaseOrder.deleteMany({
      where: { id: poId, shop, status: "draft" },
    });
    if (count === 0) {
      return { ok: false as const, error: "Only draft purchase orders can be deleted", message: "" };
    }
    return { ok: true as const, error: "", message: "Draft purchase order deleted" };
  }

  return { ok: false as const, error: "Unknown action", message: "" };
};

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "received", label: "Received" },
];

export default function PurchaseOrders() {
  const { pos, page, statusFilter } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const { searchInput, setSearchInput, setFilter, setPage, setPageSize } = useListParams();
  const { timezone = "UTC", currency = "USD", theme = "emerald" } =
    useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  useEffect(() => {
    const d = fetcher.data;
    if (!d) return;
    if (!d.ok) {
      shopify.toast.show(d.error || "Something went wrong", { isError: true });
      return;
    }
    // A receipt can succeed overall while individual lines fail to move stock; say so
    // rather than reporting an unqualified success.
    if (d.error) shopify.toast.show(`${d.message} — but: ${d.error}`, { isError: true });
    else shopify.toast.show(d.message);
  }, [fetcher.data, shopify]);

  const submit = (data: Record<string, string>) => fetcher.submit(data, { method: "POST" });

  const columns: DataTableColumn[] = [
    { header: "PO number", width: "1.4fr" },
    { header: "Supplier", width: "1.2fr" },
    { header: "Items", width: ".6fr" },
    { header: "Total", width: "1.2fr" },
    { header: "Status", width: ".9fr" },
    { header: "Created", width: "1fr" },
    { header: "", width: "2fr", align: "right" },
  ];

  const rows = pos.map((po) => ({
    key: po.id,
    onClick: () => navigate(`/app/purchase-orders/${po.id}`),
    cells: [
      <span key="num" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12.5px", fontWeight: 600, color: "var(--inv-accent)" }}>
        {po.poNumber}
      </span>,
      <span key="supplier">{po.supplier?.name ?? "—"}</span>,
      <span key="items" style={{ fontFamily: "var(--inv-font-mono)" }}>{po.items.length}</span>,
      <span key="total" style={{ fontFamily: "var(--inv-font-mono)" }}>{formatCurrency(po.totalCost, currency)}</span>,
      <POStatusPill key="status" status={po.status} />,
      <span key="created" style={{ color: "var(--inv-muted)", fontSize: "12px" }}>{formatDate(po.createdAt, timezone)}</span>,
      <div key="actions" style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }} onClick={(e) => e.stopPropagation()}>
        <Link to={`/app/purchase-orders/${po.id}`}>
          <button style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}>
            View
          </button>
        </Link>
        {po.status === "draft" && (
          <button
            onClick={() => submit({ intent: "mark_sent", poId: po.id })}
            disabled={fetcher.state !== "idle"}
            style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}
          >
            Mark sent
          </button>
        )}
        {po.status === "sent" && (
          <button
            // Receives every line in full. Anything partial belongs on the detail page,
            // where per-line quantities can be entered.
            onClick={() => {
              const units = po.items.reduce((s, i) => s + i.quantityOrdered, 0);
              if (
                window.confirm(
                  `Receive ${po.poNumber} in full?\n\n${units} unit${units === 1 ? "" : "s"} across ${po.items.length} line${po.items.length === 1 ? "" : "s"} will be added to stock and pushed to Shopify.\n\nFor a partial delivery, open the PO instead.`,
                )
              ) {
                submit({ intent: "mark_received", poId: po.id });
              }
            }}
            disabled={fetcher.state !== "idle"}
            style={{ fontSize: "11.5px", border: "none", background: "var(--inv-ink)", color: "#fff", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}
          >
            Mark received
          </button>
        )}
        {po.status === "draft" && (
          <button
            onClick={() => {
              if (window.confirm(`Delete draft ${po.poNumber}? This cannot be undone.`)) {
                submit({ intent: "delete", poId: po.id });
              }
            }}
            disabled={fetcher.state !== "idle"}
            style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-status-stockout-fg)", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}
          >
            Delete
          </button>
        )}
      </div>,
    ],
  }));

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Purchase Orders" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead
          eyebrow="draft → sent → received"
          title="Purchase Orders"
          right={<Button variant="primary" onClick={() => navigate("/app/purchase-orders/new")}>+ Create PO</Button>}
        />

        <div
          style={{
            display: "flex", alignItems: "center", gap: "10px",
            marginBottom: "12px", flexWrap: "wrap",
          }}
        >
          <div
            style={{
              flex: 1, minWidth: "220px", display: "flex", alignItems: "center", gap: "9px",
              background: "#fff", border: "1px solid var(--inv-input-border)",
              borderRadius: "10px", padding: "0 12px", height: "38px",
            }}
          >
            <span style={{ color: "var(--inv-muted)" }}>⌕</span>
            <input
              value={searchInput}
              placeholder="Search PO number or supplier"
              onChange={(e) => setSearchInput(e.target.value)}
              style={{ border: "none", outline: "none", flex: 1, fontSize: "13px", background: "transparent", color: "var(--inv-ink)" }}
            />
          </div>
        </div>

        <FilterChips options={STATUS_TABS} active={statusFilter} onChange={(v) => setFilter("status", v)} />

        {pos.length === 0 ? (
          <Card padding="40px 24px">
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>
                {page.totalItems === 0 && !searchInput && statusFilter === "all"
                  ? "No purchase orders yet"
                  : "No purchase orders match these filters"}
              </div>
              <div style={{ fontSize: "13px", color: "var(--inv-muted)", marginBottom: "16px" }}>
                Create a PO from reorder suggestions on the Dashboard, or manually here.
              </div>
              <Button variant="primary" onClick={() => navigate("/app/purchase-orders/new")}>Create PO</Button>
            </div>
          </Card>
        ) : (
          <>
            <DataTable columns={columns} rows={rows} />
            <Pagination
              page={page}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              itemLabel="purchase orders"
              busy={navigation.state === "loading"}
            />
          </>
        )}
      </div>
    </div>
  );
}

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useNavigation, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Button, Card, DataTable, PageHead, Pagination, type DataTableColumn } from "../design";
import { parsePageRequest, parseSearch, resolvePage } from "../lib/pagination";
import { useListParams } from "../lib/use-list-params";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = parseSearch(url.searchParams);
  const pageRequest = parsePageRequest(url.searchParams);

  const where = {
    shop: session.shop,
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { contactName: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const page = resolvePage(pageRequest, await prisma.supplier.count({ where }));

  const suppliers = await prisma.supplier.findMany({
    where,
    include: { _count: { select: { products: true, purchaseOrders: true } } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    skip: page.skip,
    take: page.take,
  });

  return { suppliers, page };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const supplierId = formData.get("supplierId") as string;

  if (!supplierId) return { ok: false as const, error: "No supplier selected" };

  // Scoped before anything is touched. `supplier.delete({ where: { id } })` took the id
  // straight from the form with no shop check, so a crafted POST could delete another
  // tenant's supplier — the updateMany calls beside it were already scoped, which is
  // what makes the gap easy to miss on a read.
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, shop: session.shop },
    select: { id: true },
  });
  if (!supplier) return { ok: false as const, error: "Supplier not found" };

  // Unlink first: products and POs reference the supplier, and the FK would otherwise
  // reject the delete. Wrapped so a failure part-way cannot leave products orphaned from
  // a supplier that still exists.
  await prisma.$transaction([
    prisma.product.updateMany({
      where: { shop: session.shop, supplierId: supplier.id },
      data: { supplierId: null },
    }),
    prisma.purchaseOrder.updateMany({
      where: { shop: session.shop, supplierId: supplier.id },
      data: { supplierId: null },
    }),
    prisma.supplier.delete({ where: { id: supplier.id } }),
  ]);

  return { ok: true as const, error: "" };
};

export default function Suppliers() {
  const { suppliers, page } = useLoaderData<typeof loader>();
  const { theme = "emerald" } = useRouteLoaderData<typeof appLoader>("routes/app") ?? {};
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const { searchInput, setSearchInput, setPage, setPageSize } = useListParams();

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) shopify.toast.show("Supplier deleted");
    else shopify.toast.show(fetcher.data.error || "Could not delete supplier", { isError: true });
  }, [fetcher.data, shopify]);

  const columns: DataTableColumn[] = [
    { header: "Name", width: "1.3fr" },
    { header: "Contact", width: "1fr" },
    { header: "Email", width: "1.5fr" },
    { header: "Lead", width: ".7fr", align: "right" },
    { header: "On-time", width: "1.4fr" },
    { header: "Linked", width: "1.2fr", align: "right" },
    { header: "", width: "1.4fr", align: "right" },
  ];

  const rows = suppliers.map((s) => {
    const onTimePct =
      s.avgActualLeadTime != null && s.totalPosReceived > 0
        ? Math.max(0, Math.min(100, Math.round((s.leadTimeDays / s.avgActualLeadTime) * 100)))
        : null;

    return {
      key: s.id,
      cells: [
        <Link key="name" to={`/app/suppliers/${s.id}`} style={{ fontWeight: 600, color: "var(--inv-accent)" }}>
          {s.name}
        </Link>,
        <span key="contact">{s.contactName ?? "—"}</span>,
        <span key="email" style={{ color: "var(--inv-text-2)", fontSize: "12.5px" }}>{s.email ?? "—"}</span>,
        <span key="lead" style={{ fontFamily: "var(--inv-font-mono)" }}>{s.leadTimeDays}d</span>,
        onTimePct != null ? (
          <div key="ontime" style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%" }}>
            <div style={{ flex: 1, height: "6px", background: "var(--inv-divider-3)", borderRadius: "4px", overflow: "hidden", maxWidth: "90px" }}>
              <div style={{ width: `${onTimePct}%`, height: "100%", background: "var(--inv-accent)" }} />
            </div>
            <span style={{ fontFamily: "var(--inv-font-mono)", fontSize: "11.5px", color: "var(--inv-text-2)" }}>{onTimePct}%</span>
          </div>
        ) : (
          <span key="ontime" style={{ color: "var(--inv-faint)", fontSize: "11.5px" }}>no data</span>
        ),
        <span key="linked" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "11.5px", color: "var(--inv-text-2)" }}>
          {s._count.products}p · {s._count.purchaseOrders} PO
        </span>,
        <div key="actions" style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
          <Link to={`/app/suppliers/${s.id}`}>
            <button style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}>
              Edit
            </button>
          </Link>
          <button
            onClick={() => fetcher.submit({ supplierId: s.id }, { method: "POST" })}
            disabled={fetcher.state !== "idle"}
            style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-status-stockout-fg)", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}
          >
            Delete
          </button>
        </div>,
      ],
    };
  });

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Suppliers" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead
          eyebrow="Lead times feed forecasting"
          title="Suppliers"
          right={<Button variant="primary" onClick={() => navigate("/app/suppliers/new")}>+ Add supplier</Button>}
        />

        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px", flexWrap: "wrap" }}>
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
              placeholder="Search name, contact or email"
              onChange={(e) => setSearchInput(e.target.value)}
              style={{ border: "none", outline: "none", flex: 1, fontSize: "13px", background: "transparent", color: "var(--inv-ink)" }}
            />
          </div>
        </div>

        {suppliers.length === 0 ? (
          <Card padding="40px 24px">
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>
                {page.totalItems === 0 && !searchInput ? "No suppliers yet" : "No suppliers match that search"}
              </div>
              <div style={{ fontSize: "13px", color: "var(--inv-muted)", marginBottom: "16px" }}>
                Add your suppliers to link them to products and purchase orders.
              </div>
              <Button variant="primary" onClick={() => navigate("/app/suppliers/new")}>Add Supplier</Button>
            </div>
          </Card>
        ) : (
          <>
            <DataTable columns={columns} rows={rows} />
            <Pagination
              page={page}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              itemLabel="suppliers"
              busy={navigation.state === "loading"}
            />
          </>
        )}
      </div>
    </div>
  );
}

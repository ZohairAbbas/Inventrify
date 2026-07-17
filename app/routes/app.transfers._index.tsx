import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatDate } from "../lib/format";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Button, Card, DataTable, FilterChips, PageHead, TransferStatusPill, type DataTableColumn } from "../design";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const transfers = await prisma.stockTransfer.findMany({
    where: { shop: session.shop },
    include: {
      fromLocation: { select: { name: true } },
      toLocation: { select: { name: true } },
      items: { select: { quantitySent: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return { transfers };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const transferId = formData.get("transferId") as string;

  if (intent === "delete" && transferId) {
    await prisma.stockTransfer.deleteMany({
      where: { id: transferId, shop: session.shop, status: "draft" },
    });
  }

  return { ok: true };
};

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "in-transit", label: "In-transit" },
  { value: "received", label: "Received" },
];

export default function StockTransfers() {
  const { transfers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");
  const { timezone = "UTC", theme = "emerald" } =
    useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Transfer updated");
  }, [fetcher.data, shopify]);

  const submit = (data: Record<string, string>) => fetcher.submit(data, { method: "POST" });

  const list = transfers.filter((t) => filter === "all" || t.status === filter);

  const columns: DataTableColumn[] = [
    { header: "Transfer #", width: "1.4fr" },
    { header: "From", width: "1.2fr" },
    { header: "To", width: "1.2fr" },
    { header: "Items", width: ".6fr", align: "right" },
    { header: "Units", width: ".7fr", align: "right" },
    { header: "Status", width: ".9fr" },
    { header: "Created", width: "1fr" },
    { header: "", width: "1.4fr", align: "right" },
  ];

  const rows = list.map((t) => {
    const units = t.items.reduce((s, i) => s + i.quantitySent, 0);
    return {
      key: t.id,
      onClick: () => navigate(`/app/transfers/${t.id}`),
      cells: [
        <span key="num" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12.5px", fontWeight: 600, color: "var(--inv-accent)" }}>
          {t.transferNumber}
        </span>,
        <span key="from">{t.fromLocation.name}</span>,
        <span key="to">{t.toLocation.name}</span>,
        <span key="items" style={{ fontFamily: "var(--inv-font-mono)" }}>{t.items.length}</span>,
        <span key="units" style={{ fontFamily: "var(--inv-font-mono)" }}>{units}</span>,
        <TransferStatusPill key="status" status={t.status} />,
        <span key="created" style={{ color: "var(--inv-muted)", fontSize: "12px" }}>{formatDate(t.createdAt, timezone)}</span>,
        <div key="actions" style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }} onClick={(e) => e.stopPropagation()}>
          <Link to={`/app/transfers/${t.id}`}>
            <button style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}>
              View
            </button>
          </Link>
          {t.status === "draft" && (
            <button
              onClick={() => submit({ intent: "delete", transferId: t.id })}
              disabled={fetcher.state !== "idle"}
              style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-status-stockout-fg)", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}
            >
              Delete
            </button>
          )}
        </div>,
      ],
    };
  });

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Stock Transfers" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead
          eyebrow="draft → in-transit → received"
          title="Stock Transfers"
          right={<Button variant="primary" onClick={() => navigate("/app/transfers/new")}>+ New transfer</Button>}
        />

        <FilterChips options={STATUS_TABS} active={filter} onChange={setFilter} />

        {transfers.length === 0 ? (
          <Card padding="40px 24px">
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>No stock transfers yet</div>
              <div style={{ fontSize: "13px", color: "var(--inv-muted)", marginBottom: "16px" }}>
                Move inventory between your locations — create a transfer, ship it, then receive it.
              </div>
              <Button variant="primary" onClick={() => navigate("/app/transfers/new")}>New transfer</Button>
            </div>
          </Card>
        ) : (
          <DataTable columns={columns} rows={rows} />
        )}
      </div>
    </div>
  );
}

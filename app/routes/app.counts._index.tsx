import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useNavigation, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatDate } from "../lib/format";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createStockCount } from "../lib/stock-count.server";
import { Button, Card, DataTable, FilterChips, PageHead, Pagination, Pill, SelectInput, type DataTableColumn } from "../design";
import { parsePageRequest, parseSearch, resolvePage } from "../lib/pagination";
import { useListParams } from "../lib/use-list-params";

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "counting", label: "Counting" },
  { value: "review", label: "In review" },
  { value: "posted", label: "Posted" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_PILL: Record<string, { bg: string; fg: string; label: string }> = {
  counting: { bg: "var(--inv-status-low-bg)", fg: "var(--inv-status-low-fg)", label: "Counting" },
  review: { bg: "var(--inv-accent-soft)", fg: "var(--inv-accent)", label: "In review" },
  posted: { bg: "var(--inv-status-healthy-bg)", fg: "var(--inv-status-healthy-fg)", label: "Posted" },
  cancelled: { bg: "var(--inv-divider-3)", fg: "var(--inv-text-2)", label: "Cancelled" },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") ?? "all";
  const search = parseSearch(url.searchParams);
  const pageRequest = parsePageRequest(url.searchParams);

  const where = {
    shop,
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(search ? { countNumber: { contains: search, mode: "insensitive" as const } } : {}),
  };

  const page = resolvePage(pageRequest, await prisma.stockCount.count({ where }));

  const [counts, locations] = await Promise.all([
    prisma.stockCount.findMany({
      where,
      include: {
        location: { select: { name: true } },
        _count: { select: { items: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: page.skip,
      take: page.take,
    }),
    prisma.location.findMany({
      where: { shop, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return { counts, locations, page, statusFilter };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const locationId = formData.get("locationId") as string;
  const notes = (formData.get("notes") as string) || null;
  const blind = formData.get("blind") !== "false";

  const result = await createStockCount(session.shop, { locationId, notes, blind });
  if (!result.ok) return { ok: false as const, error: result.error ?? "Could not open count" };
  return redirect(`/app/counts/${result.countId}`);
};

export default function StockCounts() {
  const { counts, locations, page, statusFilter } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const { searchInput, setSearchInput, setFilter, setPage, setPageSize } = useListParams();
  const { timezone = "UTC", theme = "emerald" } = useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  const [showNew, setShowNew] = useState(false);
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [blind, setBlind] = useState(true);

  useEffect(() => {
    const d = fetcher.data;
    if (d && !d.ok) shopify.toast.show(d.error || "Could not open count", { isError: true });
  }, [fetcher.data, shopify]);

  const columns: DataTableColumn[] = [
    { header: "Count", width: "1.4fr" },
    { header: "Location", width: "1.4fr" },
    { header: "Items", width: ".6fr", align: "right" },
    { header: "Status", width: "1fr" },
    { header: "Opened", width: "1fr" },
    { header: "", width: ".8fr", align: "right" },
  ];

  const rows = counts.map((c) => {
    const pill = STATUS_PILL[c.status] ?? STATUS_PILL.counting;
    return {
      key: c.id,
      onClick: () => navigate(`/app/counts/${c.id}`),
      cells: [
        <span key="num" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12.5px", fontWeight: 600, color: "var(--inv-accent)" }}>{c.countNumber}</span>,
        <span key="loc">{c.location.name}</span>,
        <span key="items" style={{ fontFamily: "var(--inv-font-mono)" }}>{c._count.items}</span>,
        <Pill key="status" label={pill.label} bg={pill.bg} fg={pill.fg} />,
        <span key="opened" style={{ color: "var(--inv-muted)", fontSize: "12px" }}>{formatDate(c.createdAt, timezone)}</span>,
        <div key="go" onClick={(e) => e.stopPropagation()} style={{ textAlign: "right" }}>
          <Link to={`/app/counts/${c.id}`}>
            <button style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}>Open</button>
          </Link>
        </div>,
      ],
    };
  });

  const canCreate = locations.length > 0;

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Cycle Counts" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead
          eyebrow="count → review → post"
          title="Cycle Counts"
          right={
            canCreate ? (
              <Button variant="primary" onClick={() => setShowNew((s) => !s)}>{showNew ? "Cancel" : "+ New count"}</Button>
            ) : null
          }
        />

        {!canCreate && (
          <Card padding="16px 20px" style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "13px", color: "var(--inv-muted)" }}>
              Sync a Shopify location first — a count is always scoped to one location.
            </div>
          </Card>
        )}

        {showNew && canCreate && (
          <Card style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "14px" }}>Open a new count</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "12px" }}>
              <div>
                <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>Location</label>
                <SelectInput value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  {locations.map((l) => (<option key={l.id} value={l.id}>{l.name}</option>))}
                </SelectInput>
              </div>
              <div>
                <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>Notes (optional)</label>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. monthly count — aisle 3"
                  style={{ width: "100%", height: "38px", border: "1px solid var(--inv-input-border-2)", borderRadius: "10px", padding: "0 12px", fontSize: "13px", background: "#fff", color: "var(--inv-ink)" }} />
              </div>
            </div>
            <label style={{ display: "inline-flex", alignItems: "flex-start", gap: "8px", fontSize: "12.5px", color: "var(--inv-text-2)", marginBottom: "14px", cursor: "pointer" }}>
              <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} style={{ marginTop: "2px" }} />
              <span>
                Blind count
                <span style={{ display: "block", color: "var(--inv-muted)", fontSize: "11.5px" }}>
                  Hide the system quantity while counting, so the number entered is what is on the shelf. Recommended.
                </span>
              </span>
            </label>
            <div>
              <Button
                variant="primary"
                disabled={fetcher.state !== "idle" || !locationId}
                onClick={() => fetcher.submit({ locationId, notes, blind: String(blind) }, { method: "POST" })}
              >
                Open count
              </Button>
            </div>
          </Card>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "220px", display: "flex", alignItems: "center", gap: "9px", background: "#fff", border: "1px solid var(--inv-input-border)", borderRadius: "10px", padding: "0 12px", height: "38px" }}>
            <span style={{ color: "var(--inv-muted)" }}>⌕</span>
            <input value={searchInput} placeholder="Search count number" onChange={(e) => setSearchInput(e.target.value)}
              style={{ border: "none", outline: "none", flex: 1, fontSize: "13px", background: "transparent", color: "var(--inv-ink)" }} />
          </div>
        </div>

        <FilterChips options={STATUS_TABS} active={statusFilter} onChange={(v) => setFilter("status", v)} />

        {counts.length === 0 ? (
          <Card padding="40px 24px">
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>
                {page.totalItems === 0 && !searchInput && statusFilter === "all" ? "No counts yet" : "No counts match these filters"}
              </div>
              <div style={{ fontSize: "13px", color: "var(--inv-muted)" }}>
                Open a count, scan or add the products on a shelf, then post the variances as adjustments.
              </div>
            </div>
          </Card>
        ) : (
          <>
            <DataTable columns={columns} rows={rows} />
            <Pagination page={page} onPageChange={setPage} onPageSizeChange={setPageSize} itemLabel="counts" busy={navigation.state === "loading"} />
          </>
        )}
      </div>
    </div>
  );
}

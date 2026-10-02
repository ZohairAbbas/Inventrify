import type { ActionFunctionArgs, LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { formatCurrency, formatDate } from "../lib/format";
import { getSupplierClaimSummary } from "../lib/supplier-claim.server";
import { getSupplierScorecard } from "../lib/supplier-scorecard.server";
import { getSupplierStatement, recordLedgerEntry, reverseLedgerEntry } from "../lib/supplier-ledger.server";
import { LEDGER_TYPE_LABELS, describeBalance } from "../lib/supplier-ledger";
import { parseFormDate } from "../lib/date-range";
import { Button, Card, FormField, POStatusPill, SelectInput, TextArea, TextInput } from "../design";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const supplier = await prisma.supplier.findFirst({
    where: { id: params.supplierId, shop: session.shop },
    include: {
      products: { select: { id: true, title: true, variantTitle: true, currentStock: true, sku: true } },
      purchaseOrders: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });

  if (!supplier) throw new Response("Not found", { status: 404 });
  const [claims, scorecard, statement, poOptions] = await Promise.all([
    getSupplierClaimSummary(session.shop, supplier.id),
    getSupplierScorecard(session.shop, supplier.id),
    getSupplierStatement(session.shop, supplier.id),
    // For linking a payment to the PO it pays for (an advance, say).
    prisma.purchaseOrder.findMany({
      where: { shop: session.shop, supplierId: supplier.id, status: { not: "draft" } },
      select: { id: true, poNumber: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  return { supplier, claims, scorecard, statement, poOptions };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const userId = sessionToken?.sub ?? null;

  if (intent === "record_entry") {
    const rawDate = (formData.get("occurredAt") as string) || "";
    const occurredAt = parseFormDate(rawDate);
    if (rawDate && !occurredAt) return { ledger: true, error: "That date is not valid" };
    const result = await recordLedgerEntry(session.shop, params.supplierId ?? "", {
      type: String(formData.get("type") ?? ""),
      amount: Number(formData.get("amount")),
      direction: (formData.get("direction") as string) || null,
      occurredAt,
      reference: (formData.get("reference") as string) || null,
      note: (formData.get("note") as string) || null,
      purchaseOrderId: (formData.get("purchaseOrderId") as string) || null,
      userId,
    });
    return result.ok ? { ledger: true, ok: true, message: "Entry recorded" } : { ledger: true, error: result.error };
  }

  if (intent === "reverse_entry") {
    const result = await reverseLedgerEntry(session.shop, String(formData.get("entryId") ?? ""), { userId });
    return result.ok ? { ledger: true, ok: true, message: "Entry reversed" } : { ledger: true, error: result.error };
  }

  const name = (formData.get("name") as string)?.trim();
  if (!name) return { error: "Supplier name is required" };

  await prisma.supplier.updateMany({
    where: { id: params.supplierId, shop: session.shop },
    data: {
      name,
      contactName: (formData.get("contactName") as string) || null,
      email: (formData.get("email") as string) || null,
      phone: (formData.get("phone") as string) || null,
      address: (formData.get("address") as string) || null,
      leadTimeDays: parseInt(formData.get("leadTimeDays") as string, 10) || 7,
      notes: (formData.get("notes") as string) || null,
    },
  });

  return { ok: true };
};

export default function EditSupplier() {
  const { supplier, claims, scorecard, statement, poOptions } = useLoaderData<typeof loader>();
  const { theme = "emerald", currency = "USD", timezone = "UTC" } =
    useRouteLoaderData<typeof appLoader>("routes/app") ?? {};
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();

  const [name, setName] = useState(supplier.name);
  const [contactName, setContactName] = useState(supplier.contactName ?? "");
  const [email, setEmail] = useState(supplier.email ?? "");
  const [phone, setPhone] = useState(supplier.phone ?? "");
  const [address, setAddress] = useState(supplier.address ?? "");
  const [leadTimeDays, setLeadTimeDays] = useState(String(supplier.leadTimeDays));
  const [notes, setNotes] = useState(supplier.notes ?? "");

  const isBusy = fetcher.state !== "idle";
  const error = (fetcher.data as { error?: string } | undefined)?.error;

  useEffect(() => {
    if (fetcher.data && !error) {
      navigate("/app/suppliers");
    }
  }, [fetcher.data, error, navigate]);

  const handleSubmit = () => {
    fetcher.submit({ name, contactName, email, phone, address, leadTimeDays, notes }, { method: "POST" });
  };

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title={`Edit — ${supplier.name}`} />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "14px", alignItems: "start" }}>
          <div>
            {error && (
              <Card padding="12px 16px" style={{ marginBottom: "16px" }}>
                <span style={{ color: "var(--inv-status-critical-fg)", fontSize: "13px" }}>{error}</span>
              </Card>
            )}
            <Card style={{ marginBottom: "14px" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "16px" }}>Supplier details</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                <FormField label="Supplier name *">
                  <TextInput value={name} onChange={(e) => setName(e.target.value)} />
                </FormField>
                <FormField label="Contact name">
                  <TextInput value={contactName} onChange={(e) => setContactName(e.target.value)} />
                </FormField>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                  <FormField label="Email">
                    <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </FormField>
                  <FormField label="Phone">
                    <TextInput type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
                  </FormField>
                </div>
                <FormField label="Address">
                  <TextArea value={address} onChange={(e) => setAddress(e.target.value)} rows={2} />
                </FormField>
                <FormField label="Default lead time (days)">
                  <TextInput type="number" min={1} value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value)} style={{ maxWidth: "160px" }} />
                </FormField>
                <FormField label="Notes">
                  <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
                </FormField>
              </div>
            </Card>
            <div style={{ display: "flex", gap: "9px", justifyContent: "flex-end" }}>
              <Link to="/app/suppliers">
                <Button variant="ghost">Cancel</Button>
              </Link>
              <Button variant="primary" disabled={isBusy || !name.trim()} onClick={handleSubmit}>
                Save changes
              </Button>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <Card>
              <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "10px" }}>
                Linked products ({supplier.products.length})
              </div>
              {supplier.products.length === 0 ? (
                <div style={{ fontSize: "12.5px", color: "var(--inv-muted)" }}>No products linked to this supplier yet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {supplier.products.map((p) => (
                    <div key={p.id}>
                      <div style={{ fontSize: "12.5px", fontWeight: 600 }}>
                        {p.title}
                        {p.variantTitle ? ` — ${p.variantTitle}` : ""}
                      </div>
                      <div style={{ fontSize: "11.5px", color: "var(--inv-muted)" }}>
                        {p.sku ?? "No SKU"} · {p.currentStock} units
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <PerformanceCard scorecard={scorecard} claims={claims} currency={currency} />

            <Card>
              <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "10px" }}>Recent POs</div>
              {supplier.purchaseOrders.length === 0 ? (
                <div style={{ fontSize: "12.5px", color: "var(--inv-muted)" }}>No purchase orders yet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {supplier.purchaseOrders.map((po) => (
                    <div key={po.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <Link to={`/app/purchase-orders/${po.id}`} style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12.5px", fontWeight: 600, color: "var(--inv-accent)" }}>
                        {po.poNumber}
                      </Link>
                      <POStatusPill status={po.status} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>

        <SupplierAccount
          supplierName={supplier.name}
          statement={statement}
          poOptions={poOptions}
          currency={currency}
          timezone={timezone}
        />
      </div>
    </div>
  );
}

// As serialised to the page: dates arrive as strings.
type Statement = SerializeFrom<typeof loader>["statement"];
type LedgerActionData = { ledger?: boolean; ok?: boolean; error?: string; message?: string };

/**
 * The merchant's running account with this supplier.
 *
 * Bills (per delivery) and claim credits post themselves; this is where the merchant
 * records the rest — payments, refunds, and adjustments such as an opening balance —
 * and reverses mistakes. Its own fetcher, so recording a payment does not trip the edit
 * form's "saved, go back to the list" redirect.
 */
function SupplierAccount({
  supplierName,
  statement,
  poOptions,
  currency,
  timezone,
}: {
  supplierName: string;
  statement: Statement;
  poOptions: { id: string; poNumber: string }[];
  currency: string;
  timezone: string;
}) {
  const fetcher = useFetcher<LedgerActionData>();
  const shopify = useAppBridge();
  const isBusy = fetcher.state !== "idle";
  const [type, setType] = useState("payment");
  const [direction, setDirection] = useState("owe_more");
  const [amount, setAmount] = useState("");
  const [occurredAt, setOccurredAt] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    const d = fetcher.data;
    if (!d) return;
    if (d.error) {
      shopify.toast.show(d.error, { isError: true });
    } else if (d.ok) {
      shopify.toast.show(d.message ?? "Saved");
      setAmount("");
      setReference("");
      setNote("");
    }
  }, [fetcher.data, shopify]);

  const balance = statement.balance;
  const balanceColor =
    Math.abs(balance) < 0.005
      ? "var(--inv-text-2)"
      : balance > 0
        ? "var(--inv-status-critical-fg)"
        : "var(--inv-status-healthy-fg)";

  return (
    <Card style={{ marginTop: "14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "12px", flexWrap: "wrap", marginBottom: "4px" }}>
        <div style={{ fontSize: "14px", fontWeight: 600 }}>Account</div>
        <div style={{ fontSize: "16px", fontWeight: 700, color: balanceColor }}>
          {describeBalance(balance, statement.currency ?? currency, supplierName)}
        </div>
      </div>
      <div style={{ fontSize: "12px", color: "var(--inv-muted)", marginBottom: "14px" }}>
        Deliveries are billed automatically at the PO's unit cost, and resolved claims are credited. Record payments,
        refunds and anything else here. Starting out? Add an adjustment for the opening balance.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px", alignItems: "end", marginBottom: "16px" }}>
        <FormField label="Entry">
          <SelectInput value={type} onChange={(e) => setType(e.target.value)}>
            <option value="payment">Payment to supplier</option>
            <option value="refund">Refund from supplier</option>
            <option value="adjustment">Adjustment</option>
          </SelectInput>
        </FormField>
        {type === "adjustment" && (
          <FormField label="Effect">
            <SelectInput value={direction} onChange={(e) => setDirection(e.target.value)}>
              <option value="owe_more">I owe more (opening balance, charge)</option>
              <option value="owe_less">I owe less (opening credit, discount)</option>
            </SelectInput>
          </FormField>
        )}
        <FormField label={`Amount (${currency})`}>
          <TextInput type="number" min={0} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FormField>
        <FormField label="Date">
          <TextInput type="date" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </FormField>
        <FormField label="Reference">
          <TextInput placeholder="Invoice / bank ref" value={reference} onChange={(e) => setReference(e.target.value)} />
        </FormField>
        <FormField label="For PO (optional)">
          <SelectInput value={purchaseOrderId} onChange={(e) => setPurchaseOrderId(e.target.value)}>
            <option value="">—</option>
            {poOptions.map((po) => (
              <option key={po.id} value={po.id}>
                {po.poNumber}
              </option>
            ))}
          </SelectInput>
        </FormField>
      </div>
      <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "18px" }}>
        <TextInput placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
        <Button
          variant="primary"
          disabled={isBusy || !(parseFloat(amount) > 0)}
          onClick={() =>
            fetcher.submit(
              { intent: "record_entry", type, direction, amount, occurredAt, reference, purchaseOrderId, note },
              { method: "POST" },
            )
          }
        >
          Record
        </Button>
      </div>

      {statement.rows.length === 0 ? (
        <div style={{ fontSize: "12.5px", color: "var(--inv-muted)" }}>No entries yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px" }}>
            <thead>
              <tr style={{ color: "var(--inv-muted)", fontSize: "11px", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>Date</th>
                <th style={{ padding: "6px 8px" }}>Entry</th>
                <th style={{ padding: "6px 8px" }}>Details</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>Amount</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>Balance</th>
                <th style={{ padding: "6px 8px" }}></th>
              </tr>
            </thead>
            <tbody>
              {statement.rows.map((row) => (
                <tr key={row.id} style={{ borderTop: "1px solid var(--inv-divider)", opacity: row.reversed ? 0.55 : 1 }}>
                  <td style={{ padding: "7px 8px", whiteSpace: "nowrap" }}>{formatDate(row.occurredAt, timezone)}</td>
                  <td style={{ padding: "7px 8px" }}>
                    {LEDGER_TYPE_LABELS[row.type] ?? row.type}
                    {row.reversed ? " (reversed)" : ""}
                  </td>
                  <td style={{ padding: "7px 8px", color: "var(--inv-text-2)" }}>
                    {[
                      row.poNumber,
                      row.reference,
                      row.note,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                    {row.purchaseOrderId && (
                      <>
                        {" "}
                        <Link to={`/app/purchase-orders/${row.purchaseOrderId}`} style={{ color: "var(--inv-accent)" }}>
                          view
                        </Link>
                      </>
                    )}
                  </td>
                  <td style={{ padding: "7px 8px", textAlign: "right", fontFamily: "var(--inv-font-mono)" }}>
                    {row.amount > 0 ? "+" : ""}
                    {formatCurrency(row.amount, row.currency)}
                  </td>
                  <td style={{ padding: "7px 8px", textAlign: "right", fontFamily: "var(--inv-font-mono)" }}>
                    {formatCurrency(row.balance, row.currency)}
                  </td>
                  <td style={{ padding: "7px 8px", textAlign: "right" }}>
                    {!row.reversed && !row.isReversal && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => {
                          if (window.confirm("Reverse this entry? A matching opposite entry is added; nothing is deleted.")) {
                            fetcher.submit({ intent: "reverse_entry", entryId: row.id }, { method: "POST" });
                          }
                        }}
                        style={{ fontSize: "11px", border: "1px solid var(--inv-input-border-2)", background: "#fff", padding: "3px 8px", borderRadius: "7px", cursor: "pointer" }}
                      >
                        Reverse
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {statement.truncated && (
            <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginTop: "8px" }}>
              Showing the latest {statement.rows.length} entries. The balance includes all of them.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** "92%" or "—" when there is nothing to measure. */
const pct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);

/**
 * How this supplier has actually performed, from the merchant's own POs and claims, with
 * who bore the cost of bad stock. Each figure carries its sample size: "100% on time" over
 * one delivery is a different statement from the same over forty.
 */
function PerformanceCard({
  scorecard,
  claims,
  currency,
}: {
  scorecard: SerializeFrom<typeof loader>["scorecard"];
  claims: SerializeFrom<typeof loader>["claims"];
  currency: string;
}) {
  if (scorecard.finishedPos === 0 && scorecard.onTimeSample === 0 && claims.unitsClaimed === 0) return null;

  const row = (label: string, value: string, hint?: string) => (
    <>
      <span>
        {label}
        {hint && <span style={{ color: "var(--inv-muted)", fontSize: "11px" }}> · {hint}</span>}
      </span>
      <span style={{ fontFamily: "var(--inv-font-mono)", textAlign: "right" }}>{value}</span>
    </>
  );

  return (
    <Card>
      <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "10px" }}>Performance</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "6px 12px", fontSize: "12.5px" }}>
        {row("Fill rate", pct(scorecard.fillRate), `${scorecard.finishedPos} finished PO${scorecard.finishedPos === 1 ? "" : "s"}`)}
        {row("On time", pct(scorecard.onTimeRate), `${scorecard.onTimeSample} with a due date`)}
        {row(
          "Lead time",
          scorecard.actualLeadTimeDays === null
            ? `${scorecard.quotedLeadTimeDays}d quoted`
            : `${Math.round(scorecard.actualLeadTimeDays * 10) / 10}d`,
          scorecard.actualLeadTimeDays === null ? undefined : `${scorecard.quotedLeadTimeDays}d quoted`,
        )}
        {row("Defect rate", pct(scorecard.defectRate), `${scorecard.unitsReceived} units received`)}
      </div>

      {claims.unitsClaimed > 0 && (
        <>
          <div style={{ height: "1px", background: "var(--inv-divider)", margin: "12px 0" }} />
          {/* Who bore the cost of bad stock from this supplier. Absorbed units are the
              merchant's loss; accepted ones the supplier made good. */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "6px 12px", fontSize: "12.5px" }}>
            {row("Open claims", String(claims.openClaims))}
            {row("Units claimed", String(claims.unitsClaimed))}
            {row("Accepted by supplier", String(claims.unitsAccepted), pct(scorecard.acceptanceRate))}
            {row("Damaged units you absorbed", String(claims.damagedAbsorbed))}
            {row("In quarantine now", String(claims.quarantined))}
            {scorecard.replacementsOutstanding > 0 && row("Replacements still due", String(scorecard.replacementsOutstanding))}
            {row(
              "Days to resolve a claim",
              scorecard.avgDaysToResolve === null ? "—" : String(scorecard.avgDaysToResolve),
              scorecard.resolvedClaims > 0 ? `${scorecard.resolvedClaims} resolved` : undefined,
            )}
            {row("Credit agreed", formatCurrency(claims.creditAgreed, currency))}
          </div>
        </>
      )}
    </Card>
  );
}

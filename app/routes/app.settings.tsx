import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRouteLoaderData } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncShopifyInventory } from "../lib/shopify-sync.server";
import { syncOrderHistory } from "../lib/order-sync.server";
import {
  syncCourierifyReturnRates,
  syncCourierifyFulfilmentStatus,
  syncCourierifyReturns,
} from "../lib/courierify.server";
import { syncFinancifyMargins } from "../lib/financify.server";
import { decryptSecret, encryptSecret } from "../lib/crypto.server";
import { recomputeReorderPoints } from "../lib/planning-job.server";
import { Button, Card, FilterChips, FormField, PageHead, TextInput } from "../design";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [settings, productCount] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { shop } }),
    // Archived products are excluded: they are not "tracked" in any sense the merchant
    // would recognise, and this same figure labels the bulk lead-time checkbox, whose
    // update also skips them. A count that overstates what the button will touch is the
    // kind of small dishonesty the data audit exists to catch.
    prisma.product.count({ where: { shop, isArchived: false } }),
  ]);

  return {
    shop,
    productCount,
    defaultLeadTime: settings?.defaultLeadTime ?? 7,
    serviceLevel: settings?.serviceLevel ?? 1.65,
    safetyStockDays: settings?.safetyStockDays ?? 7,
    deadStockDays: settings?.deadStockDays ?? 60,
    deadStockMinUnits: settings?.deadStockMinUnits ?? 20,
    coverageDays: settings?.coverageDays ?? 30,
    rtoTransitDays: settings?.rtoTransitDays ?? 14,
    codGateways: settings?.codGateways ?? "",
    confirmedOrderTag: settings?.confirmedOrderTag ?? "",
    notificationEmail: settings?.notificationEmail ?? "",
    slackWebhookUrl: settings?.slackWebhookUrl ?? "",
    whatsappNumber: settings?.whatsappNumber ?? "",
    courierifyConnected: !!settings?.courierifyApiKey,
    financifyConnected: !!settings?.financifyApiKey,
    cronSecret: process.env.CRON_SECRET ? "set" : "not set",
    appUrl: process.env.SHOPIFY_APP_URL ?? "",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "sync") {
    const { synced, errors, archived, completed, error: syncError } =
      await syncShopifyInventory(admin, shop);
    // A partial catalogue walk must not be reported as a successful sync — the
    // merchant needs to know the numbers below are incomplete.
    const { recordsSynced } = await syncOrderHistory(admin, shop);
    try {
      const resp = await admin.graphql(`{ shop { ianaTimezone currencyCode } }`);
      const { data } = await resp.json();
      const timezone: string = data?.shop?.ianaTimezone ?? "UTC";
      const currency: string = data?.shop?.currencyCode ?? "USD";
      await prisma.shopSettings.upsert({
        where: { shop },
        create: { shop, timezone, currency },
        update: { timezone, currency },
      });
    } catch { /* non-fatal */ }
    return { intent, synced, errors, archived, completed, syncError, recordsSynced };
  }

  if (intent === "update_thresholds") {
    const leadTimeDays = parseInt(formData.get("leadTimeDays") as string, 10);
    const serviceLevel = parseFloat(formData.get("serviceLevel") as string);
    const safetyStockDays = parseInt(formData.get("safetyStockDays") as string, 10);
    const deadStockDays = parseInt(formData.get("deadStockDays") as string, 10);
    const deadStockMinUnits = parseInt(formData.get("deadStockMinUnits") as string, 10);
    const coverageDays = parseInt(formData.get("coverageDays") as string, 10);
    const rtoTransitDays = parseInt(formData.get("rtoTransitDays") as string, 10);
    const codGateways = (formData.get("codGateways") as string)?.trim() ?? "";
    const confirmedOrderTag = (formData.get("confirmedOrderTag") as string)?.trim() ?? "";
    const notificationEmail = (formData.get("notificationEmail") as string)?.trim() || null;
    const slackWebhookUrl = (formData.get("slackWebhookUrl") as string)?.trim() || null;
    const whatsappNumber = (formData.get("whatsappNumber") as string)?.trim() || null;

    // Applying the default to every existing product is opt-in, and deliberately so.
    // It used to happen implicitly on every save of this form — so changing a
    // notification email overwrote every per-SKU lead time the merchant had set, and
    // with it every reorder point and safety stock derived from them.
    const applyLeadTimeToExisting = formData.get("applyLeadTimeToExisting") === "true";
    let leadTimeApplied = 0;

    const update: Record<string, unknown> = {};
    if (!isNaN(leadTimeDays) && leadTimeDays > 0) {
      update.defaultLeadTime = leadTimeDays;
      if (applyLeadTimeToExisting) {
        const { count } = await prisma.product.updateMany({
          where: { shop, isArchived: false },
          data: { leadTimeDays },
        });
        leadTimeApplied = count;
      }
    }
    if (!isNaN(serviceLevel) && serviceLevel > 0) update.serviceLevel = serviceLevel;
    if (!isNaN(safetyStockDays) && safetyStockDays > 0) update.safetyStockDays = safetyStockDays;
    if (!isNaN(deadStockDays) && deadStockDays > 0) update.deadStockDays = deadStockDays;
    if (!isNaN(deadStockMinUnits) && deadStockMinUnits >= 0) update.deadStockMinUnits = deadStockMinUnits;
    if (!isNaN(coverageDays) && coverageDays > 0) update.coverageDays = coverageDays;
    if (!isNaN(rtoTransitDays) && rtoTransitDays >= 0) update.rtoTransitDays = rtoTransitDays;
    update.codGateways = codGateways;
    update.confirmedOrderTag = confirmedOrderTag;
    update.notificationEmail = notificationEmail;
    update.slackWebhookUrl = slackWebhookUrl;
    update.whatsappNumber = whatsappNumber;

    await prisma.shopSettings.upsert({ where: { shop }, create: { shop, ...update }, update });

    // Lead time is an input to the reorder point, so a bulk change has to be followed
    // through — otherwise the app shows reorder points derived from a lead time it is
    // no longer using, which is the same class of drift the sync fix addressed.
    if (leadTimeApplied > 0) {
      await recomputeReorderPoints(shop);
    }

    return { intent, updated: true, leadTimeApplied };
  }

  if (intent === "update_theme") {
    const theme = (formData.get("theme") as string) === "indigo" ? "indigo" : "emerald";
    await prisma.shopSettings.upsert({
      where: { shop },
      create: { shop, theme },
      update: { theme },
    });
    return { intent, updated: true };
  }

  if (intent === "save_courierify") {
    const apiKey = (formData.get("courierifyKey") as string)?.trim();
    if (!apiKey) return { intent, error: "API key is required" };

    const result = await syncCourierifyReturnRates(shop, apiKey);
    if (result.error) return { intent, error: result.error };

    // Persist the key first so the returns cursor has a ShopSettings row to update.
    await prisma.shopSettings.upsert({
      where: { shop },
      create: { shop, courierifyApiKey: encryptSecret(apiKey) },
      update: { courierifyApiKey: encryptSecret(apiKey) },
    });

    // Broaden the sync: fulfilment-status snapshot + returns queue. Both best-effort —
    // a failure here doesn't undo the successful rate sync / connection.
    await syncCourierifyFulfilmentStatus(shop, apiKey);
    await syncCourierifyReturns(shop, apiKey);

    return { intent, synced: result.synced };
  }

  // Re-run all three Courierify pulls using the already-stored key (no re-entry needed).
  if (intent === "resync_courierify") {
    const settings = await prisma.shopSettings.findUnique({
      where: { shop },
      select: { courierifyApiKey: true },
    });
    const apiKey = decryptSecret(settings?.courierifyApiKey);
    if (!apiKey) return { intent, error: "Courierify is not connected" };

    const result = await syncCourierifyReturnRates(shop, apiKey);
    if (result.error) return { intent, error: result.error };
    await syncCourierifyFulfilmentStatus(shop, apiKey);
    await syncCourierifyReturns(shop, apiKey);

    return { intent, synced: result.synced };
  }

  if (intent === "save_financify") {
    const apiKey = (formData.get("financifyKey") as string)?.trim();
    if (!apiKey) return { intent, error: "API key is required" };

    const result = await syncFinancifyMargins(shop, apiKey);
    if (result.error) return { intent, error: result.error };

    await prisma.shopSettings.upsert({
      where: { shop },
      create: { shop, financifyApiKey: encryptSecret(apiKey) },
      update: { financifyApiKey: encryptSecret(apiKey) },
    });
    return { intent, synced: result.synced };
  }

  if (intent === "disconnect_courierify") {
    await prisma.shopSettings.upsert({
      where: { shop },
      create: { shop, courierifyApiKey: null },
      update: { courierifyApiKey: null },
    });
    return { intent, ok: true };
  }

  if (intent === "disconnect_financify") {
    await prisma.shopSettings.upsert({
      where: { shop },
      create: { shop, financifyApiKey: null },
      update: { financifyApiKey: null },
    });
    return { intent, ok: true };
  }

  return { intent, ok: true };
};

function IntegrationCard({
  name,
  desc,
  connected,
  keyValue,
  onKeyChange,
  onConnect,
  onDisconnect,
  onResync,
  isBusy,
}: {
  name: string;
  desc: string;
  connected: boolean;
  keyValue: string;
  onKeyChange: (v: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onResync?: () => void;
  isBusy: boolean;
}) {
  return (
    <div
      style={{
        border: "1px solid " + (connected ? "var(--inv-accent)" : "var(--inv-border)"),
        borderRadius: "13px",
        padding: "16px 17px",
        background: connected ? "var(--inv-accent-soft)" : "#fff",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
          <div style={{ width: "30px", height: "30px", borderRadius: "8px", background: "var(--inv-ink)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "13px" }}>
            {name[0]}
          </div>
          <span style={{ fontSize: "14px", fontWeight: 600 }}>{name}</span>
        </div>
        <span
          style={{
            fontSize: "10.5px",
            fontWeight: 600,
            padding: "3px 9px",
            borderRadius: "20px",
            background: connected ? "var(--inv-accent)" : "var(--inv-divider-3)",
            color: connected ? "#fff" : "#8b877d",
          }}
        >
          {connected ? "Connected" : "Not connected"}
        </span>
      </div>
      <div style={{ fontSize: "12px", color: "var(--inv-text-2)", lineHeight: 1.5, marginBottom: "13px" }}>{desc}</div>
      {connected ? (
        <div style={{ display: "flex", gap: "8px" }}>
          {onResync && (
            <Button variant="primary" disabled={isBusy} onClick={onResync} style={{ flex: 1 }}>
              Sync now
            </Button>
          )}
          <Button variant="ghost" disabled={isBusy} onClick={onDisconnect} style={{ flex: 1 }}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <TextInput
            type="password"
            value={keyValue}
            onChange={(e) => onKeyChange(e.target.value)}
            placeholder={`Enter your ${name} API key`}
          />
          <Button variant="primary" disabled={isBusy || !keyValue} onClick={onConnect} style={{ width: "100%" }}>
            Connect & sync
          </Button>
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const { theme = "emerald" } = useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  const [courierifyKey, setCourierifyKey] = useState("");
  const [financifyKey, setFinancifyKey] = useState("");
  const [leadTime, setLeadTime] = useState(String(data.defaultLeadTime));
  // Opt-in, and reset after every save so a destructive bulk overwrite can never ride
  // along with an unrelated settings change on the next submit.
  const [applyLeadTimeToExisting, setApplyLeadTimeToExisting] = useState(false);
  const [serviceLevel, setServiceLevel] = useState(String(data.serviceLevel));
  const [safetyStockDays, setSafetyStockDays] = useState(String(data.safetyStockDays));
  const [deadStockDays, setDeadStockDays] = useState(String(data.deadStockDays));
  const [deadStockMinUnits, setDeadStockMinUnits] = useState(String(data.deadStockMinUnits));
  const [coverageDays, setCoverageDays] = useState(String(data.coverageDays));
  const [rtoTransitDays, setRtoTransitDays] = useState(String(data.rtoTransitDays));
  const [codGateways, setCodGateways] = useState(data.codGateways);
  const [confirmedOrderTag, setConfirmedOrderTag] = useState(data.confirmedOrderTag);
  const [notificationEmail, setNotificationEmail] = useState(data.notificationEmail ?? "");
  const [slackWebhookUrl, setSlackWebhookUrl] = useState(data.slackWebhookUrl ?? "");
  const [whatsappNumber, setWhatsappNumber] = useState(data.whatsappNumber ?? "");

  const isBusy = fetcher.state !== "idle";
  const result = fetcher.data as Record<string, unknown> | undefined;

  useEffect(() => {
    if (!result) return;
    if (result.intent === "sync") {
      if (result.completed === false) {
        shopify.toast.show(
          `Sync incomplete — ${result.syncError ?? "Shopify request failed"}. Nothing was archived.`,
          { isError: true },
        );
      } else {
        shopify.toast.show(`Synced ${result.synced} variants · ${result.recordsSynced} sales records`);
      }
    } else if (result.intent === "update_thresholds") {
      const applied = Number(result.leadTimeApplied ?? 0);
      shopify.toast.show(
        applied > 0
          ? `Settings saved — lead time applied to ${applied} product${applied === 1 ? "" : "s"}`
          : "Settings saved",
      );
      setApplyLeadTimeToExisting(false);
    } else if (result.intent === "save_courierify") {
      if (result.error) shopify.toast.show(String(result.error), { isError: true });
      else shopify.toast.show(`Courierify connected — ${result.synced} SKUs updated`);
    } else if (result.intent === "resync_courierify") {
      if (result.error) shopify.toast.show(String(result.error), { isError: true });
      else shopify.toast.show(`Courierify synced — ${result.synced} SKUs updated`);
    } else if (result.intent === "save_financify") {
      if (result.error) shopify.toast.show(String(result.error), { isError: true });
      else shopify.toast.show(`Financify connected — ${result.synced} SKUs updated`);
    } else if (result.intent === "disconnect_courierify" || result.intent === "disconnect_financify") {
      shopify.toast.show("Disconnected");
    } else if (result.intent === "update_theme") {
      shopify.toast.show("Theme updated");
    }
  }, [result, shopify]);

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Settings" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead eyebrow="Sync · intelligence · integrations" title="Settings" />

        <Card style={{ marginBottom: "14px" }}>
          <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "16px" }}>Inventory sync</div>
          <div style={{ fontSize: "13px", color: "var(--inv-text-2)", marginBottom: "14px" }}>
            {data.productCount} variants tracked · {data.shop}
          </div>
          <Button variant="primary" disabled={isBusy} onClick={() => fetcher.submit({ intent: "sync" }, { method: "POST" })}>
            Sync inventory + order history
          </Button>
        </Card>

        <Card style={{ marginBottom: "14px" }}>
          <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "16px" }}>Inventory intelligence</div>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--inv-text-2)", marginBottom: "10px" }}>Reorder & lead times</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "10px" }}>
            <FormField
              label="Default lead time (days)"
              hint="Used for newly synced products. Existing per-product lead times are left alone."
            >
              <TextInput type="number" min={1} value={leadTime} onChange={(e) => setLeadTime(e.target.value)} />
            </FormField>
            <FormField label="Safety stock fallback (days)" hint="When variance data unavailable">
              <TextInput type="number" min={1} value={safetyStockDays} onChange={(e) => setSafetyStockDays(e.target.value)} />
            </FormField>
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "8px",
              fontSize: "12px",
              color: "var(--inv-text-2)",
              marginBottom: "18px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={applyLeadTimeToExisting}
              onChange={(e) => setApplyLeadTimeToExisting(e.target.checked)}
              style={{ marginTop: "2px" }}
            />
            <span>
              Also overwrite the lead time on all {data.productCount} existing products
              <span style={{ display: "block", color: "var(--inv-muted)", fontSize: "11.5px", marginTop: "2px" }}>
                Replaces every per-product lead time you have set, and recalculates reorder points. Off by default.
              </span>
            </span>
          </label>

          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--inv-text-2)", marginBottom: "10px" }}>Safety stock service level</div>
          <div style={{ marginBottom: "18px", maxWidth: "260px" }}>
            <FormField label="Service level Z-score" hint="1.28=90% · 1.65=95% · 2.05=98%">
              <TextInput type="number" step={0.01} min={0.5} max={3} value={serviceLevel} onChange={(e) => setServiceLevel(e.target.value)} />
            </FormField>
          </div>

          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--inv-text-2)", marginBottom: "10px" }}>Dead stock thresholds</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "18px" }}>
            <FormField label="No-sales window (days)" hint="Alert after N days no sales">
              <TextInput type="number" min={1} value={deadStockDays} onChange={(e) => setDeadStockDays(e.target.value)} />
            </FormField>
            <FormField label="Min units threshold" hint="Only alert if stock is above this level">
              <TextInput type="number" min={0} value={deadStockMinUnits} onChange={(e) => setDeadStockMinUnits(e.target.value)} />
            </FormField>
          </div>

          <div style={{ height: "1px", background: "var(--inv-divider)", margin: "18px 0" }} />

          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--inv-text-2)", marginBottom: "10px" }}>Cash on delivery</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "18px" }}>
            <FormField
              label="COD gateway names"
              hint="Comma-separated, exactly as Shopify reports them (e.g. PostEx, Cash on Delivery). Leave blank to auto-detect."
            >
              <TextInput
                value={codGateways}
                placeholder="PostEx, Cash on Delivery"
                onChange={(e) => setCodGateways(e.target.value)}
              />
            </FormField>
            <FormField
              label="RTO round-trip (days)"
              hint="How long a returned parcel takes to come back and be re-shelved"
            >
              <TextInput type="number" min={0} value={rtoTransitDays} onChange={(e) => setRtoTransitDays(e.target.value)} />
            </FormField>
            <FormField
              label="Confirmed-order tag"
              hint="The order tag your team applies once a COD order is verified. Leave blank if you don't track confirmation."
            >
              <TextInput
                value={confirmedOrderTag}
                placeholder="confirmed"
                onChange={(e) => setConfirmedOrderTag(e.target.value)}
              />
            </FormField>
          </div>

          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--inv-text-2)", marginBottom: "10px" }}>Purchasing</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "18px" }}>
            <FormField
              label="Coverage target (days)"
              hint="How many days of demand a suggested purchase order should cover"
            >
              <TextInput type="number" min={1} value={coverageDays} onChange={(e) => setCoverageDays(e.target.value)} />
            </FormField>
          </div>

          <div style={{ height: "1px", background: "var(--inv-divider)", margin: "18px 0" }} />

          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--inv-text-2)", marginBottom: "10px" }}>Notifications</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "8px" }}>
            <FormField label="Notification email">
              <TextInput type="email" value={notificationEmail} onChange={(e) => setNotificationEmail(e.target.value)} placeholder="alerts@yourbusiness.com" />
            </FormField>
            <FormField label="Slack webhook URL">
              <TextInput value={slackWebhookUrl} onChange={(e) => setSlackWebhookUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" />
            </FormField>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "8px" }}>
            <FormField label="WhatsApp number" hint="Destination number for alert delivery via WAHA">
              <TextInput value={whatsappNumber} onChange={(e) => setWhatsappNumber(e.target.value)} placeholder="+92300…" />
            </FormField>
          </div>
          <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "18px" }}>
            WhatsApp delivery uses WAHA, an unofficial WhatsApp client (not the Meta Business API) —
            treat it as best-effort; sends can fail if WhatsApp flags the paired number.
          </div>

          <Button
            variant="primary"
            disabled={isBusy}
            onClick={() =>
              fetcher.submit(
                {
                  intent: "update_thresholds",
                  leadTimeDays: leadTime,
                  applyLeadTimeToExisting: String(applyLeadTimeToExisting),
                  serviceLevel,
                  safetyStockDays,
                  deadStockDays,
                  deadStockMinUnits,
                  coverageDays,
                  rtoTransitDays,
                  codGateways,
                  confirmedOrderTag,
                  notificationEmail,
                  slackWebhookUrl,
                  whatsappNumber,
                },
                { method: "POST" },
              )
            }
          >
            Save settings
          </Button>
        </Card>

        <Card style={{ marginBottom: "14px" }}>
          <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "10px" }}>Barcode scanning &amp; labels</div>
          <div style={{ fontSize: "12.5px", color: "var(--inv-text-2)", lineHeight: 1.6, marginBottom: "10px" }}>
            No barcodes on your products? Generate and print them from the{" "}
            <a href="/app/labels" style={{ color: "var(--inv-accent)" }}>Barcode Labels</a> page — a scannable code
            is made from each SKU, so an unbranded catalogue can be scanned just like a branded one.
          </div>
          <div style={{ fontSize: "12.5px", color: "var(--inv-text-2)", lineHeight: 1.6, marginBottom: "10px" }}>
            Wherever you see the scan field — on stock adjustments, purchase-order receiving, and the
            inventory search box — you can scan a barcode
            instead of typing. The barcode comes from each variant&apos;s <b>Barcode</b> field in Shopify and
            syncs automatically; a scan matches it exactly, falling back to SKU. A USB or Bluetooth scanner needs
            no setup: it types the code and presses Enter, which is all the field listens for.
          </div>
          <div
            style={{
              fontSize: "12px",
              color: "var(--inv-text-2)",
              background: "var(--inv-subtle)",
              border: "1px solid var(--inv-divider-3)",
              borderRadius: "10px",
              padding: "12px 14px",
              lineHeight: 1.6,
            }}
          >
            <b>No scanner? Use your phone.</b> Install <b>Barcode to PC: Wi-Fi scanner</b> from the Google Play
            Store (also on the App Store) and its free companion on your computer. Keep the phone and computer on
            the <b>same Wi-Fi network</b> — that is what lets them pair — then scan with the phone&apos;s camera
            straight into any scan field. An <b>Android phone with a Windows PC on one Wi-Fi</b> is the most
            reliable combination to start with.
          </div>
        </Card>

        <Card style={{ marginBottom: "14px" }}>
          <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "16px" }}>Appearance</div>
          <FilterChips
            options={[
              { value: "emerald", label: "Emerald" },
              { value: "indigo", label: "Indigo" },
            ]}
            active={theme}
            onChange={(value) => fetcher.submit({ intent: "update_theme", theme: value }, { method: "POST" })}
          />
        </Card>

        <Card style={{ marginBottom: "14px" }}>
          <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "16px" }}>Daily alerts (cron)</div>
          <div
            style={{
              fontFamily: "var(--inv-font-mono)",
              fontSize: "12px",
              background: "var(--inv-subtle)",
              border: "1px solid var(--inv-divider-3)",
              borderRadius: "10px",
              padding: "12px 14px",
              color: "#5d5a51",
            }}
          >
            POST {data.appUrl}/api/cron/alerts
          </div>
          <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginTop: "8px" }}>
            Header: x-cron-secret · CRON_SECRET is{" "}
            <span
              style={{
                color: data.cronSecret === "set" ? "var(--inv-status-healthy-fg)" : "var(--inv-status-critical-fg)",
                background: data.cronSecret === "set" ? "var(--inv-status-healthy-bg)" : "var(--inv-status-critical-bg)",
                padding: "1px 7px",
                borderRadius: "5px",
                fontFamily: "var(--inv-font-mono)",
              }}
            >
              {data.cronSecret}
            </span>
          </div>
        </Card>

        <Card>
          <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "16px" }}>Suite integrations</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <IntegrationCard
              name="Courierify"
              desc="Syncs COD return rates, per-SKU fulfilment status (delivered · in-transit · returned), and returned parcels into the restock queue."
              connected={data.courierifyConnected}
              keyValue={courierifyKey}
              onKeyChange={setCourierifyKey}
              isBusy={isBusy}
              onConnect={() => fetcher.submit({ intent: "save_courierify", courierifyKey }, { method: "POST" })}
              onDisconnect={() => fetcher.submit({ intent: "disconnect_courierify" }, { method: "POST" })}
              onResync={() => fetcher.submit({ intent: "resync_courierify" }, { method: "POST" })}
            />
            <IntegrationCard
              name="Financify"
              desc="Syncs average margin per SKU for profitability-weighted reorder decisions."
              connected={data.financifyConnected}
              keyValue={financifyKey}
              onKeyChange={setFinancifyKey}
              isBusy={isBusy}
              onConnect={() => fetcher.submit({ intent: "save_financify", financifyKey }, { method: "POST" })}
              onDisconnect={() => fetcher.submit({ intent: "disconnect_financify" }, { method: "POST" })}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}

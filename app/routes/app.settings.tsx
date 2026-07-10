import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncShopifyInventory } from "../lib/shopify-sync.server";
import { syncOrderHistory } from "../lib/order-sync.server";
import { syncCourierifyReturnRates } from "../lib/courierify.server";
import { syncFinancifyMargins } from "../lib/financify.server";
import { Button, Card, FormField, PageHead, TextInput } from "../design";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [settings, productCount] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { shop } }),
    prisma.product.count({ where: { shop } }),
  ]);

  return {
    shop,
    productCount,
    defaultLeadTime: settings?.defaultLeadTime ?? 7,
    serviceLevel: settings?.serviceLevel ?? 1.65,
    safetyStockDays: settings?.safetyStockDays ?? 7,
    deadStockDays: settings?.deadStockDays ?? 60,
    deadStockMinUnits: settings?.deadStockMinUnits ?? 20,
    notificationEmail: settings?.notificationEmail ?? "",
    slackWebhookUrl: settings?.slackWebhookUrl ?? "",
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
    const { synced, errors } = await syncShopifyInventory(admin, shop);
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
    return { intent, synced, errors, recordsSynced };
  }

  if (intent === "update_thresholds") {
    const leadTimeDays = parseInt(formData.get("leadTimeDays") as string, 10);
    const serviceLevel = parseFloat(formData.get("serviceLevel") as string);
    const safetyStockDays = parseInt(formData.get("safetyStockDays") as string, 10);
    const deadStockDays = parseInt(formData.get("deadStockDays") as string, 10);
    const deadStockMinUnits = parseInt(formData.get("deadStockMinUnits") as string, 10);
    const notificationEmail = (formData.get("notificationEmail") as string)?.trim() || null;
    const slackWebhookUrl = (formData.get("slackWebhookUrl") as string)?.trim() || null;

    const update: Record<string, unknown> = {};
    if (!isNaN(leadTimeDays) && leadTimeDays > 0) {
      update.defaultLeadTime = leadTimeDays;
      await prisma.product.updateMany({ where: { shop }, data: { leadTimeDays } });
    }
    if (!isNaN(serviceLevel) && serviceLevel > 0) update.serviceLevel = serviceLevel;
    if (!isNaN(safetyStockDays) && safetyStockDays > 0) update.safetyStockDays = safetyStockDays;
    if (!isNaN(deadStockDays) && deadStockDays > 0) update.deadStockDays = deadStockDays;
    if (!isNaN(deadStockMinUnits) && deadStockMinUnits >= 0) update.deadStockMinUnits = deadStockMinUnits;
    update.notificationEmail = notificationEmail;
    update.slackWebhookUrl = slackWebhookUrl;

    await prisma.shopSettings.upsert({ where: { shop }, create: { shop, ...update }, update });
    return { intent, updated: true };
  }

  if (intent === "save_courierify") {
    const apiKey = (formData.get("courierifyKey") as string)?.trim();
    if (!apiKey) return { intent, error: "API key is required" };

    const result = await syncCourierifyReturnRates(shop, apiKey);
    if (result.error) return { intent, error: result.error };

    await prisma.shopSettings.upsert({
      where: { shop },
      create: { shop, courierifyApiKey: apiKey },
      update: { courierifyApiKey: apiKey },
    });
    return { intent, synced: result.synced };
  }

  if (intent === "save_financify") {
    const apiKey = (formData.get("financifyKey") as string)?.trim();
    if (!apiKey) return { intent, error: "API key is required" };

    const result = await syncFinancifyMargins(shop, apiKey);
    if (result.error) return { intent, error: result.error };

    await prisma.shopSettings.upsert({
      where: { shop },
      create: { shop, financifyApiKey: apiKey },
      update: { financifyApiKey: apiKey },
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
  isBusy,
}: {
  name: string;
  desc: string;
  connected: boolean;
  keyValue: string;
  onKeyChange: (v: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
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
        <Button variant="ghost" disabled={isBusy} onClick={onDisconnect} style={{ width: "100%" }}>
          Disconnect
        </Button>
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

  const [courierifyKey, setCourierifyKey] = useState("");
  const [financifyKey, setFinancifyKey] = useState("");
  const [leadTime, setLeadTime] = useState(String(data.defaultLeadTime));
  const [serviceLevel, setServiceLevel] = useState(String(data.serviceLevel));
  const [safetyStockDays, setSafetyStockDays] = useState(String(data.safetyStockDays));
  const [deadStockDays, setDeadStockDays] = useState(String(data.deadStockDays));
  const [deadStockMinUnits, setDeadStockMinUnits] = useState(String(data.deadStockMinUnits));
  const [notificationEmail, setNotificationEmail] = useState(data.notificationEmail ?? "");
  const [slackWebhookUrl, setSlackWebhookUrl] = useState(data.slackWebhookUrl ?? "");

  const isBusy = fetcher.state !== "idle";
  const result = fetcher.data as Record<string, unknown> | undefined;

  useEffect(() => {
    if (!result) return;
    if (result.intent === "sync") {
      shopify.toast.show(`Synced ${result.synced} variants · ${result.recordsSynced} sales records`);
    } else if (result.intent === "update_thresholds") {
      shopify.toast.show("Settings saved");
    } else if (result.intent === "save_courierify") {
      if (result.error) shopify.toast.show(String(result.error), { isError: true });
      else shopify.toast.show(`Courierify connected — ${result.synced} SKUs updated`);
    } else if (result.intent === "save_financify") {
      if (result.error) shopify.toast.show(String(result.error), { isError: true });
      else shopify.toast.show(`Financify connected — ${result.synced} SKUs updated`);
    } else if (result.intent === "disconnect_courierify" || result.intent === "disconnect_financify") {
      shopify.toast.show("Disconnected");
    }
  }, [result, shopify]);

  return (
    <div className="inv-root" style={{ minHeight: "100vh" }}>
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "18px" }}>
            <FormField label="Default lead time (days)" hint="Applied to new products">
              <TextInput type="number" min={1} value={leadTime} onChange={(e) => setLeadTime(e.target.value)} />
            </FormField>
            <FormField label="Safety stock fallback (days)" hint="When variance data unavailable">
              <TextInput type="number" min={1} value={safetyStockDays} onChange={(e) => setSafetyStockDays(e.target.value)} />
            </FormField>
          </div>

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

          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--inv-text-2)", marginBottom: "10px" }}>Notifications</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "18px" }}>
            <FormField label="Notification email">
              <TextInput type="email" value={notificationEmail} onChange={(e) => setNotificationEmail(e.target.value)} placeholder="alerts@yourbusiness.com" />
            </FormField>
            <FormField label="Slack webhook URL">
              <TextInput value={slackWebhookUrl} onChange={(e) => setSlackWebhookUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" />
            </FormField>
          </div>

          <Button
            variant="primary"
            disabled={isBusy}
            onClick={() =>
              fetcher.submit(
                {
                  intent: "update_thresholds",
                  leadTimeDays: leadTime,
                  serviceLevel,
                  safetyStockDays,
                  deadStockDays,
                  deadStockMinUnits,
                  notificationEmail,
                  slackWebhookUrl,
                },
                { method: "POST" },
              )
            }
          >
            Save settings
          </Button>
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
              desc="Syncs COD return rates per SKU to power accurate net demand forecasts."
              connected={data.courierifyConnected}
              keyValue={courierifyKey}
              onKeyChange={setCourierifyKey}
              isBusy={isBusy}
              onConnect={() => fetcher.submit({ intent: "save_courierify", courierifyKey }, { method: "POST" })}
              onDisconnect={() => fetcher.submit({ intent: "disconnect_courierify" }, { method: "POST" })}
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

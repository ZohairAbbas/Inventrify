import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  TextField,
  Button,
  Text,
  Badge,
  InlineStack,
  Divider,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncShopifyInventory } from "../lib/shopify-sync.server";
import { syncOrderHistory } from "../lib/order-sync.server";
import { syncCourierifyReturnRates } from "../lib/courierify.server";
import { syncFinancifyMargins } from "../lib/financify.server";

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
    // Refresh shop timezone + currency
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

    await prisma.shopSettings.upsert({
      where: { shop },
      create: { shop, ...update },
      update,
    });
    return { intent, updated: true };
  }

  if (intent === "update_lead_time") {
    const leadTimeDays = parseInt(formData.get("leadTimeDays") as string, 10);
    if (!isNaN(leadTimeDays) && leadTimeDays > 0) {
      await prisma.shopSettings.upsert({
        where: { shop },
        create: { shop, defaultLeadTime: leadTimeDays },
        update: { defaultLeadTime: leadTimeDays },
      });
      await prisma.product.updateMany({
        where: { shop },
        data: { leadTimeDays },
      });
    }
    return { intent, updated: true };
  }

  if (intent === "save_courierify") {
    const apiKey = (formData.get("courierifyKey") as string)?.trim();
    if (!apiKey) return { intent, error: "API key is required" };

    // Test + save
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
    } else if (result.intent === "update_thresholds" || result.intent === "update_lead_time") {
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
    <Page>
      <TitleBar title="Settings" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">

            {/* Inventory Sync */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Inventory Sync</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  {data.productCount} variants tracked · {data.shop}
                </Text>
                <Button
                  loading={isBusy}
                  variant="primary"
                  onClick={() => fetcher.submit({ intent: "sync" }, { method: "POST" })}
                >
                  Sync Inventory + Order History
                </Button>
              </BlockStack>
            </Card>

            {/* Inventory intelligence settings */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Inventory Intelligence</Text>
                <BlockStack gap="400">
                  <BlockStack gap="400">
                    <Text as="h3" variant="headingSm">Reorder & Lead Times</Text>
                    <InlineStack gap="300" wrap>
                      <div style={{ flex: 1, minWidth: 160 }}>
                        <TextField
                          label="Default Lead Time (days)"
                          type="number"
                          value={leadTime}
                          onChange={setLeadTime}
                          name="leadTimeDays"
                          autoComplete="off"
                          helpText="Applied to new products"
                          min={1}
                        />
                      </div>
                      <div style={{ flex: 1, minWidth: 160 }}>
                        <TextField
                          label="Safety Stock Fallback (days)"
                          type="number"
                          value={safetyStockDays}
                          onChange={setSafetyStockDays}
                          name="safetyStockDays"
                          autoComplete="off"
                          helpText="Used when variance data unavailable"
                          min={1}
                        />
                      </div>
                    </InlineStack>
                    <Text as="h3" variant="headingSm">Safety Stock Service Level</Text>
                    <InlineStack gap="300" wrap>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <TextField
                          label="Service Level Z-score"
                          type="number"
                          value={serviceLevel}
                          onChange={setServiceLevel}
                          name="serviceLevel"
                          autoComplete="off"
                          helpText="1.28=90% · 1.65=95% · 2.05=98%"
                          step={0.01}
                          min={0.5}
                          max={3}
                        />
                      </div>
                    </InlineStack>
                    <Text as="h3" variant="headingSm">Dead Stock Thresholds</Text>
                    <InlineStack gap="300" wrap>
                      <div style={{ flex: 1, minWidth: 160 }}>
                        <TextField
                          label="No-sales window (days)"
                          type="number"
                          value={deadStockDays}
                          onChange={setDeadStockDays}
                          name="deadStockDays"
                          autoComplete="off"
                          helpText="Trigger dead stock alert after this many days with no sales"
                          min={1}
                        />
                      </div>
                      <div style={{ flex: 1, minWidth: 160 }}>
                        <TextField
                          label="Min units threshold"
                          type="number"
                          value={deadStockMinUnits}
                          onChange={setDeadStockMinUnits}
                          name="deadStockMinUnits"
                          autoComplete="off"
                          helpText="Only alert if stock is above this level"
                          min={0}
                        />
                      </div>
                    </InlineStack>
                    <Divider />
                    <Text as="h3" variant="headingSm">Notifications</Text>
                    <TextField
                      label="Notification Email"
                      type="email"
                      value={notificationEmail}
                      onChange={setNotificationEmail}
                      name="notificationEmail"
                      autoComplete="email"
                      placeholder="alerts@yourbusiness.com"
                    />
                    <TextField
                      label="Slack Webhook URL"
                      value={slackWebhookUrl}
                      onChange={setSlackWebhookUrl}
                      name="slackWebhookUrl"
                      autoComplete="off"
                      placeholder="https://hooks.slack.com/services/..."
                    />
                    <InlineStack>
                      <Button
                        loading={isBusy}
                        variant="primary"
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
                        Save Settings
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </BlockStack>
              </BlockStack>
            </Card>

            {/* Alerts cron info */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Daily Alerts (Cron)</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  To run alerts daily, schedule a POST request to:
                </Text>
                <code style={{ background: "#f6f6f7", padding: "8px 12px", borderRadius: 4, fontSize: 13, display: "block" }}>
                  POST {data.appUrl}/api/cron/alerts
                </code>
                <Text as="p" variant="bodySm" tone="subdued">
                  Include header: <code>x-cron-secret: &lt;CRON_SECRET&gt;</code>
                  {" — "}CRON_SECRET env var is{" "}
                  <Badge tone={data.cronSecret === "set" ? "success" : "critical"}>
                    {data.cronSecret}
                  </Badge>
                </Text>
              </BlockStack>
            </Card>

            {/* Suite Integrations */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Suite Integrations</Text>
                <Divider />

                {/* Courierify */}
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text as="h3" variant="headingSm">Courierify</Text>
                    <Badge tone={data.courierifyConnected ? "success" : "new"}>
                      {data.courierifyConnected ? "Connected" : "Not connected"}
                    </Badge>
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Syncs COD return rates per SKU to power accurate net demand forecasts.
                  </Text>
                  {data.courierifyConnected ? (
                    <Button
                      size="slim"
                      tone="critical"
                      loading={isBusy}
                      onClick={() => fetcher.submit({ intent: "disconnect_courierify" }, { method: "POST" })}
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <BlockStack gap="200">
                      <TextField
                        label="Courierify API Key"
                        value={courierifyKey}
                        onChange={setCourierifyKey}
                        type="password"
                        autoComplete="off"
                        placeholder="Enter your Courierify API key"
                      />
                      <InlineStack>
                        <Button
                          loading={isBusy}
                          disabled={!courierifyKey}
                          onClick={() => fetcher.submit({ intent: "save_courierify", courierifyKey }, { method: "POST" })}
                        >
                          Connect & Sync
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  )}
                </BlockStack>

                <Divider />

                {/* Financify */}
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text as="h3" variant="headingSm">Financify</Text>
                    <Badge tone={data.financifyConnected ? "success" : "new"}>
                      {data.financifyConnected ? "Connected" : "Not connected"}
                    </Badge>
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Syncs average margin per SKU for profitability-weighted reorder decisions.
                  </Text>
                  {data.financifyConnected ? (
                    <Button
                      size="slim"
                      tone="critical"
                      loading={isBusy}
                      onClick={() => fetcher.submit({ intent: "disconnect_financify" }, { method: "POST" })}
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <BlockStack gap="200">
                      <TextField
                        label="Financify API Key"
                        value={financifyKey}
                        onChange={setFinancifyKey}
                        type="password"
                        autoComplete="off"
                        placeholder="Enter your Financify API key"
                      />
                      <InlineStack>
                        <Button
                          loading={isBusy}
                          disabled={!financifyKey}
                          onClick={() => fetcher.submit({ intent: "save_financify", financifyKey }, { method: "POST" })}
                        >
                          Connect & Sync
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  )}
                </BlockStack>
              </BlockStack>
            </Card>

          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

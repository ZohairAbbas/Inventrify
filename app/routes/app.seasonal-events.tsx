import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  TextField,
  Button,
  InlineStack,
  Badge,
  DataTable,
  EmptyState,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const events = await prisma.seasonalEvent.findMany({
    where: { shop: session.shop },
    orderBy: { startDate: "asc" },
  });
  return { events };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create") {
    const name = (formData.get("name") as string)?.trim();
    const startDate = formData.get("startDate") as string;
    const endDate = formData.get("endDate") as string;
    const impactMultiplier = parseFloat(
      formData.get("impactMultiplier") as string,
    );
    const productTags = (formData.get("productTags") as string)?.trim() ?? "";
    const notes = (formData.get("notes") as string)?.trim() ?? "";

    if (!name || !startDate || !endDate || isNaN(impactMultiplier)) {
      return { error: "Name, start date, end date, and impact are required" };
    }
    if (impactMultiplier <= 0) {
      return { error: "Impact multiplier must be positive" };
    }
    if (new Date(startDate) > new Date(endDate)) {
      return { error: "Start date must be before end date" };
    }

    await prisma.seasonalEvent.create({
      data: {
        shop,
        name,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        impactMultiplier,
        productTags,
        notes: notes || null,
      },
    });
    return { ok: true };
  }

  if (intent === "delete") {
    const id = formData.get("id") as string;
    await prisma.seasonalEvent.deleteMany({ where: { id, shop } });
    return { ok: true };
  }

  return { ok: true };
};

export default function SeasonalEvents() {
  const { events } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [multiplier, setMultiplier] = useState("1.5");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");

  const isBusy = fetcher.state !== "idle";
  const result = fetcher.data as Record<string, unknown> | undefined;

  useEffect(() => {
    if (result?.ok) {
      shopify.toast.show("Saved");
      setName("");
      setStartDate("");
      setEndDate("");
      setMultiplier("1.5");
      setTags("");
      setNotes("");
    }
    if (result?.error) {
      shopify.toast.show(String(result.error), { isError: true });
    }
  }, [result, shopify]);

  const now = new Date();
  const getEventStatus = (event: { startDate: string; endDate: string }) => {
    const start = new Date(event.startDate);
    const end = new Date(event.endDate);
    if (now >= start && now <= end) return "active";
    if (start > now) return "upcoming";
    return "past";
  };

  const statusTone = { active: "success" as const, upcoming: "info" as const, past: "subdued" as const };

  const tableRows = events.map((e) => {
    const status = getEventStatus(e);
    return [
      <InlineStack gap="200" key={e.id}>
        <Text as="span" fontWeight="semibold">{e.name}</Text>
        <Badge tone={statusTone[status]}>{status}</Badge>
      </InlineStack>,
      new Date(e.startDate).toLocaleDateString(),
      new Date(e.endDate).toLocaleDateString(),
      <Badge key={`m-${e.id}`} tone="warning">{e.impactMultiplier}×</Badge>,
      e.productTags || "All products",
      <Button
        key={`d-${e.id}`}
        size="slim"
        tone="critical"
        loading={isBusy}
        onClick={() => fetcher.submit({ intent: "delete", id: e.id }, { method: "POST" })}
      >
        Delete
      </Button>,
    ];
  });

  return (
    <Page>
      <TitleBar title="Seasonal Events" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <Banner tone="info" title="How seasonal events work">
              Events apply a demand multiplier to forecasts during the event period.
              For example, Eid ul Fitr with 2.0× means we forecast 2× normal demand.
              Events with product tags only apply to products with matching tags.
            </Banner>

            {/* Create form */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Add Seasonal Event</Text>
                <BlockStack gap="300">
                  <TextField
                    label="Event Name"
                    value={name}
                    onChange={setName}
                    autoComplete="off"
                    placeholder="e.g. Eid ul Fitr, Ramadan, Back to School"
                  />
                  <InlineStack gap="300">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Start Date"
                        type="date"
                        value={startDate}
                        onChange={setStartDate}
                        autoComplete="off"
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="End Date"
                        type="date"
                        value={endDate}
                        onChange={setEndDate}
                        autoComplete="off"
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Demand Multiplier"
                        type="number"
                        value={multiplier}
                        onChange={setMultiplier}
                        autoComplete="off"
                        helpText="1.5 = +50% demand"
                        min={0.1}
                        step={0.1}
                      />
                    </div>
                  </InlineStack>
                  <TextField
                    label="Product Tags (optional)"
                    value={tags}
                    onChange={setTags}
                    autoComplete="off"
                    placeholder="Comma-separated tags, empty = all products"
                    helpText="Filter which products this event affects by Shopify product tags"
                  />
                  <TextField
                    label="Notes (optional)"
                    value={notes}
                    onChange={setNotes}
                    autoComplete="off"
                    multiline={2}
                  />
                  <InlineStack>
                    <Button
                      variant="primary"
                      loading={isBusy}
                      disabled={!name || !startDate || !endDate}
                      onClick={() =>
                        fetcher.submit(
                          { intent: "create", name, startDate, endDate, impactMultiplier: multiplier, productTags: tags, notes },
                          { method: "POST" },
                        )
                      }
                    >
                      Add Event
                    </Button>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

            {/* Events list */}
            <Card padding="0">
              {events.length === 0 ? (
                <EmptyState
                  heading="No seasonal events yet"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    Add Eid, Ramadan, Black Friday, or any local demand event to
                    improve your forecast accuracy.
                  </p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                  ]}
                  headings={[
                    "Event",
                    "Start",
                    "End",
                    "Multiplier",
                    "Applies To",
                    "",
                  ]}
                  rows={tableRows}
                />
              )}
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

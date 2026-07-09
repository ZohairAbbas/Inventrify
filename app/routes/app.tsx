import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import invTokens from "../design/tokens.css?url";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: invTokens },
];

const SHOP_QUERY = `{ shop { ianaTimezone currencyCode } }`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  let settings = await prisma.shopSettings.findUnique({ where: { shop } });

  // Fetch from Shopify only when no settings record exists yet (new install)
  if (!settings) {
    try {
      const resp = await admin.graphql(SHOP_QUERY);
      const { data } = await resp.json();
      const timezone: string = data?.shop?.ianaTimezone ?? "UTC";
      const currency: string = data?.shop?.currencyCode ?? "USD";
      settings = await prisma.shopSettings.create({
        data: { shop, timezone, currency },
      });
    } catch {
      // non-fatal — use defaults
    }
  }

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    timezone: settings?.timezone ?? "UTC",
    currency: settings?.currency ?? "USD",
  };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">Dashboard</Link>
        <Link to="/app/inventory">Inventory</Link>
        <Link to="/app/forecast">Forecast</Link>
        <Link to="/app/analytics">Analytics</Link>
        <Link to="/app/purchase-orders">Purchase Orders</Link>
        <Link to="/app/suppliers">Suppliers</Link>
        <Link to="/app/seasonal-events">Seasonal Events</Link>
        <Link to="/app/stock-adjustments">Stock Adjustments</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { syncShopifyInventory } from "./lib/shopify-sync.server";
import { syncOrderHistory } from "./lib/order-sync.server";
import { generateAlerts } from "./lib/alerts.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ session, admin }) => {
      // Register webhooks on every auth (install + re-auth)
      shopify.registerWebhooks({ session });

      // Auto-sync inventory + order history on first install
      try {
        console.log(`[inventorify] afterAuth: syncing ${session.shop}`);
        await syncShopifyInventory(admin, session.shop);
        await syncOrderHistory(admin, session.shop);
        await generateAlerts(session.shop);
        console.log(`[inventorify] afterAuth: sync complete for ${session.shop}`);
      } catch (err) {
        console.error(`[inventorify] afterAuth sync failed for ${session.shop}:`, err);
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

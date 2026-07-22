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
  // Must match [webhooks] api_version in shopify.app.toml (2026-04). These had drifted
  // 15 months apart: webhooks were registered at 2026-04 while Admin queries ran at
  // January25, so payload shapes and query fields were being validated against
  // different versions of the API.
  apiVersion: ApiVersion.April26,
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

      // Initial sync runs detached from the OAuth response.
      //
      // Awaiting a full catalogue + 90-day order backfill inside afterAuth meant the
      // install request stayed open for the whole sync. On any real catalogue that
      // exceeds the platform's request timeout, so the install itself fails — the
      // larger the merchant, the more certain the failure. The redirect now completes
      // immediately and the sync proceeds in the background.
      void (async () => {
        try {
          console.log(`[inventorify] initial sync starting for ${session.shop}`);
          const inventory = await syncShopifyInventory(admin, session.shop);
          if (!inventory.completed) {
            console.error(
              `[inventorify] initial inventory sync incomplete for ${session.shop}: ${inventory.error}`,
            );
          }
          await syncOrderHistory(admin, session.shop);
          await generateAlerts(session.shop);
          console.log(`[inventorify] initial sync complete for ${session.shop}`);
        } catch (err) {
          console.error(`[inventorify] initial sync failed for ${session.shop}:`, err);
        }
      })();
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

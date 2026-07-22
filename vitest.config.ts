import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],
    // Database-backed tests are opt-in: they need a scratch Postgres whose name ends in
    // `_test` and would otherwise fail a plain `npm test` on a machine without one.
    // Run them with `npm run test:db`.
    exclude: ["**/node_modules/**", "**/*.db.test.ts"],
  },
});

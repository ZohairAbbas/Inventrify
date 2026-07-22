import { defineConfig } from "vitest/config";

/**
 * Database-backed tests. Kept in a separate config so `npm test` stays runnable with no
 * Postgres at all; these need a scratch database whose name ends in `_test`.
 *
 *   npm run test:db
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.db.test.ts"],
    // Sequential: the suites share one database and truncate between cases.
    fileParallelism: false,
  },
});

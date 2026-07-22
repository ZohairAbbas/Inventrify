/** @type {import('@types/eslint').Linter.BaseConfig} */
module.exports = {
  root: true,
  extends: [
    "@remix-run/eslint-config",
    "@remix-run/eslint-config/node",
    "@remix-run/eslint-config/jest-testing-library",
    "prettier",
  ],
  globals: {
    shopify: "readonly"
  },
  settings: {
    // The Remix preset pulls in eslint-plugin-jest, which probes for an installed jest
    // package to decide which rules apply. Tests here run on vitest, so that probe
    // throws and takes the whole lint run down. Pinning a version stops the probe; the
    // describe/it/expect surface the rules check is the same under vitest.
    jest: { version: 29 },
  },
};

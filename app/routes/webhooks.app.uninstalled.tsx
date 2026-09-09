/**
 * Legacy uninstall endpoint.
 *
 * `shopify.app.toml` subscribes `app/uninstalled` to `/webhooks`, but this path is still
 * live and still named by `shopify.web.toml` (`webhooks_path`), so a delivery can arrive
 * here — from an older subscription registered against a previous app version, or from
 * tooling that reads that config. It cannot simply be deleted: a 404 would make Shopify
 * retry and then give up, losing the uninstall entirely.
 *
 * It used to handle the topic itself, and handled it wrongly — deleting the session and
 * nothing else, so every row of tenant data outlived the uninstall. Worse, removing the
 * session here meant that if a redelivery then reached the real handler, its
 * `if (session)` guard skipped the purge as well. It now delegates to the single
 * implementation in ./webhooks, so both paths behave identically.
 */
export { action } from "./webhooks";

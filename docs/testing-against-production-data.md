# Testing against production data

Restoring a production dump into a scratch database is a good way to validate a change.
There is exactly one thing you must not do, and it will cost a merchant's connection if
you get it wrong.

## Never copy `Session` rows into a second database

The app is configured with `expiringOfflineAccessTokens: true`
(`app/shopify.server.ts`). Under that setting:

- the offline access token expires after roughly 24 hours,
- it is renewed with a **single-use refresh token**,
- the renewal writes the new pair back to whichever `Session` row the running process is
  pointed at.

So if you copy `Session` rows into a scratch database and then call
`unauthenticated.admin(shop)` there, the scratch process consumes the shop's refresh token
and stores the replacement **in the scratch database**. Production is left holding a token
pair that can never be renewed again. Dropping the scratch database destroys the only
working credentials.

The failure is silent until the next sync, which then reports:

```
authentication failed (HTTP 500) — the shop's token is no longer valid;
it must reinstall or re-authorise the app
```

This happened on 2026-07-22 to `0dscam-qn.myshopify.com`. The shop synced normally at
16:20, a validation run against a scratch copy at 18:39 consumed its refresh token, and
every subsequent production sync failed. Recovery required a merchant to reopen the app.

## What to do instead

**Validating schema/migrations against real data** — safe. Restore the dump, run
`prisma migrate deploy`, check row counts and integrity. Do not call Shopify.

**Exercising code that calls Shopify** — use the fixture harness, not live credentials.
`app/lib/shopify-sync.db.test.ts` drives the sync through a stub admin client and covers
pagination, throttling, scope failures and the archive sweep without a single real request.

**Genuinely need a live API call** — make it against the production database, read-only,
and accept that it will refresh the token there (which is correct and harmless, because
that is the row the app itself uses). Never against a copy.

**Belt and braces** — truncate `Session` immediately after restoring a dump:

```sql
TRUNCATE "Session";
```

A scratch database with no sessions cannot consume anyone's refresh token. Anything that
needs authentication will fail loudly and immediately instead of quietly stealing
production's credentials.

## Recovery, if it has already happened

The refresh token cannot be un-consumed. Someone with access to the store must open the
app once in the Shopify admin, which re-runs OAuth and writes a fresh pair. No data is
lost — products, demand history and forecasts are all still there, and the next sync
backfills the gap.

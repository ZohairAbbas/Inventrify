# Inventrify Cron Scheduling — Instructions for the Prod Instance

**For:** the Claude instance with access to the Inventrify prod box (pm2 / crontab / systemd / prod env).
**Why you and not the repo instance:** the endpoints already exist in code and are healthy. What's missing
is purely a **server-side scheduler** to call them — which only you can see and set up. Nothing to change
in the Inventrify repo.

---

## Background (verified earlier)

Inventrify has **two cron HTTP endpoints**. Neither is an OS cron/worker — each is an endpoint an external
scheduler must POST to, with header `x-cron-secret: <CRON_SECRET>`. Both also expose a GET healthcheck.

| Endpoint | What it does | Cadence | Notes |
|---|---|---|---|
| `POST /api/cron/alerts` | Generates + dispatches stock alerts (Resend email) for every shop with an active session | **Daily** | **Dormant since 2026-03-29** — zero POSTs ever in prod logs. No shop has had a stock alert in ~4 months. First real run may emit a backlog burst — see caution below. |
| `POST /api/cron/courierify` | Syncs Courierify fulfilment status + returns queue for shops with a `courierifyApiKey` | **Hourly** | Landed recently; safe to run anytime (no-ops for shops without a key). |

**Pattern to match:** other suite apps already run dedicated pm2 scheduler processes on this box
(`preventify-cron`, `marketlytics-scheduler`, `reportify-scheduler`). Inventrify has **no equivalent** —
that's the gap. Add one in the same style.

---

## What to do

### 1. Get the real values (don't assume)
- **`CRON_SECRET`** — read the *prod* value from however prod loads env (pm2 ecosystem `env`, systemd unit,
  or the prod `.env`). The scheduler must send this exact string as `x-cron-secret`. Confirm the app and
  the scheduler agree on it (a mismatch → 401).
- **Base URL** — the prod app's real address. Public (`https://inventorify.growzar.com`) or a
  localhost:port binding both work; prefer whichever the other suite schedulers use for their own apps.

### 2. Add the schedule — match the existing suite pattern
Set up two scheduled POSTs. Use whatever mechanism your other apps use (pm2 cron process is the house
style; plain crontab is fine too). Conceptually:

```
# hourly — Courierify sync
0 * * * *  curl -fsS -X POST "$BASE/api/cron/courierify" -H "x-cron-secret: $CRON_SECRET"

# daily — stock alerts (see caution before enabling)
30 6 * * * curl -fsS -X POST "$BASE/api/cron/alerts" -H "x-cron-secret: $CRON_SECRET"
```
(Times are examples — align with the suite's conventions/timezone. A pm2 cron process calling the same
two URLs is equally good and more consistent with `preventify-cron` etc.)

### 3. Verify
- Hit each endpoint once manually with the secret → expect `200` JSON (`courierify` returns
  `{ shops, results }`; `alerts` returns `{ shops, totalAlerts, results }`).
- Wrong/absent secret → `401` (confirms the guard).
- After the first scheduled fire, check the app logs / nginx access log for the POSTs landing.

---

## ⚠️ Caution — the alerts endpoint emails live merchants

`/api/cron/alerts` sends **real emails via Resend**. Two consequences:
- **Do not smoke-test it against prod casually.** A manual POST triggers real sends. Test the *courierify*
  one freely (no emails); for *alerts*, either test on a staging shop or accept that the first run emails
  live shops.
- **Backlog burst:** it's been dormant ~4 months. The first real run generates alerts from current stock
  state for every eligible shop at once. That's expected, not a bug — but **watch the first fire** (volume,
  Resend rate limits, any dispatch errors in logs) rather than firing-and-forgetting.

If you'd rather de-risk: enable **`/api/cron/courierify` first** (harmless), confirm the scheduler mechanism
works end-to-end, then enable `/api/cron/alerts` once you're ready to watch the first send.

---

## Definition of done
- [ ] A scheduler (pm2 process or crontab) POSTs both endpoints on their cadences with the correct secret.
- [ ] Manual test: both return `200` with secret, `401` without.
- [ ] First scheduled fires observed in logs; Courierify shops refresh without a manual "Sync now".
- [ ] Alerts first-run watched (volume + errors) rather than fire-and-forget.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getGrowzarConfig, normaliseShopDomain } from "./config.server";
import { signedHeaders } from "./signing.server";

/**
 * Events to Growzar (API-CONTRACT §7), delivered at least once.
 *
 * Every event is written to a small on-disk outbox before any attempt is made, and is
 * only removed once Growzar answers 2xx. A failed attempt (network error, timeout, 5xx,
 * 408, 429) is retried on the contract's schedule — 1m, 5m, 30m, 2h, 6h, 12h — by the
 * cron worker calling /api/cron/growzar-events every minute. So a Growzar outage, or an
 * Inventorify restart in between, loses nothing.
 *
 * Why a directory and not a table: a table needs a migration and a `prisma generate`,
 * which Phase 1 may not run against this box, and the volume here is one row per
 * uninstall. The files hold only the envelope (shop domain, event id, times) — no
 * merchant data — and deliberately survive the shop purge, since the purge is what the
 * uninstall event is announcing. The app is a single pm2 fork, so an in-process guard is
 * enough to stop two deliveries of one file racing. A move to a table is natural in R2
 * when more topics join.
 */
export const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;

const EVENTS_PATH = "/api/v1/events";
const WRITE_TIMEOUT_MS = 10_000;

export type EventEnvelope = {
  eventId: string;
  topic: string;
  occurredAt: string;
  shop: string;
  actor: { type: string; id?: string };
  data: Record<string, unknown>;
};

type OutboxRecord = {
  /** The exact bytes that are signed and posted, fixed at enqueue time. */
  body: string;
  eventId: string;
  topic: string;
  shop: string;
  createdAt: string;
  /** Delivery attempts made so far. */
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
};

export function outboxDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.GROWZAR_OUTBOX_DIR?.trim() || path.join(process.cwd(), "data", "growzar-outbox");
}

/** When the next attempt is due after `attempts` failures, or null when retries are spent. */
export function nextRetryAt(attempts: number, now: number): number | null {
  const delay = RETRY_DELAYS_MS[attempts - 1];
  return delay === undefined ? null : now + delay;
}

/** UTC ISO 8601 to the second, as in the contract's examples. */
function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The `app.uninstalled` envelope for a Shopify APP_UNINSTALLED delivery.
 *
 * The event id is derived from Shopify's webhook id, so Shopify redelivering the same
 * uninstall produces the same event, which the outbox and Growzar both deduplicate. A
 * later reinstall-and-uninstall is a new webhook id and so a new event.
 */
export function uninstallEnvelope(options: {
  shop: string;
  webhookId: string | null;
  triggeredAt: string | null;
  now?: Date;
}): EventEnvelope {
  const shop = normaliseShopDomain(options.shop);
  if (!shop) throw new Error(`app.uninstalled: ${options.shop} is not a *.myshopify.com domain`);

  const triggered = options.triggeredAt ? new Date(options.triggeredAt) : null;
  const occurredAt =
    triggered && !Number.isNaN(triggered.getTime()) ? triggered : (options.now ?? new Date());

  const webhookKey = options.webhookId?.replace(/[^A-Za-z0-9_-]/g, "");
  return {
    eventId: `inventorify-uninstall-${webhookKey || randomUUID()}`,
    topic: "app.uninstalled",
    occurredAt: isoSeconds(occurredAt),
    shop,
    actor: { type: "shopify" },
    data: {},
  };
}

function fileFor(dir: string, eventId: string): string {
  return path.join(dir, `${eventId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

async function writeAtomic(target: string, record: OutboxRecord, { exclusive }: { exclusive: boolean }) {
  const tmp = path.join(path.dirname(target), `.tmp-${randomUUID()}`);
  await fs.writeFile(tmp, JSON.stringify(record));
  try {
    if (exclusive) {
      // link() fails if the target exists, which is the dedupe; the record is never
      // visible half-written.
      await fs.link(tmp, target);
    } else {
      await fs.rename(tmp, target);
      return;
    }
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** Put an event in the outbox. Enqueueing the same eventId twice is a no-op. */
export async function enqueueEvent(
  envelope: EventEnvelope,
  { dir = outboxDir(), now = new Date() }: { dir?: string; now?: Date } = {},
): Promise<{ queued: boolean }> {
  await fs.mkdir(dir, { recursive: true });
  const record: OutboxRecord = {
    body: JSON.stringify(envelope),
    eventId: envelope.eventId,
    topic: envelope.topic,
    shop: envelope.shop,
    createdAt: now.toISOString(),
    attempts: 0,
    nextAttemptAt: now.toISOString(),
    lastError: null,
  };
  try {
    await writeAtomic(fileFor(dir, envelope.eventId), record, { exclusive: true });
    return { queued: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return { queued: false };
    throw err;
  }
}

const inFlight = new Set<string>();

type AttemptOutcome = { kind: "delivered" } | { kind: "retry" | "fatal"; error: string };

async function attempt(
  record: OutboxRecord,
  config: { url: string; signingSecret: string },
  fetchImpl: typeof fetch,
  now: number,
): Promise<AttemptOutcome> {
  const target = new URL(`${config.url}${EVENTS_PATH}`);
  const pathWithQuery = `${target.pathname}${target.search}`;
  try {
    const response = await fetchImpl(target.toString(), {
      method: "POST",
      headers: signedHeaders({
        secret: config.signingSecret,
        method: "POST",
        pathWithQuery,
        body: record.body,
        now,
      }),
      body: record.body,
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    if (response.ok) return { kind: "delivered" };
    const error = `HTTP ${response.status}`;
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      return { kind: "retry", error };
    }
    // Any other 4xx is Growzar refusing this event as sent (bad signature, bad envelope);
    // sending the same bytes again cannot change the answer.
    return { kind: "fatal", error };
  } catch (err) {
    return { kind: "retry", error: err instanceof Error ? err.name : "network error" };
  }
}

export type DeliveryReport = {
  configured: boolean;
  due: number;
  delivered: number;
  retrying: number;
  failed: number;
};

/**
 * Attempt every due event once. Never throws for a delivery problem; outcomes are
 * recorded on the outbox file and logged.
 */
export async function deliverDueEvents({
  dir = outboxDir(),
  now = () => Date.now(),
  fetchImpl = fetch,
  env = process.env,
}: {
  dir?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<DeliveryReport> {
  const report: DeliveryReport = { configured: false, due: 0, delivered: 0, retrying: 0, failed: 0 };
  const config = getGrowzarConfig(env);
  // Unconfigured: keep the events, spend no attempts, and deliver once configured.
  if (!config) return report;
  report.configured = true;

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return report;
    throw err;
  }

  for (const name of names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()) {
    const file = path.join(dir, name);
    if (inFlight.has(file)) continue;
    inFlight.add(file);
    try {
      let record: OutboxRecord;
      try {
        record = JSON.parse(await fs.readFile(file, "utf8")) as OutboxRecord;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        console.error(`[growzar/events] unreadable outbox file ${name}; moving it aside`);
        await moveToDead(dir, file);
        report.failed++;
        continue;
      }

      const current = now();
      if (Date.parse(record.nextAttemptAt) > current) continue;
      report.due++;

      const outcome = await attempt(record, config, fetchImpl, current);
      if (outcome.kind === "delivered") {
        await fs.rm(file, { force: true });
        report.delivered++;
        console.log(`[growzar/events] delivered ${record.topic} ${record.eventId} for ${record.shop}`);
        continue;
      }

      const attempts = record.attempts + 1;
      const retryAt = outcome.kind === "retry" ? nextRetryAt(attempts, current) : null;
      const updated: OutboxRecord = { ...record, attempts, lastError: outcome.error };

      if (retryAt === null) {
        await writeAtomic(file, updated, { exclusive: false });
        await moveToDead(dir, file);
        report.failed++;
        console.error(
          `[growzar/events] giving up on ${record.topic} ${record.eventId} for ${record.shop} ` +
            `after ${attempts} attempt(s): ${outcome.error}. Kept in ${path.join(dir, "dead")}.`,
        );
        continue;
      }

      updated.nextAttemptAt = new Date(retryAt).toISOString();
      await writeAtomic(file, updated, { exclusive: false });
      report.retrying++;
      console.warn(
        `[growzar/events] ${record.topic} ${record.eventId} for ${record.shop} failed ` +
          `(${outcome.error}); attempt ${attempts + 1} at ${updated.nextAttemptAt}`,
      );
    } finally {
      inFlight.delete(file);
    }
  }

  return report;
}

async function moveToDead(dir: string, file: string) {
  const dead = path.join(dir, "dead");
  await fs.mkdir(dead, { recursive: true });
  await fs.rename(file, path.join(dead, path.basename(file)));
}

/**
 * Called from the APP_UNINSTALLED webhook. Queues the event and makes the first attempt
 * in the background. Never throws: Growzar being down or misconfigured must not fail
 * Shopify's webhook, which would make Shopify retry the whole uninstall.
 */
export async function queueUninstallEvent(options: {
  shop: string;
  webhookId: string | null;
  triggeredAt: string | null;
}): Promise<void> {
  try {
    await enqueueEvent(uninstallEnvelope(options));
    void deliverDueEvents().catch((err) => {
      console.error("[growzar/events] immediate delivery failed; cron will retry:", err instanceof Error ? err.message : err);
    });
  } catch (err) {
    console.error(
      `[growzar/events] could not queue app.uninstalled for ${options.shop}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

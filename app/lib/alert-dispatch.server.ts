import { Resend } from "resend";
import prisma from "../db.server";

export type DispatchableAlert = {
  id: string;
  type: string;
  productId: string;
  message: string;
  severity?: string;
  revenueAtRisk?: number;
};

// Cap on how many individual alerts are listed in a single message. The rest are
// summarised as a count — they are still recorded as notified.
const MAX_LISTED = 20;

function listedAndRemainder(alerts: DispatchableAlert[]) {
  return {
    listed: alerts.slice(0, MAX_LISTED),
    remainder: Math.max(0, alerts.length - MAX_LISTED),
  };
}

/**
 * Alert messages embed merchant-controlled product titles. Interpolating them straight
 * into the email body allowed any title containing markup to inject HTML into the mail
 * we send on the merchant's behalf.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SEVERITY_LABEL: Record<string, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

// Senders return whether the send actually succeeded, so a failure is never
// recorded as "notified" — the merchant would silently never hear about it.
async function sendEmail(
  notificationEmail: string,
  alerts: DispatchableAlert[],
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("[alert-dispatch] RESEND_API_KEY not set — skipping email");
    return false;
  }
  try {
    const resend = new Resend(apiKey);
    const { listed, remainder } = listedAndRemainder(alerts);
    const listHtml = listed
      .map((a) => {
        const label = SEVERITY_LABEL[a.severity ?? ""] ?? "";
        const prefix = label ? `<strong>${escapeHtml(label)}:</strong> ` : "";
        return `<li>${prefix}${escapeHtml(a.message)}</li>`;
      })
      .join("");
    const moreHtml = remainder > 0 ? `<p>…and ${remainder} more.</p>` : "";
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "alerts@inventorify.app",
      to: notificationEmail,
      subject: `Inventorify — ${alerts.length} inventory alert${alerts.length !== 1 ? "s" : ""}`,
      html: `<p>Your latest inventory alerts, most urgent first:</p><ul>${listHtml}</ul>${moreHtml}`,
    });
    if (error) {
      console.error("[alert-dispatch] email send failed:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      "[alert-dispatch] email send failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

// The WAHA server is shared across the suite, with one session per WhatsApp account.
// Inventorify sends via the session named in WAHA_SESSION (currently Financify's, so
// alerts arrive from that number). There is no session named "default" on this server.
const wahaSession = () => process.env.WAHA_SESSION;

async function isWahaSessionWorking(
  baseUrl: string,
  apiKey: string,
  session: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(session)}`, {
      headers: { "X-Api-Key": apiKey },
    });
    if (!resp.ok) {
      console.error(
        `[alert-dispatch] WAHA session "${session}" unavailable (HTTP ${resp.status})`,
      );
      return false;
    }
    const data = await resp.json();
    if (data?.status !== "WORKING") {
      console.error(
        `[alert-dispatch] WAHA session "${session}" is ${data?.status ?? "unknown"}, not WORKING — skipping WhatsApp`,
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function sendWhatsapp(
  whatsappNumber: string,
  alerts: DispatchableAlert[],
): Promise<boolean> {
  const baseUrl = process.env.WAHA_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  const session = wahaSession();
  if (!baseUrl || !apiKey) {
    console.error("[alert-dispatch] WAHA_BASE_URL/WAHA_API_KEY not set — skipping WhatsApp");
    return false;
  }
  if (!session) {
    console.error("[alert-dispatch] WAHA_SESSION not set — skipping WhatsApp");
    return false;
  }

  const working = await isWahaSessionWorking(baseUrl, apiKey, session);
  if (!working) return false;

  try {
    const chatId = `${whatsappNumber.replace(/\D/g, "")}@c.us`;
    const { listed, remainder } = listedAndRemainder(alerts);
    const more = remainder > 0 ? `\n…and ${remainder} more.` : "";
    const text = `Inventorify — ${alerts.length} inventory alert${alerts.length !== 1 ? "s" : ""}:\n\n${listed
      .map((a) => `• ${a.message}`)
      .join("\n")}${more}`;
    const resp = await fetch(`${baseUrl}/api/sendText`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
      body: JSON.stringify({ session, chatId, text }),
    });
    if (!resp.ok) {
      console.error("[alert-dispatch] WAHA sendText failed:", resp.status, await resp.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      "[alert-dispatch] WhatsApp send failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

export type DispatchResult = {
  /** Alerts accepted by at least one channel, and therefore safe to mark notified. */
  sent: number;
  /** Alerts that could not be delivered and must be retried on the next run. */
  failed: number;
  /** Ids of the alerts that were delivered. */
  deliveredIds: string[];
  emailOk: boolean;
  whatsappOk: boolean;
};

/**
 * Notify a shop about the alerts it is due to be told about.
 *
 * `alerts` is the already-filtered dispatchable set (see getDispatchableAlerts): open,
 * unsnoozed, and outside the per-alert notification cooldown. Suppression and clearing
 * are handled there and in generateAlerts against durable Alert rows. An earlier design
 * needed a separate AlertNotification ledger keyed on (shop, type, productId), because
 * Alert rows were deleted and recreated on every run and so had no stable identity to
 * hang "already sent" on. Alert rows are now durable, which makes that ledger redundant.
 *
 * Delivery is only reported as successful when a channel actually accepted the message,
 * so a failed send leaves the alert pending for the next run instead of being silently
 * marked as notified.
 */
export async function dispatchAlerts(
  shop: string,
  alerts: DispatchableAlert[],
): Promise<DispatchResult> {
  const result: DispatchResult = {
    sent: 0,
    failed: 0,
    deliveredIds: [],
    emailOk: false,
    whatsappOk: false,
  };
  if (alerts.length === 0) return result;

  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const hasChannel = Boolean(settings?.notificationEmail || settings?.whatsappNumber);
  // With no delivery channel nothing can be sent, and nothing may be recorded as
  // notified — otherwise conditions would be permanently suppressed for a merchant
  // who configures a channel later.
  if (!settings || !hasChannel) return result;

  // De-duplicate by condition within the batch, so one message never lists the same
  // condition twice.
  const seen = new Set<string>();
  const pending: DispatchableAlert[] = [];
  for (const alert of alerts) {
    const key = `${alert.type}::${alert.productId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(alert);
  }

  const [emailOk, whatsappOk] = await Promise.all([
    settings.notificationEmail
      ? sendEmail(settings.notificationEmail, pending)
      : Promise.resolve(false),
    settings.whatsappNumber
      ? sendWhatsapp(settings.whatsappNumber, pending)
      : Promise.resolve(false),
  ]);

  result.emailOk = emailOk;
  result.whatsappOk = whatsappOk;

  if (!emailOk && !whatsappOk) {
    result.failed = pending.length;
    return result;
  }

  result.sent = pending.length;
  result.deliveredIds = pending.map((a) => a.id);
  return result;
}

import { Resend } from "resend";
import prisma from "../db.server";

type DispatchableAlert = { type: string; message: string };

async function sendEmail(notificationEmail: string, alerts: DispatchableAlert[]) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("[alert-dispatch] RESEND_API_KEY not set — skipping email");
    return;
  }
  try {
    const resend = new Resend(apiKey);
    const listHtml = alerts.map((a) => `<li>${a.message}</li>`).join("");
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "alerts@inventrify.app",
      to: notificationEmail,
      subject: `Inventrify — ${alerts.length} inventory alert${alerts.length !== 1 ? "s" : ""}`,
      html: `<p>Your latest inventory alerts:</p><ul>${listHtml}</ul>`,
    });
  } catch (err) {
    console.error("[alert-dispatch] email send failed:", err instanceof Error ? err.message : err);
  }
}

async function isWahaSessionWorking(baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/api/sessions/default`, {
      headers: { "X-Api-Key": apiKey },
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data?.status === "WORKING";
  } catch {
    return false;
  }
}

async function sendWhatsapp(whatsappNumber: string, alerts: DispatchableAlert[]) {
  const baseUrl = process.env.WAHA_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error("[alert-dispatch] WAHA_BASE_URL/WAHA_API_KEY not set — skipping WhatsApp");
    return;
  }

  const working = await isWahaSessionWorking(baseUrl, apiKey);
  if (!working) {
    console.error("[alert-dispatch] WAHA session not WORKING — skipping WhatsApp send");
    return;
  }

  try {
    const chatId = `${whatsappNumber.replace(/\D/g, "")}@c.us`;
    const text = `Inventrify — ${alerts.length} inventory alert${alerts.length !== 1 ? "s" : ""}:\n\n${alerts
      .map((a) => `• ${a.message}`)
      .join("\n")}`;
    const resp = await fetch(`${baseUrl}/api/sendText`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
      body: JSON.stringify({ session: "default", chatId, text }),
    });
    if (!resp.ok) {
      console.error("[alert-dispatch] WAHA sendText failed:", resp.status, await resp.text());
    }
  } catch (err) {
    console.error("[alert-dispatch] WhatsApp send failed:", err instanceof Error ? err.message : err);
  }
}

export async function dispatchAlerts(shop: string, alerts: DispatchableAlert[]) {
  if (alerts.length === 0) return;

  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  if (!settings) return;

  await Promise.all([
    settings.notificationEmail ? sendEmail(settings.notificationEmail, alerts) : Promise.resolve(),
    settings.whatsappNumber ? sendWhatsapp(settings.whatsappNumber, alerts) : Promise.resolve(),
  ]);
}

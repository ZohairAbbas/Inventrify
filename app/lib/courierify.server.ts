import prisma from "../db.server";

interface ReturnRateEntry {
  sku: string;
  returnRate: number;
}

export async function syncCourierifyReturnRates(
  shop: string,
  apiKey: string,
): Promise<{ synced: number; error?: string }> {
  try {
    const response = await fetch("https://api.courierify.app/v1/return-rates", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ shop }),
    });

    if (!response.ok) {
      return { synced: 0, error: `Courierify API error: ${response.status}` };
    }

    const data: ReturnRateEntry[] = await response.json();
    let synced = 0;

    for (const entry of data) {
      const updated = await prisma.product.updateMany({
        where: { shop, sku: entry.sku },
        data: { codReturnRate: Math.min(1, Math.max(0, entry.returnRate)) },
      });
      synced += updated.count;
    }

    return { synced };
  } catch (err) {
    return {
      synced: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

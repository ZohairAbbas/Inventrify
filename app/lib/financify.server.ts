import prisma from "../db.server";

interface MarginEntry {
  sku: string;
  margin: number;
}

export async function syncFinancifyMargins(
  shop: string,
  apiKey: string,
): Promise<{ synced: number; error?: string }> {
  try {
    const response = await fetch("https://api.financify.app/v1/sku-margins", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ shop }),
    });

    if (!response.ok) {
      return { synced: 0, error: `Financify API error: ${response.status}` };
    }

    const data: MarginEntry[] = await response.json();
    let synced = 0;

    for (const entry of data) {
      const updated = await prisma.product.updateMany({
        where: { shop, sku: entry.sku },
        data: { avgMargin: entry.margin },
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

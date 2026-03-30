import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";

// This endpoint is called by a cron job or manually
export const action = async ({ request }: ActionFunctionArgs) => {
  // Simple secret check
  const secret = request.headers.get("x-sync-secret");
  if (secret !== process.env.SYNC_SECRET) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const integrations = await (db as any).adIntegration.findMany({
    where: { platform: "meta", isActive: true },
  });

  let synced = 0;
  for (const integration of integrations) {
    try {
      await syncMetaSpend(
        integration.shop,
        integration.accessToken,
        integration.accountId
      );
      synced++;
    } catch (err) {
      console.error(`[Meta Sync] Failed for ${integration.shop}:`, err);
    }
  }

  return json({ synced });
};

async function syncMetaSpend(shop: string, accessToken: string, accountId: string) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split("T")[0];

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${accountId}/insights?` +
      `fields=spend,impressions,clicks,date_start&` +
      `time_increment=1&` +
      `time_range={"since":"${dateStr}","until":"${dateStr}"}&` +
      `access_token=${accessToken}`
  );
  const data = await res.json() as any;

  for (const day of data.data ?? []) {
    await (db as any).adSpend.upsert({
      where: { shop_platform_date: { shop, platform: "meta", date: day.date_start } },
      update: {
        spend: parseFloat(day.spend ?? "0"),
        impressions: parseInt(day.impressions ?? "0"),
        clicks: parseInt(day.clicks ?? "0"),
        syncedAt: new Date(),
      },
      create: {
        shop,
        platform: "meta",
        date: day.date_start,
        spend: parseFloat(day.spend ?? "0"),
        impressions: parseInt(day.impressions ?? "0"),
        clicks: parseInt(day.clicks ?? "0"),
      },
    });
  }
}
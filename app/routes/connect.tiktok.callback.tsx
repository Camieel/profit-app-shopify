// app/routes/connect.tiktok.callback.tsx

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("auth_code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error || !code || !state) {
    console.error("[TikTok OAuth] Error:", error);
    const shopDomain = "smart-order-notes-dev";
    return redirect(
      `https://admin.shopify.com/store/${shopDomain}/apps/profit-tracker-app-5/app/settings?error=tiktok_auth_failed`
    );
  }

  const shop = Buffer.from(state, "base64").toString("utf-8");
  const shopDomain = shop.replace(".myshopify.com", "");

  const appId = process.env.TIKTOK_APP_ID!;
  const appSecret = process.env.TIKTOK_APP_SECRET!;
  const redirectUri = `${process.env.SHOPIFY_APP_URL}/connect/tiktok/callback`;

  try {
    // Exchange code for access token
    const tokenRes = await fetch(
      "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: appId,
          secret: appSecret,
          auth_code: code,
          redirect_uri: redirectUri,
        }),
      }
    );
    const tokenData = (await tokenRes.json()) as any;

    if (tokenData.code !== 0 || !tokenData.data?.access_token) {
      console.error("[TikTok OAuth] Token error:", tokenData);
      return redirect(
        `https://admin.shopify.com/store/${shopDomain}/apps/profit-tracker-app-5/app/settings?error=tiktok_token_failed`
      );
    }

    const accessToken = tokenData.data.access_token;
    const advertiserIds: string[] = tokenData.data.advertiser_ids ?? [];

    if (advertiserIds.length === 0) {
      return redirect(
        `https://admin.shopify.com/store/${shopDomain}/apps/profit-tracker-app-5/app/settings?error=tiktok_no_accounts`
      );
    }

    // Get advertiser info for the first account
    const advertiserRes = await fetch(
      `https://business-api.tiktok.com/open_api/v1.3/advertiser/info/?advertiser_ids=${JSON.stringify(advertiserIds)}`,
      {
        headers: {
          "Access-Token": accessToken,
        },
      }
    );
    const advertiserData = (await advertiserRes.json()) as any;
    const advertiser = advertiserData.data?.list?.[0];

    const accountId = advertiserIds[0];
    const accountName = advertiser?.advertiser_name ?? accountId;

    await (db as any).adIntegration.upsert({
      where: { shop_platform: { shop, platform: "tiktok" } },
      update: { accessToken, accountId, accountName, isActive: true },
      create: {
        shop,
        platform: "tiktok",
        accessToken,
        accountId,
        accountName,
        isActive: true,
      },
    });

    syncTikTokSpend(shop, accessToken, accountId).catch(console.error);

    console.log(`[TikTok OAuth] Connected for ${shop}: ${accountName}`);
    return redirect(
      `https://admin.shopify.com/store/${shopDomain}/apps/profit-tracker-app-5/app/settings?success=tiktok_connected`
    );
  } catch (err) {
    console.error("[TikTok OAuth] Error:", err);
    return redirect(
      `https://admin.shopify.com/store/${shopDomain}/apps/profit-tracker-app-5/app/settings?error=tiktok_auth_failed`
    );
  }
};

async function syncTikTokSpend(
  shop: string,
  accessToken: string,
  advertiserId: string
) {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split("T")[0];
  const untilStr = new Date().toISOString().split("T")[0];

  const res = await fetch(
    "https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/",
    {
      method: "POST",
      headers: {
        "Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        advertiser_id: advertiserId,
        report_type: "BASIC",
        dimensions: ["stat_time_day"],
        metrics: ["spend", "impressions", "clicks"],
        start_date: sinceStr,
        end_date: untilStr,
        page_size: 100,
      }),
    }
  );
  const data = (await res.json()) as any;

  let synced = 0;
  for (const row of data.data?.list ?? []) {
    const date = row.dimensions?.stat_time_day?.split(" ")[0];
    if (!date) continue;

    await (db as any).adSpend.upsert({
      where: { shop_platform_date: { shop, platform: "tiktok", date } },
      update: {
        spend: parseFloat(row.metrics?.spend ?? "0"),
        impressions: parseInt(row.metrics?.impressions ?? "0"),
        clicks: parseInt(row.metrics?.clicks ?? "0"),
        syncedAt: new Date(),
      },
      create: {
        shop,
        platform: "tiktok",
        date,
        spend: parseFloat(row.metrics?.spend ?? "0"),
        impressions: parseInt(row.metrics?.impressions ?? "0"),
        clicks: parseInt(row.metrics?.clicks ?? "0"),
      },
    });
    synced++;
  }

  console.log(`[TikTok Sync] Synced ${synced} days for ${shop}`);
}
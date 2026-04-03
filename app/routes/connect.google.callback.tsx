// app/routes/connect.google.callback.tsx

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Decode shop early so we can use it in error redirects
  const shop = state ? Buffer.from(state, "base64").toString("utf-8") : "";
  const shopDomain = shop.replace(".myshopify.com", "");

  if (error || !code || !state) {
    console.error("[Google OAuth] Error:", error);
    return redirect(buildShopifyAdminUrl(shopDomain, "settings?error=google_auth_failed"));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const developerToken = process.env.GOOGLE_DEVELOPER_TOKEN;
  const appUrl = process.env.SHOPIFY_APP_URL;

  // Veiligheidscheck voor je environment variables
  if (!clientId || !clientSecret || !developerToken || !appUrl) {
    console.error("[Google OAuth] Missing required environment variables.");
    return redirect(buildShopifyAdminUrl(shopDomain, "settings?error=google_config_missing"));
  }

  const redirectUri = `${appUrl}/connect/google/callback`;

  try {
    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenRes.json() as any;

    if (!tokenData.access_token) {
      console.error("[Google OAuth] No access token:", tokenData);
      return redirect(buildShopifyAdminUrl(shopDomain, "settings?error=google_token_failed"));
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;

    // Get Google Ads accounts via API
    const accountsRes = await fetch(
      "https://googleads.googleapis.com/v17/customers:listAccessibleCustomers",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "developer-token": developerToken,
        },
      }
    );
    const accountsData = await accountsRes.json() as any;
    const resourceNames: string[] = accountsData.resourceNames ?? [];

    if (resourceNames.length === 0) {
      return redirect(buildShopifyAdminUrl(shopDomain, "settings?error=google_no_accounts"));
    }

    // Get account details for each
    const accounts = await Promise.all(
      resourceNames.slice(0, 10).map(async (resourceName: string) => {
        const customerId = resourceName.replace("customers/", "");
        const detailRes = await fetch(
          `https://googleads.googleapis.com/v17/customers/${customerId}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "developer-token": developerToken,
            },
          }
        );
        const detail = await detailRes.json() as any;
        return {
          id: customerId,
          name: detail.descriptiveName ?? `Account ${customerId}`,
          currency: detail.currencyCode ?? "USD",
        };
      })
    );

    // Store pending token + refresh token
    await db.adIntegration.upsert({
      where: { shop_platform: { shop, platform: "google_pending" } },
      update: {
        accessToken: JSON.stringify({ accessToken, refreshToken }),
        accountId: "pending",
        isActive: false,
      },
      create: {
        shop,
        platform: "google_pending",
        accessToken: JSON.stringify({ accessToken, refreshToken }),
        accountId: "pending",
        isActive: false,
      },
    });

    if (accounts.length === 1) {
      // Auto-select if only one account
      await saveGoogleIntegration(shop, accessToken, refreshToken, accounts[0].id, accounts[0].name, developerToken);
      return redirect(buildShopifyAdminUrl(shopDomain, "settings?success=google_connected"));
    }

    // Multiple accounts — show selector (gefixt: meta/ weggehaald)
    const accountsParam = encodeURIComponent(JSON.stringify(accounts));
    return redirect(
      buildShopifyAdminUrl(shopDomain, `select-account?accounts=${accountsParam}&platform=google`)
    );
  } catch (err) {
    console.error("[Google OAuth] Error:", err);
    return redirect(buildShopifyAdminUrl(shopDomain, "settings?error=google_auth_failed"));
  }
};

function buildShopifyAdminUrl(shopDomain: string, path: string) {
  const appHandle = process.env.SHOPIFY_APP_HANDLE || "profit-tracker-app-5";
  return `https://admin.shopify.com/store/${shopDomain}/apps/${appHandle}/app/${path}`;
}

async function saveGoogleIntegration(
  shop: string,
  accessToken: string,
  refreshToken: string,
  accountId: string,
  accountName: string,
  developerToken: string
) {
  await db.adIntegration.upsert({
    where: { shop_platform: { shop, platform: "google" } },
    update: {
      accessToken: JSON.stringify({ accessToken, refreshToken }),
      accountId,
      accountName,
      isActive: true,
    },
    create: {
      shop,
      platform: "google",
      accessToken: JSON.stringify({ accessToken, refreshToken }),
      accountId,
      accountName,
      isActive: true,
    },
  });

  syncGoogleSpend(shop, accessToken, accountId, developerToken).catch(console.error);
}

async function syncGoogleSpend(shop: string, accessToken: string, customerId: string, developerToken: string) {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split("T")[0]; // Gefixt: overbodige .replace verwijderd
  const untilStr = new Date().toISOString().split("T")[0];

  const query = `
    SELECT
      segments.date,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks
    FROM campaign
    WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
  `;

  const res = await fetch(
    `https://googleads.googleapis.com/v17/customers/${customerId}/googleAds:search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": developerToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    }
  );
  
  const data = await res.json() as any;

  // Aggregate by date
  const byDate = new Map<string, { spend: number; impressions: number; clicks: number }>();
  for (const row of data.results ?? []) {
    const date = row.segments?.date;
    const spend = (row.metrics?.costMicros ?? 0) / 1_000_000;
    const impressions = row.metrics?.impressions ?? 0;
    const clicks = row.metrics?.clicks ?? 0;

    if (!date) continue;
    const existing = byDate.get(date) ?? { spend: 0, impressions: 0, clicks: 0 };
    byDate.set(date, {
      spend: existing.spend + spend,
      impressions: existing.impressions + impressions,
      clicks: existing.clicks + clicks,
    });
  }

  for (const [date, metrics] of byDate) {
    await db.adSpend.upsert({
      where: { shop_platform_date: { shop, platform: "google", date } },
      update: { ...metrics, syncedAt: new Date() },
      create: { shop, platform: "google", date, ...metrics },
    });
  }

  console.log(`[Google Sync] Synced ${byDate.size} days for ${shop}`);
}
// app/routes/connect.google.callback.tsx

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const shop = state ? Buffer.from(state, "base64").toString("utf-8") : "";

  if (error || !code || !state) {
    console.error("[Google OAuth] Error:", error);
    return redirect("/connect/error?error=google_auth_failed");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const developerToken = process.env.GOOGLE_DEVELOPER_TOKEN;
  const appUrl = process.env.SHOPIFY_APP_URL;

  if (!clientId || !clientSecret || !developerToken || !appUrl) {
    console.error("[Google OAuth] Missing required environment variables.");
    return redirect("/connect/error?error=google_config_missing");
  }

  const redirectUri = `${appUrl}/connect/google/callback`;

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    });
    // Check content-type before parsing — Google returns HTML on some errors
    const tokenContentType = tokenRes.headers.get("content-type") ?? "";
    if (!tokenContentType.includes("application/json")) {
      const rawBody = await tokenRes.text();
      console.error("[Google OAuth] Token endpoint returned non-JSON:", rawBody.slice(0, 200));
      return redirect("/connect/error?error=google_token_failed");
    }
    const tokenData = (await tokenRes.json()) as any;

    if (!tokenData.access_token) {
      console.error("[Google OAuth] No access token:", tokenData);
      return redirect("/connect/error?error=google_token_failed");
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;

    const accountsRes = await fetch(
      "https://googleads.googleapis.com/v17/customers:listAccessibleCustomers",
      { headers: { Authorization: `Bearer ${accessToken}`, "developer-token": developerToken } }
    );
    const accountsContentType = accountsRes.headers.get("content-type") ?? "";
    if (!accountsContentType.includes("application/json")) {
      const rawBody = await accountsRes.text();
      console.error("[Google OAuth] Accounts endpoint returned non-JSON:", rawBody.slice(0, 200));
      return redirect("/connect/error?error=google_no_accounts");
    }
    const accountsData = (await accountsRes.json()) as any;
    console.log("[Google OAuth] Accounts response:", JSON.stringify(accountsData).slice(0, 300));
    const resourceNames: string[] = accountsData.resourceNames ?? [];

    if (resourceNames.length === 0) {
      return redirect("/connect/error?error=google_no_accounts");
    }

    // Get details for first account (auto-select)
    const customerId = resourceNames[0].replace("customers/", "");
    const detailRes = await fetch(
      `https://googleads.googleapis.com/v17/customers/${customerId}`,
      { headers: { Authorization: `Bearer ${accessToken}`, "developer-token": developerToken } }
    );
    const detail = (await detailRes.json()) as any;
    const accountName = detail.descriptiveName ?? `Account ${customerId}`;

    await saveGoogleIntegration(shop, accessToken, refreshToken, customerId, accountName, developerToken);
    console.log(`[Google OAuth] Connected for ${shop}: ${accountName}`);

    return redirect("/connect/success");
  } catch (err) {
    console.error("[Google OAuth] Error:", err);
    return redirect("/connect/error?error=google_auth_failed");
  }
};

async function saveGoogleIntegration(shop: string, accessToken: string, refreshToken: string, accountId: string, accountName: string, developerToken: string) {
  await db.adIntegration.upsert({
    where: { shop_platform: { shop, platform: "google" } },
    update: { accessToken: JSON.stringify({ accessToken, refreshToken }), accountId, accountName, isActive: true },
    create: { shop, platform: "google", accessToken: JSON.stringify({ accessToken, refreshToken }), accountId, accountName, isActive: true },
  });
  syncGoogleSpend(shop, accessToken, accountId, developerToken).catch(console.error);
}

async function syncGoogleSpend(shop: string, accessToken: string, customerId: string, developerToken: string) {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split("T")[0];
  const untilStr = new Date().toISOString().split("T")[0];

  const query = `SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'`;

  const res = await fetch(
    `https://googleads.googleapis.com/v17/customers/${customerId}/googleAds:search`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "developer-token": developerToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }
  );
  const data = (await res.json()) as any;

  const byDate = new Map<string, { spend: number; impressions: number; clicks: number }>();
  for (const row of data.results ?? []) {
    const date = row.segments?.date;
    if (!date) continue;
    const existing = byDate.get(date) ?? { spend: 0, impressions: 0, clicks: 0 };
    byDate.set(date, {
      spend: existing.spend + (row.metrics?.costMicros ?? 0) / 1_000_000,
      impressions: existing.impressions + (row.metrics?.impressions ?? 0),
      clicks: existing.clicks + (row.metrics?.clicks ?? 0),
    });
  }
// Test
  for (const [date, metrics] of byDate) {
    await db.adSpend.upsert({
      where: { shop_platform_date: { shop, platform: "google", date } },
      update: { ...metrics, syncedAt: new Date() },
      create: { shop, platform: "google", date, ...metrics },
    });
  }
  console.log(`[Google Sync] Synced ${byDate.size} days for ${shop}`);
}
// app/routes/connect.google.callback.tsx
// After successful OAuth, saves tokens immediately WITHOUT requiring account lookup.
// listAccessibleCustomers requires approved production developer token — skip it.
// Account ID can be set later via Settings sync or manual input.

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
    console.error("[Google OAuth] Error or missing params:", error);
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
    // Step 1: Exchange code for tokens
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

    const tokenContentType = tokenRes.headers.get("content-type") ?? "";
    if (!tokenContentType.includes("application/json")) {
      const raw = await tokenRes.text();
      console.error("[Google OAuth] Token endpoint returned non-JSON:", raw.slice(0, 200));
      return redirect("/connect/error?error=google_token_failed");
    }

    const tokenData = (await tokenRes.json()) as any;
    if (!tokenData.access_token) {
      console.error("[Google OAuth] No access token in response:", JSON.stringify(tokenData).slice(0, 300));
      return redirect("/connect/error?error=google_token_failed");
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token ?? "";

    // Step 2: Try to get customer ID — but save anyway if it fails.
    // listAccessibleCustomers requires approved production developer token.
    // Dev tokens get 404. We save with "pending" and let user set ID in Settings.
    let customerId = "pending";
    let accountName = "Google Ads (connected — set account ID in Settings)";

    try {
      const accountsRes = await fetch(
        "https://googleads.googleapis.com/v17/customers:listAccessibleCustomers",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "developer-token": developerToken,
          },
        }
      );

      if ((accountsRes.headers.get("content-type") ?? "").includes("application/json")) {
        const accountsData = (await accountsRes.json()) as any;
        const resourceNames: string[] = accountsData.resourceNames ?? [];

        if (resourceNames.length > 0) {
          customerId = resourceNames[0].replace("customers/", "");
          accountName = `Google Ads (${customerId})`;
          console.log(`[Google OAuth] Found account: ${customerId}`);
        } else {
          console.warn("[Google OAuth] listAccessibleCustomers returned empty list — saving as pending");
        }
      } else {
        console.warn("[Google OAuth] listAccessibleCustomers returned non-JSON (dev token?) — saving as pending");
      }
    } catch (accountsErr) {
      console.warn("[Google OAuth] Account lookup failed — saving as pending:", accountsErr);
    }

    // Step 3: Save integration regardless of account ID
    await db.adIntegration.upsert({
      where: { shop_platform: { shop, platform: "google" } },
      update: {
        accessToken: JSON.stringify({ accessToken, refreshToken }),
        accountId: customerId,
        accountName,
        isActive: true,
      },
      create: {
        shop,
        platform: "google",
        accessToken: JSON.stringify({ accessToken, refreshToken }),
        accountId: customerId,
        accountName,
        isActive: true,
      },
    });

    console.log(`[Google OAuth] Connected for ${shop} — accountId: ${customerId}`);

    // Kick off spend sync only if we have a real customer ID
    if (customerId !== "pending") {
      syncGoogleSpend(shop, accessToken, customerId, developerToken).catch(console.error);
    }

    return redirect("/connect/success");
  } catch (err) {
    console.error("[Google OAuth] Unexpected error:", err);
    return redirect("/connect/error?error=google_auth_failed");
  }
};

async function syncGoogleSpend(
  shop: string,
  accessToken: string,
  customerId: string,
  developerToken: string
) {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split("T")[0];
  const untilStr = new Date().toISOString().split("T")[0];

  const query = `
    SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks
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

  for (const [date, metrics] of byDate) {
    await db.adSpend.upsert({
      where: { shop_platform_date: { shop, platform: "google", date } },
      update: { ...metrics, syncedAt: new Date() },
      create: { shop, platform: "google", date, ...metrics },
    });
  }

  console.log(`[Google Sync] Synced ${byDate.size} days for ${shop}`);
}
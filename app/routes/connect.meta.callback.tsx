import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error || !code || !state) {
    console.error("[Meta OAuth] Error:", error);
    const shopDomain = "smart-order-notes-dev";
    return redirect(
      `https://admin.shopify.com/store/${shopDomain}/apps/profit-tracker-app-5/app/settings?error=meta_auth_failed`
    );
  }

  const shop = Buffer.from(state, "base64").toString("utf-8");
  const shopDomain = shop.replace(".myshopify.com", "");

  const metaAppId = process.env.META_APP_ID!;
  const metaAppSecret = process.env.META_APP_SECRET!;
  const redirectUri = `${process.env.SHOPIFY_APP_URL}/connect/meta/callback`;

  try {
    // Exchange code for access token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?` +
        `client_id=${metaAppId}` +
        `&client_secret=${metaAppSecret}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&code=${code}`
    );
    const tokenData = await tokenRes.json() as any;

    if (!tokenData.access_token) {
      return redirect(
        `https://admin.shopify.com/store/${shopDomain}/apps/profit-tracker-app-5/app/settings?error=meta_token_failed`
      );
    }

    const accessToken = tokenData.access_token;

    // Get ALL ad accounts — store temporarily and redirect to selector
    const accountsRes = await fetch(
      `https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,currency,account_status&access_token=${accessToken}`
    );
    const accountsData = await accountsRes.json() as any;
    const accounts = accountsData.data ?? [];

    if (accounts.length === 0) {
      return redirect(
        `https://admin.shopify.com/store/${shopDomain}/apps/profit-tracker-app-5/app/settings?error=meta_no_accounts`
      );
    }

    // If only one account — connect directly
    if (accounts.length === 1) {
      const account = accounts[0];
      await saveMetaIntegration(shop, accessToken, account.id, account.name);
      console.log(`[Meta OAuth] Connected for ${shop}: ${account.name}`);
      return redirect(
        `https://admin.shopify.com/store/${shopDomain}/apps/profit-tracker-app-5/app/settings?success=meta_connected`
      );
    }

    // Multiple accounts — save token temporarily and redirect to selector
    await (db as any).adIntegration.upsert({
      where: { shop_platform: { shop, platform: "meta_pending" } },
      update: { accessToken, accountId: "pending", isActive: false },
      create: {
        shop,
        platform: "meta_pending",
        accessToken,
        accountId: "pending",
        isActive: false,
      },
    });

    // Encode accounts in URL (simple approach for small lists)
    const accountsParam = encodeURIComponent(JSON.stringify(
      accounts.map((a: any) => ({ id: a.id, name: a.name, currency: a.currency }))
    ));

    return redirect(
      `https://admin.shopify.com/store/${shopDomain}/apps/profit-tracker-app-5/app/meta/select-account?accounts=${accountsParam}`
    );
  } catch (err) {
    console.error("[Meta OAuth] Error:", err);
    return redirect(
      `https://admin.shopify.com/store/${shopDomain}/apps/profit-tracker-app-5/app/settings?error=meta_auth_failed`
    );
  }
};

async function saveMetaIntegration(
  shop: string,
  accessToken: string,
  accountId: string,
  accountName: string
) {
  await (db as any).adIntegration.upsert({
    where: { shop_platform: { shop, platform: "meta" } },
    update: { accessToken, accountId, accountName, isActive: true },
    create: { shop, platform: "meta", accessToken, accountId, accountName, isActive: true },
  });

  // Kick off initial sync
  syncMetaSpend(shop, accessToken, accountId).catch(console.error);
}

async function syncMetaSpend(shop: string, accessToken: string, accountId: string) {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split("T")[0];
  const untilStr = new Date().toISOString().split("T")[0];

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${accountId}/insights?` +
      `fields=spend,impressions,clicks,date_start&` +
      `time_increment=1&` +
      `time_range={"since":"${sinceStr}","until":"${untilStr}"}&` +
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
  console.log(`[Meta Sync] Synced ${data.data?.length ?? 0} days for ${shop}`);
}
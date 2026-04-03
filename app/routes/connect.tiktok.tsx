// app/routes/connect.tiktok.tsx

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) return new Response("Missing shop", { status: 400 });

  const appId = process.env.TIKTOK_APP_ID;
  const appUrl = process.env.SHOPIFY_APP_URL;

  // Veiligheidscheck: voorkomt 500 server crashes als variabelen missen
  if (!appId || !appUrl) {
    console.error("[TikTok OAuth] Missing TIKTOK_APP_ID or SHOPIFY_APP_URL in environment variables.");
    return new Response("Server configuration error", { status: 500 });
  }

  const redirectUri = `${appUrl}/connect/tiktok/callback`;
  const state = Buffer.from(shop).toString("base64");

  const authUrl =
    `https://business-api.tiktok.com/portal/auth?` +
    `app_id=${appId}` +
    `&state=${state}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  return redirect(authUrl);
};
// app/routes/connect.meta.tsx

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) return new Response("Missing shop", { status: 400 });

  const metaAppId = process.env.META_APP_ID;
  const appUrl = process.env.SHOPIFY_APP_URL;

  // Veiligheidscheck: voorkomt 500 server crashes als variabelen missen
  if (!metaAppId || !appUrl) {
    console.error("[Meta OAuth] Missing META_APP_ID or SHOPIFY_APP_URL in environment variables.");
    return new Response("Server configuration error", { status: 500 });
  }

  const redirectUri = `${appUrl}/connect/meta/callback`;
  const state = Buffer.from(shop).toString("base64");

  const scopes = [
    "ads_read",
    "ads_management",
    "business_management",
  ].join(",");

  const authUrl =
    `https://www.facebook.com/v19.0/dialog/oauth?` +
    `client_id=${metaAppId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scopes}` +
    `&state=${state}` +
    `&response_type=code`;

  return redirect(authUrl);
};
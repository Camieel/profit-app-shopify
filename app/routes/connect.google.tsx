// app/routes/connect.google.tsx

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) return new Response("Missing shop", { status: 400 });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const appUrl = process.env.SHOPIFY_APP_URL;

  // Veiligheidscheck: voorkomt onverwachte 500 server crashes als variabelen missen
  if (!clientId || !appUrl) {
    console.error("[Google OAuth] Missing GOOGLE_CLIENT_ID or SHOPIFY_APP_URL in environment variables.");
    return new Response("Server configuration error", { status: 500 });
  }

  const redirectUri = `${appUrl}/connect/google/callback`;
  const state = Buffer.from(shop).toString("base64");

  const scopes = [
    "https://www.googleapis.com/auth/adwords",
  ].join(" ");

  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${state}` +
    `&response_type=code` +
    `&access_type=offline` +
    `&prompt=consent`;

  return redirect(authUrl);
};
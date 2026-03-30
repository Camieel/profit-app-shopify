import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    return new Response("Missing shop parameter", { status: 400 });
  }

  const metaAppId = process.env.META_APP_ID!;
  const redirectUri = `${process.env.SHOPIFY_APP_URL}/auth/meta/callback`;

  const scopes = [
    "ads_read",
    "ads_management",
    "business_management",
  ].join(",");

  const state = Buffer.from(shop).toString("base64");

  const authUrl =
    `https://www.facebook.com/v19.0/dialog/oauth?` +
    `client_id=${metaAppId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scopes}` +
    `&state=${state}` +
    `&response_type=code`;

  return redirect(authUrl);
};
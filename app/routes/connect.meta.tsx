// app/routes/connect.meta.tsx

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const metaAppId = process.env.META_APP_ID!;
  const redirectUri = `${process.env.SHOPIFY_APP_URL}/connect/meta/callback`;

  const scopes = [
    "ads_read",
    "ads_management",
    "business_management",
  ].join(",");

  const state = Buffer.from(session.shop).toString("base64");

  const authUrl =
    `https://www.facebook.com/v19.0/dialog/oauth?` +
    `client_id=${metaAppId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scopes}` +
    `&state=${state}` +
    `&response_type=code`;

  return redirect(authUrl);
};
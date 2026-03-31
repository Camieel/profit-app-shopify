// app/routes/connect.tiktok.tsx

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const appId = process.env.TIKTOK_APP_ID!;
  const redirectUri = `${process.env.SHOPIFY_APP_URL}/connect/tiktok/callback`;
  const state = Buffer.from(session.shop).toString("base64");

  const authUrl =
    `https://business-api.tiktok.com/portal/auth?` +
    `app_id=${appId}` +
    `&state=${state}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  return redirect(authUrl);
};
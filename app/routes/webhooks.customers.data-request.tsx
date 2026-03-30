// app/routes/webhooks.customers.data-request.tsx

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.webhook(request);
  // We store no personal customer data beyond Shopify sessions.
  // Nothing to return.
  return new Response(null, { status: 200 });
};
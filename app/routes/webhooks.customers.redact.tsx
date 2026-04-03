// app/routes/webhooks.customers.redact.tsx

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Haal de shop netjes uit de authenticatie in plaats van de payload
  const { payload, shop } = await authenticate.webhook(request);

  // Shopify asks us to delete data for a specific customer.
  // We store orders by shop, not by customer ID, so no direct customer
  // records to delete. We log the request for compliance purposes.
  console.log(
    `[GDPR] customers/redact received for shop: ${shop}, customer: ${payload?.customer?.id}`
  );

  return new Response(null, { status: 200 });
};
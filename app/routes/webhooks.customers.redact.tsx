// app/routes/webhooks.customers.redact.tsx

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop } = await authenticate.webhook(request);

  // Shopify requests deletion of data for a specific customer.
  //
  // ClearProfit does NOT store personal customer data:
  //   - No names, email addresses, or shipping addresses
  //   - Orders are stored by order ID and revenue figures only
  //   - No customer profiles or identifiers are retained
  //
  // Per our Privacy Policy: "We store order IDs and revenue figures only,
  // not names, addresses, or emails."
  //
  // Nothing to delete. We log for compliance audit trail.
  console.log(
    `[GDPR] customers/redact received for shop: ${shop}, ` +
    `customer: ${payload?.customer?.id ?? "unknown"}. ` +
    `No personal customer data stored — nothing to delete.`
  );

  return new Response(null, { status: 200 });
};
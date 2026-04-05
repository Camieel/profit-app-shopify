// app/routes/webhooks.customers.data-request.tsx

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop } = await authenticate.webhook(request);

  // Shopify requests what data we hold for a specific customer.
  //
  // ClearProfit does NOT store personal customer data:
  //   - No names, email addresses, or shipping addresses
  //   - Orders are stored by Shopify order ID and revenue figures only
  //   - No customer profiles, identifiers, or PII are retained
  //
  // Per our Privacy Policy: "We store order IDs and revenue figures only,
  // not names, addresses, or emails."
  //
  // There is no customer-identifiable data to return. Log for compliance.
  console.log(
    `[GDPR] customers/data_request received for shop: ${shop}, ` +
    `customer: ${payload?.customer?.id ?? "unknown"}. ` +
    `No personal customer data stored — nothing to report.`
  );

  return new Response(null, { status: 200 });
};
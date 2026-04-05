// app/routes/webhooks.shop.redact.tsx

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);

  // Shop has uninstalled and 48 hours have passed.
  // Delete all data associated with this shop.
  console.log(`[GDPR] shop/redact received for ${shop}. Deleting all shop data.`);

  try {
    // Transaction ensures all-or-nothing deletion.
    // Order matters: delete children before parents to avoid FK constraint errors.
    await db.$transaction([
      // Order line items first (child of orders)
      db.orderLineItem.deleteMany({ where: { order: { shop } } }),
      // Orders
      db.order.deleteMany({ where: { shop } }),
      // Product variants first (child of products)
      db.productVariant.deleteMany({ where: { product: { shop } } }),
      // Products
      db.product.deleteMany({ where: { shop } }),
      // Settings
      db.shopSettings.deleteMany({ where: { shop } }),
      // Ad data
      db.adSpend.deleteMany({ where: { shop } }),
      db.adIntegration.deleteMany({ where: { shop } }),
      // Expenses
      db.expense.deleteMany({ where: { shop } }),
      // Sessions — always last so auth stays valid during deletion
      db.session.deleteMany({ where: { shop } }),
    ]);

    console.log(`[GDPR] shop/redact complete for ${shop}`);
  } catch (err) {
    // Log the error but still return 200 — Shopify will retry on non-200,
    // which could cause issues if partial deletion already occurred.
    // Investigate any errors in Railway logs.
    console.error(`[GDPR] shop/redact error for ${shop}:`, err);
  }

  return new Response(null, { status: 200 });
};
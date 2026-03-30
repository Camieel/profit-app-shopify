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
    // Delete in correct order to respect foreign key constraints
    await db.alert.deleteMany({ where: { shop } });
    await db.orderLineItem.deleteMany({
      where: { order: { shop } },
    });
    await db.order.deleteMany({ where: { shop } });
    await db.productVariant.deleteMany({
      where: { product: { shop } },
    });
    await db.product.deleteMany({ where: { shop } });
    await db.shopSettings.deleteMany({ where: { shop } });
    await db.session.deleteMany({ where: { shop } });
    await db.shop.deleteMany({ where: { shop } });

    console.log(`[GDPR] shop/redact complete for ${shop}`);
  } catch (err) {
    console.error(`[GDPR] shop/redact error for ${shop}:`, err);
  }

  return new Response(null, { status: 200 });
};
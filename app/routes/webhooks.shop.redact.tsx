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
    // We gebruiken een transactie om te zorgen dat het 'alles of niets' is. 
    // Faalt er één, dan worden ze allemaal ongedaan gemaakt (rollback).
    await db.$transaction([
      db.alert.deleteMany({ where: { shop } }),
      db.orderLineItem.deleteMany({ where: { order: { shop } } }),
      db.order.deleteMany({ where: { shop } }),
      db.productVariant.deleteMany({ where: { product: { shop } } }),
      db.product.deleteMany({ where: { shop } }),
      db.shopSettings.deleteMany({ where: { shop } }),
      db.session.deleteMany({ where: { shop } }),
      
      // De ontbrekende tabellen uit je andere routes:
      db.expense.deleteMany({ where: { shop } }),
      db.adIntegration.deleteMany({ where: { shop } }),
      db.adSpend.deleteMany({ where: { shop } }),
      
      // En als allerlaatste de shop zelf verwijderen
      db.shop.deleteMany({ where: { shop } }),
    ]);

    console.log(`[GDPR] shop/redact complete for ${shop}`);
  } catch (err) {
    console.error(`[GDPR] shop/redact error for ${shop}:`, err);
  }

  return new Response(null, { status: 200 });
};
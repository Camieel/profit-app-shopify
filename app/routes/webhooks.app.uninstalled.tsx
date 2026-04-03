// app/routes/webhooks.app.uninstalled.tsx

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`[Webhook] Received ${topic} for ${shop}`);

  try {
    // 1. Verwijder de sessie(s) zodat ze niet meer in kunnen loggen zonder te herinstalleren
    if (session) {
      await db.session.deleteMany({ where: { shop } });
    }

    // 2. Markeer de winkel als inactief in JOUW database!
    // Dit voorkomt dat je cronjobs en background syncs blijven draaien voor uninstalled shops.
    await db.shop.updateMany({
      where: { shop },
      data: { isActive: false },
    });

    console.log(`[Webhook] Successfully marked ${shop} as uninstalled and inactive.`);
  } catch (err) {
    console.error(`[Webhook Error] app/uninstalled for ${shop}:`, err);
  }

  return new Response(null, { status: 200 });
};
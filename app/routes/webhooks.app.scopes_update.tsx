// app/routes/webhooks.app.scopes_update.tsx

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  console.log(`[Webhook] Received ${topic} for ${shop}`);

  try {
    const current = payload.current as string[];
    
    if (session) {
      await db.session.update({   
        where: { id: session.id },
        data: { scope: current.join(",") },
      });
      console.log(`[Webhook] Scopes updated successfully for ${shop}`);
    }
  } catch (err) {
    console.error(`[Webhook Error] scopes_update for ${shop}:`, err);
  }

  return new Response(null, { status: 200 });
};
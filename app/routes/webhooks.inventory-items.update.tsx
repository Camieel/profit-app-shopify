// app/routes/webhooks.inventory-items.update.tsx

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload } = await authenticate.webhook(request);

  const item = payload as any;

  try {
    // Veilig parsen: check expliciet of het niet null/undefined is.
    // Dit zorgt ervoor dat een kostprijs van 0 netjes behouden blijft.
    let cost: number | null = null;
    if (item.cost != null) {
      const parsedCost = parseFloat(item.cost);
      if (!isNaN(parsedCost)) {
        cost = parsedCost;
      }
    }

    // Shopify payloads hebben vaak de admin_graphql_api_id al ingebouwd, 
    // maar handmatig opbouwen als fallback is de veiligste manier.
    const shopifyInventoryItemId = item.admin_graphql_api_id || `gid://shopify/InventoryItem/${item.id}`;

    // Find variant by inventory item ID and update cost
    const variant = await db.productVariant.findFirst({
      where: { shopifyInventoryItemId },
    });

    if (variant) {
      await db.productVariant.update({
        where: { id: variant.id },
        data: {
          costPerItem: cost,
          // Only update effectiveCost if no custom cost override
          effectiveCost: variant.customCost ?? cost,
        },
      });
      console.log(`[Inventory Updated] cost: ${cost} for variant ${variant.id}`);
    }
  } catch (err) {
    console.error("[Webhook Error] inventory-items/update:", err);
  }

  return new Response(null, { status: 200 });
};
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const item = payload as any;

  try {
    const cost = item.cost ? parseFloat(item.cost) : null;
    const shopifyInventoryItemId = `gid://shopify/InventoryItem/${item.id}`;

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
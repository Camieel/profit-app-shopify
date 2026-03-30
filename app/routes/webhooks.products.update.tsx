import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, admin } = await authenticate.webhook(request);

  if (!admin) return new Response(null, { status: 200 });

  const product = payload as any;
  const shopifyProductId = `gid://shopify/Product/${product.id}`;

  try {
    const savedProduct = await db.product.upsert({
      where: { shop_shopifyProductId: { shop, shopifyProductId } },
      update: { title: product.title },
      create: { shop, shopifyProductId, title: product.title },
    });

    for (const variant of product.variants || []) {
      // Fetch cost from Admin API — REST payload doesn't include unitCost
      const costResponse: any = await admin.graphql(
        `#graphql
        query getCost($id: ID!) {
          productVariant(id: $id) {
            inventoryItem { unitCost { amount } }
          }
        }`,
        { variables: { id: `gid://shopify/ProductVariant/${variant.id}` } }
      );
      const costData: any = await costResponse.json();
      const costPerItem = costData.data?.productVariant?.inventoryItem?.unitCost?.amount
        ? parseFloat(costData.data.productVariant.inventoryItem.unitCost.amount)
        : null;

      await db.productVariant.upsert({
        where: {
          productId_shopifyVariantId: {
            productId: savedProduct.id,
            shopifyVariantId: String(variant.id),
          },
        },
        update: {
          title: variant.title,
          sku: variant.sku ?? null,
          costPerItem,
          effectiveCost: costPerItem,
        },
        create: {
          productId: savedProduct.id,
          shopifyVariantId: String(variant.id),
          title: variant.title,
          sku: variant.sku ?? null,
          costPerItem,
          effectiveCost: costPerItem,
        },
      });
    }

    console.log(`[Product Updated] ${product.title}`);
  } catch (err) {
    console.error("[Webhook Error] products/update:", err);
  }

  return new Response(null, { status: 200 });
};
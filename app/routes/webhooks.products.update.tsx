// app/routes/webhooks.products.update.tsx

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, admin } = await authenticate.webhook(request);

  if (!admin) return new Response(null, { status: 200 });

  const product = payload as any;
  const shopifyProductId = product.admin_graphql_api_id || `gid://shopify/Product/${product.id}`;

  try {
    // 1. Upsert het hoofdproduct
    const savedProduct = await db.product.upsert({
      where: { shop_shopifyProductId: { shop, shopifyProductId } },
      update: { title: product.title },
      create: { shop, shopifyProductId, title: product.title },
    });

    // 2. Haal bestaande varianten uit ONZE database op om customCosts te beschermen
    const existingVariants = await db.productVariant.findMany({
      where: { productId: savedProduct.id },
      select: { shopifyVariantId: true, customCost: true }
    });
    const customCostMap = new Map(existingVariants.map(v => [v.shopifyVariantId, v.customCost]));

    // 3. Haal kostprijzen én verkoopprijzen op via GraphQL
    const costResponse = await admin.graphql(
      `#graphql
      query getProductCosts($id: ID!) {
        product(id: $id) {
          variants(first: 100) {
            edges {
              node {
                id
                price
                inventoryItem {
                  id
                  unitCost { amount }
                }
              }
            }
          }
        }
      }`,
      { variables: { id: shopifyProductId } }
    );

    const costData: any = await costResponse.json();
    const graphqlVariants = costData.data?.product?.variants?.edges || [];

    const shopifyCostMap = new Map();
    const shopifyInventoryMap = new Map();
    const shopifyPriceMap = new Map();

    for (const { node } of graphqlVariants) {
      const cost = node.inventoryItem?.unitCost?.amount
        ? parseFloat(node.inventoryItem.unitCost.amount)
        : null;
      const price = node.price ? parseFloat(node.price) : null;
      shopifyCostMap.set(node.id, cost);
      shopifyInventoryMap.set(node.id, node.inventoryItem?.id ?? null);
      shopifyPriceMap.set(node.id, price);
    }

    // 4. Update alle varianten parallel
    await Promise.all((product.variants || []).map((variant: any) => {
      const variantId = variant.admin_graphql_api_id || `gid://shopify/ProductVariant/${variant.id}`;

      const costPerItem = shopifyCostMap.get(variantId) ?? null;
      const inventoryItemId = shopifyInventoryMap.get(variantId) ?? null;
      const price = shopifyPriceMap.get(variantId) ?? null;

      const customCost = customCostMap.get(variantId) ?? null;
      // BELANGRIJK: Respecteer de customCost van de handelaar als die bestaat!
      const effectiveCost = customCost ?? costPerItem;

      return db.productVariant.upsert({
        where: {
          productId_shopifyVariantId: {
            productId: savedProduct.id,
            shopifyVariantId: variantId,
          },
        },
        update: {
          title: variant.title,
          sku: variant.sku ?? null,
          shopifyInventoryItemId: inventoryItemId,
          price,
          costPerItem,
          effectiveCost,
        },
        create: {
          productId: savedProduct.id,
          shopifyVariantId: variantId,
          title: variant.title,
          sku: variant.sku ?? null,
          shopifyInventoryItemId: inventoryItemId,
          price,
          costPerItem,
          effectiveCost,
        },
      });
    }));

    console.log(`[Product Updated] ${product.title}`);
  } catch (err) {
    console.error("[Webhook Error] products/update:", err);
  }

  return new Response(null, { status: 200 });
};
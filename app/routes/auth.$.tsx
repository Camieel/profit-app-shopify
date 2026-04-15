// app/routes/auth.$.tsx

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  await db.shop.upsert({
    where: { shop: session.shop },
    update: { isActive: true },
    create: { shop: session.shop },
  });

  await db.shopSettings.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });

  syncAllProductCosts(admin, session.shop).catch((err) =>
    console.error("[Background Sync] Failed during auth:", err)
  );

  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

async function syncAllProductCosts(admin: any, shop: string) {
  console.log(`[COGS Sync] Starting for ${shop}`);
  let cursor: string | null = null;

  do {
    const result: any = await admin.graphql(
      `#graphql
      query GetProducts($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id title
              variants(first: 100) {
                edges {
                  node {
                    id title sku
                    price
                    inventoryItem {
                      id
                      unitCost { amount }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { cursor } }
    );

    const data: any = await result.json();
    const products = data.data?.products?.edges || [];

    for (const { node: product } of products) {
      // 1. Upsert Product
      const savedProduct = await db.product.upsert({
        where: { shop_shopifyProductId: { shop, shopifyProductId: product.id } },
        update: { title: product.title },
        create: { shop, shopifyProductId: product.id, title: product.title },
      });

      // 2. Upsert all variants — preserve customCost overrides
      await Promise.all(
        product.variants.edges.map(async ({ node: variant }: any) => {
          const costPerItem = variant.inventoryItem?.unitCost?.amount
            ? parseFloat(variant.inventoryItem.unitCost.amount)
            : null;

          const price = variant.price ? parseFloat(variant.price) : null;

          // Check if merchant has set a custom cost override
          const existing = await db.productVariant.findUnique({
            where: {
              productId_shopifyVariantId: {
                productId: savedProduct.id,
                shopifyVariantId: variant.id,
              },
            },
            select: { customCost: true },
          });

          // effectiveCost priority: customCost (merchant override) → costPerItem (Shopify) → null
          const effectiveCost = existing?.customCost ?? costPerItem ?? null;

          return db.productVariant.upsert({
            where: {
              productId_shopifyVariantId: {
                productId: savedProduct.id,
                shopifyVariantId: variant.id,
              },
            },
            update: {
              title: variant.title,
              sku: variant.sku ?? null,
              shopifyInventoryItemId: variant.inventoryItem?.id ?? null,
              price,
              costPerItem,
              // Never overwrite customCost — only update effectiveCost
              // using the correct priority: customCost > costPerItem
              effectiveCost,
            },
            create: {
              productId: savedProduct.id,
              shopifyVariantId: variant.id,
              title: variant.title,
              sku: variant.sku ?? null,
              shopifyInventoryItemId: variant.inventoryItem?.id ?? null,
              price,
              costPerItem,
              effectiveCost: costPerItem, // No custom cost yet on create
            },
          });
        })
      );
    }

    cursor = data.data?.products?.pageInfo?.hasNextPage
      ? data.data?.products?.pageInfo?.endCursor
      : null;

  } while (cursor);

  console.log(`[COGS Sync] Complete for ${shop}`);
}
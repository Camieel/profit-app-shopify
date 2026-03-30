// app/routes/app.tsx
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  // Ensure Shop + ShopSettings exist on every admin request
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

  // Sync COGS if no products in DB yet
  const productCount = await db.product.count({ where: { shop: session.shop } });
  if (productCount === 0) {
    syncAllProductCosts(admin, session.shop).catch(console.error);
  }

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        <s-app-nav>
          <s-link href="/app">Dashboard</s-link>
          <s-link href="/app/orders">Orders</s-link>
          <s-link href="/app/products">Products</s-link>
          <s-link href="/app/expenses">Expenses</s-link>
          <s-link href="/app/settings">Settings</s-link>
        </s-app-nav>
        <Outlet />
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

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
      const savedProduct = await db.product.upsert({
        where: { shop_shopifyProductId: { shop, shopifyProductId: product.id } },
        update: { title: product.title },
        create: { shop, shopifyProductId: product.id, title: product.title },
      });

      for (const { node: variant } of product.variants.edges) {
        const costPerItem = variant.inventoryItem?.unitCost?.amount
          ? parseFloat(variant.inventoryItem.unitCost.amount)
          : null;

        await db.productVariant.upsert({
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
            costPerItem,
            effectiveCost: costPerItem,
          },
          create: {
            productId: savedProduct.id,
            shopifyVariantId: variant.id,
            title: variant.title,
            sku: variant.sku ?? null,
            shopifyInventoryItemId: variant.inventoryItem?.id ?? null,
            costPerItem,
            effectiveCost: costPerItem,
          },
        });
      }
    }

    cursor = data.data?.products?.pageInfo?.hasNextPage
      ? data.data?.products?.pageInfo?.endCursor
      : null;
  } while (cursor);

  console.log(`[COGS Sync] Complete for ${shop}`);
}
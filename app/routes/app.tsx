// app/routes/app.tsx

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, redirect, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Vertelt TypeScript dat de Shopify Web Component <ui-nav-menu> een geldige HTML tag is
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "ui-nav-menu": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  // Initialize shop and settings
  await db.shop.upsert({
    where: { shop: session.shop },
    update: { isActive: true },
    create: { shop: session.shop },
  });

  const settings = await db.shopSettings.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });

  // Redirect to onboarding if not complete, preserving Shopify auth params
  if (!url.pathname.includes("/onboarding") && !settings.onboardingComplete) {
    return redirect(`/app/onboarding?${url.searchParams.toString()}`);
  }

  // Background product sync for fresh installs
  const productCount = await db.product.count({ where: { shop: session.shop } });
  if (productCount === 0) {
    syncAllProductCosts(admin, session.shop).catch((err) => 
      console.error("[Background Sync] Failed:", err)
    );
  }

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        {/* Modern App Bridge v4 Navigation */}
        <ui-nav-menu>
          <a href="/app" rel="home">Dashboard</a>
          <a href="/app/orders">Orders</a>
          <a href="/app/products">Products</a>
          <a href="/app/expenses">Expenses</a>
          <a href="/app/settings">Settings</a>
        </ui-nav-menu>
        
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

// --- Background Sync Task ---
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
      // 1. Upsert Product
      const savedProduct = await db.product.upsert({
        where: { shop_shopifyProductId: { shop, shopifyProductId: product.id } },
        update: { title: product.title },
        create: { shop, shopifyProductId: product.id, title: product.title },
      });

      // 2. Upsert all variants in parallel (Much faster!)
      await Promise.all(
        product.variants.edges.map(({ node: variant }: any) => {
          const costPerItem = variant.inventoryItem?.unitCost?.amount
            ? parseFloat(variant.inventoryItem.unitCost.amount)
            : null;

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
              costPerItem,
              effectiveCost: costPerItem, // Sets baseline effective cost
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
        })
      );
    }

    cursor = data.data?.products?.pageInfo?.hasNextPage
      ? data.data?.products?.pageInfo?.endCursor
      : null;
      
  } while (cursor);

  console.log(`[COGS Sync] Complete for ${shop}`);
}
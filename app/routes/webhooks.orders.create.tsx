// app/routes/webhooks.orders.create.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { triggerOrderProfitCalculated } from "../lib/flow.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, admin, payload } = await authenticate.webhook(request);

  if (!admin) return new Response(null, { status: 200 });

  if (topic !== "ORDERS_CREATE") {
    return new Response(null, { status: 200 });
  }

  try {
    const order = payload as any;
    const settings = await db.shopSettings.findUnique({ where: { shop } });

    // 1. Revenue
    const revenue = parseFloat(order.total_price);
    const shippingRevenue = parseFloat(
      order.total_shipping_price_set?.shop_money?.amount || "0"
    );
    const discounts = parseFloat(order.total_discounts || "0");

    // 2. Transaction fees — formula fallback
    const feePercent = settings?.transactionFeePercent ?? 2.9;
    const feeFixed = settings?.transactionFeeFixed ?? 0.30;
    const extraPercent = settings?.shopifyExtraFeePercent ?? 0;
    const transactionFee =
      revenue * (feePercent / 100) + feeFixed + revenue * (extraPercent / 100);

    // 3. COGS — match on both plain ID and GID format
    const variantIds = order.line_items
      .filter((item: any) => item.variant_id)
      .map((item: any) => String(item.variant_id));

    const gidVariantIds = variantIds.map(
      (id: string) => `gid://shopify/ProductVariant/${id}`
    );

    const variants = await db.productVariant.findMany({
      where: { shopifyVariantId: { in: [...variantIds, ...gidVariantIds] } },
    });

    const variantMap = new Map<string, typeof variants[number]>();
    for (const v of variants) {
      variantMap.set(v.shopifyVariantId, v);
      const plainId = v.shopifyVariantId.replace(
        "gid://shopify/ProductVariant/",
        ""
      );
      variantMap.set(plainId, v);
    }

    let totalCogs = 0;
    let cogsComplete = true;
    const lineItemsData = [];

    for (const item of order.line_items) {
      const variant = variantMap.get(String(item.variant_id));
      const effectiveCost = variant?.effectiveCost ?? null;
      const itemCogs = effectiveCost ? effectiveCost * item.quantity : 0;

      if (!effectiveCost) cogsComplete = false;
      totalCogs += itemCogs;

      lineItemsData.push({
        shopifyVariantId: String(item.variant_id),
        productTitle: item.title,
        variantTitle: item.variant_title ?? null,
        quantity: item.quantity,
        price: parseFloat(item.price),
        discount: parseFloat(item.total_discount || "0"),
        cogs: itemCogs,
        cogsFound: !!effectiveCost,
      });
    }

    // 4. Shipping cost
    const shippingCost = settings?.defaultShippingCost ?? 0;

    // 5. Profit
    const grossProfit = revenue - totalCogs;
    const netProfit = revenue - totalCogs - transactionFee - shippingCost;
    const marginPercent = revenue > 0 ? (netProfit / revenue) * 100 : 0;

    // 6. Save to DB
    const savedOrder = await db.order.create({
      data: {
        shop,
        shopifyOrderId: `gid://shopify/Order/${order.id}`,
        shopifyOrderName: order.name,
        totalPrice: revenue,
        subtotalPrice: parseFloat(order.subtotal_price),
        totalTax: parseFloat(order.total_tax || "0"),
        totalDiscounts: discounts,
        shippingRevenue,
        currency: order.currency,
        cogs: totalCogs,
        transactionFee,
        shippingCost,
        grossProfit,
        netProfit,
        marginPercent,
        cogsComplete,
        financialStatus: order.financial_status ?? null,
        fulfillmentStatus: order.fulfillment_status ?? null,
        shopifyCreatedAt: new Date(order.created_at),
        lineItems: { create: lineItemsData },
      },
    });

    console.log(
      `[Order Saved] ${order.name} | Margin: ${marginPercent.toFixed(1)}% | Net: ${netProfit.toFixed(2)}`
    );

    triggerOrderProfitCalculated({
  admin,
  shop,
  orderId: `gid://shopify/Order/${order.id}`,
  orderName: order.name,
  marginPercent,
  netProfit,
  revenue,
}).catch(console.error);

    // 7. Hold + alert logic
    if (settings?.holdEnabled || settings?.alertEnabled) {
      const marginThreshold = settings?.holdMarginThreshold ?? 0;
      const shouldHold =
        settings?.holdEnabled &&
        (netProfit < 0 ||
          (marginThreshold > 0 && marginPercent < marginThreshold));

      if (shouldHold) {
        // Retry loop — fulfillment order may not be ready immediately
        let fo = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }

          const foResponse: any = await admin.graphql(
            `#graphql
            query getFulfillmentOrders($id: ID!) {
              order(id: $id) {
                fulfillmentOrders(first: 1) {
                  nodes { id status }
                }
              }
            }`,
            { variables: { id: `gid://shopify/Order/${order.id}` } }
          );

          const foData: any = await foResponse.json();
          const candidate =
            foData.data?.order?.fulfillmentOrders?.nodes?.[0];

          if (candidate && candidate.status === "OPEN") {
            fo = candidate;
            break;
          }
        }

        if (fo) {
          await admin.graphql(
            `#graphql
            mutation holdFulfillment($id: ID!, $reasonNotes: String!) {
              fulfillmentOrderHold(id: $id, fulfillmentHold: { reason: OTHER, reasonNotes: $reasonNotes }) {
                fulfillmentOrder { id status }
                userErrors { field message }
              }
            }`,
            {
              variables: {
                id: fo.id,
                reasonNotes: `Held by Profit Tracker: Margin ${marginPercent.toFixed(1)}% (threshold: ${marginThreshold}%). Revenue: ${revenue}, COGS: ${totalCogs}.`,
              },
            }
          );

          await db.order.update({
            where: { id: savedOrder.id },
            data: {
              isHeld: true,
              heldReason: `Margin ${marginPercent.toFixed(1)}% below threshold`,
            },
          });

          console.log(`[Hold Placed] ${order.name}`);
        } else {
          console.log(
            `[Hold Skipped] ${order.name} — fulfillment order not ready after 3 attempts`
          );
        }
      }

      // Save alert
      const alertMarginThreshold = settings?.alertMarginThreshold ?? 0;
      const belowMargin =
        alertMarginThreshold > 0 && marginPercent < alertMarginThreshold;
      const belowProfit =
        (settings?.alertProfitThreshold ?? 0) !== 0 &&
        netProfit < (settings?.alertProfitThreshold ?? 0);

      if (belowMargin || belowProfit || netProfit < 0) {
        await db.alert.create({
          data: {
            shop,
            orderId: savedOrder.id,
            type: netProfit < 0 ? "negative_profit" : "low_margin",
            message: `Order ${order.name}: ${marginPercent.toFixed(1)}% margin`,
            data: {
              revenue,
              cogs: totalCogs,
              transactionFee,
              shippingCost,
              netProfit,
              marginPercent,
            },
          },
        });
      }
    }
  } catch (err) {
    console.error("[Webhook Error] orders/create:", err);
  }

  return new Response(null, { status: 200 });
};
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { triggerOrderProfitCalculated } from "../lib/flow.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, admin, payload } = await authenticate.webhook(request);

  if (!admin) return new Response(null, { status: 200 });
  if (topic !== "ORDERS_CREATE") return new Response(null, { status: 200 });

  try {
    const order = payload as any;
    const settings = await db.shopSettings.findUnique({ where: { shop } });

    // 1. Revenue
    const revenue = parseFloat(order.total_price);
    const shippingRevenue = parseFloat(
      order.total_shipping_price_set?.shop_money?.amount || "0"
    );
    const discounts = parseFloat(order.total_discounts || "0");

    // 2. Transaction fees
    const feePercent = settings?.transactionFeePercent ?? 2.9;
    const feeFixed = settings?.transactionFeeFixed ?? 0.30;
    const extraPercent = settings?.shopifyExtraFeePercent ?? 0;
    const transactionFee =
      revenue * (feePercent / 100) + feeFixed + revenue * (extraPercent / 100);

    // 3. COGS
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
      const plainId = v.shopifyVariantId.replace("gid://shopify/ProductVariant/", "");
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

    // 5. Ad spend allocation
    let adSpendAllocated = 0;
    try {
      const today = new Date().toISOString().split("T")[0];
      const todaySpend = await (db as any).adSpend.findMany({
        where: { shop, date: today },
      });

      if (todaySpend.length > 0) {
        const totalSpend = todaySpend.reduce((s: number, d: any) => s + d.spend, 0);

        const todayOrders = await db.order.findMany({
          where: {
            shop,
            shopifyCreatedAt: {
              gte: new Date(today),
              lt: new Date(new Date(today).getTime() + 86400000),
            },
          },
        });

        const todayRevenue = todayOrders.reduce((s, o) => s + o.totalPrice, 0) + revenue;

        if (todayRevenue > 0) {
          adSpendAllocated = (revenue / todayRevenue) * totalSpend;
        }
      }
    } catch (err) {
      console.error("[Ad Spend Allocation] Error:", err);
    }

    // 6. Profit
    const grossProfit = revenue - totalCogs;
    const netProfit = revenue - totalCogs - transactionFee - shippingCost - adSpendAllocated;
    const marginPercent = revenue > 0 ? (netProfit / revenue) * 100 : 0;

    // 7. Save to DB
    const savedOrder = await (db.order.create as any)({
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
    adSpendAllocated,
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
      `[Order Saved] ${order.name} | Margin: ${marginPercent.toFixed(1)}% | Net: ${netProfit.toFixed(2)} | Ad spend: $${adSpendAllocated.toFixed(2)}`
    );

    // 8. Flow trigger
    triggerOrderProfitCalculated({
      admin,
      shop,
      orderId: `gid://shopify/Order/${order.id}`,
      orderName: order.name,
      marginPercent,
      netProfit,
      revenue,
    }).catch(console.error);

    // 9. Hold + alert logic
    if (settings?.holdEnabled || settings?.alertEnabled) {
      const marginThreshold = settings?.holdMarginThreshold ?? 0;
      const shouldHold =
        settings?.holdEnabled &&
        (netProfit < 0 || (marginThreshold > 0 && marginPercent < marginThreshold));

      if (shouldHold) {
        let fo = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));

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
          const candidate = foData.data?.order?.fulfillmentOrders?.nodes?.[0];

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
                reasonNotes: `Held by Profit Tracker: Margin ${marginPercent.toFixed(1)}% (threshold: ${marginThreshold}%). Revenue: ${revenue}, COGS: ${totalCogs}, Ad spend: ${adSpendAllocated.toFixed(2)}.`,
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
        }
      }

      // Alert
      const alertMarginThreshold = settings?.alertMarginThreshold ?? 0;
      const belowMargin = alertMarginThreshold > 0 && marginPercent < alertMarginThreshold;
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
              adSpendAllocated,
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
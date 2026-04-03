// app/routes/webhooks.orders.updated.tsx

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Helper om een ID te genereren (consistent met orders.create.tsx)
function generateCuid() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const order = payload as any;
  const shopifyOrderId = `gid://shopify/Order/${order.id}`;

  try {
    const existing = await db.order.findUnique({
      where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
    });

    if (!existing) return new Response(null, { status: 200 });

    const financialStatus = order.financial_status ?? null;
    const fulfillmentStatus = order.fulfillment_status ?? null;

    // Check if order has refunds
    const isRefunded = financialStatus === "refunded";
    const isPartiallyRefunded = financialStatus === "partially_refunded";

    if (isRefunded || isPartiallyRefunded) {
      // Calculate total refunded amount using shop_money for multi-currency safety
      const totalRefunded = (order.refunds ?? []).reduce(
        (sum: number, refund: any) => {
          const refundLineItems = refund.refund_line_items ?? [];
          const lineItemTotal = refundLineItems.reduce(
            (s: number, item: any) =>
              s + parseFloat(item.subtotal_set?.shop_money?.amount ?? item.subtotal ?? "0"),
            0
          );
          // Also include shipping refunds (using shop_money if available)
          const shippingRefund = (refund.order_adjustments ?? [])
            .filter((adj: any) => adj.kind === "shipping_refund")
            .reduce((s: number, adj: any) => s + Math.abs(parseFloat(adj.amount_set?.shop_money?.amount ?? adj.amount ?? "0")), 0);

          return sum + lineItemTotal + shippingRefund;
        },
        0
      );

      // Recalculate revenue based on current_subtotal_price (after refunds, using shop_money)
      const newRevenue = parseFloat(order.current_subtotal_price_set?.shop_money?.amount ?? order.current_subtotal_price ?? "0");
      const currentTotalPrice = parseFloat(order.current_total_price_set?.shop_money?.amount ?? order.current_total_price ?? "0");
      const currentTotalTax = parseFloat(order.current_total_tax_set?.shop_money?.amount ?? order.current_total_tax ?? "0");
      
      const newShippingRevenue = currentTotalPrice - newRevenue - currentTotalTax;

      // Keep original COGS — refunded items still had a cost
      // But proportionally reduce if fully refunded
      let newCogs = existing.cogs;
      if (isRefunded) {
        newCogs = 0; // Full refund — no revenue, no COGS impact on profit
      } else if (isPartiallyRefunded && existing.totalPrice > 0) {
        // Proportionally reduce COGS based on how much was refunded
        const refundRatio = totalRefunded / existing.totalPrice;
        newCogs = existing.cogs * (1 - refundRatio);
      }

      // Recalculate profit (Fixed: Include adSpendAllocated!)
      const newGrossProfit = newRevenue - newCogs;
      const newNetProfit = newRevenue - newCogs - existing.transactionFee - existing.shippingCost - existing.adSpendAllocated;
      const newMarginPercent = newRevenue > 0 ? (newNetProfit / newRevenue) * 100 : 0;

      await db.order.update({
        where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
        data: {
          totalPrice: newRevenue,
          shippingRevenue: newShippingRevenue > 0 ? newShippingRevenue : existing.shippingRevenue,
          cogs: newCogs,
          grossProfit: newGrossProfit,
          netProfit: newNetProfit,
          marginPercent: newMarginPercent,
          financialStatus,
          fulfillmentStatus,
        },
      });

      console.log(
        `[Order Updated] ${order.name} | Status: ${financialStatus} | Refunded: $${totalRefunded.toFixed(2)} | New net profit: $${newNetProfit.toFixed(2)}`
      );

      // Create alert for refund if it caused a loss
      if (newNetProfit < 0 && existing.netProfit >= 0) {
        await db.alert.create({
          data: {
            id: generateCuid(), // Toegevoegd voor de zekerheid
            shop,
            orderId: existing.id,
            type: "negative_profit",
            message: `Order ${order.name} turned unprofitable after refund: ${newMarginPercent.toFixed(1)}% margin`,
            data: {
              revenue: newRevenue,
              cogs: newCogs,
              transactionFee: existing.transactionFee,
              shippingCost: existing.shippingCost,
              adSpendAllocated: existing.adSpendAllocated, // Toegevoegd aan de payload
              netProfit: newNetProfit,
              marginPercent: newMarginPercent,
              refundedAmount: totalRefunded,
            },
          },
        });
        console.log(`[Alert Created] ${order.name} turned unprofitable after refund`);
      }
    } else {
      // No refund — just update statuses
      await db.order.update({
        where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
        data: { financialStatus, fulfillmentStatus },
      });

      console.log(`[Order Updated] ${order.name} | Status: ${financialStatus}`);
    }
  } catch (err) {
    console.error("[Webhook Error] orders/updated:", err);
  }

  return new Response(null, { status: 200 });
};
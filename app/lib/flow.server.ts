// app/lib/flow.server.ts

/**
 * Send a Flow trigger event when an order profit is calculated.
 * This allows merchants to build Flow automations based on profit data.
 */
export async function triggerOrderProfitCalculated({
  admin,
  shop,
  orderId,
  orderName,
  marginPercent,
  netProfit,
  revenue,
}: {
  admin: any;
  shop: string;
  orderId: string;
  orderName: string;
  marginPercent: number;
  netProfit: number;
  revenue: number;
}) {
  try {
    const isLoss = netProfit < 0;

    // Send Flow trigger via Admin API
    const response: any = await admin.graphql(
      `#graphql
      mutation flowTriggerReceive($body: String!) {
        flowTriggerReceive(body: $body) {
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          body: JSON.stringify({
            trigger_id: "order-profit-calculated",
            properties: {
              order_id: orderId,
              order_name: orderName,
              margin_percent: Math.round(marginPercent * 100) / 100,
              net_profit: Math.round(netProfit * 100) / 100,
              revenue: Math.round(revenue * 100) / 100,
              is_loss: isLoss,
            },
          }),
        },
      }
    );

    const data: any = await response.json();
    const errors = data.data?.flowTriggerReceive?.userErrors;

    if (errors?.length > 0) {
      console.error("[Flow Trigger] Errors:", errors);
    } else {
      console.log(
        `[Flow Trigger] order-profit-calculated sent for ${orderName} | margin: ${marginPercent.toFixed(1)}%`
      );
    }
  } catch (err) {
    // Never throw — Flow trigger failure should not affect order processing
    console.error("[Flow Trigger] Failed to send trigger:", err);
  }
}
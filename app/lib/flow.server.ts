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

    // Send Flow trigger via modern Admin API syntax
    const response: any = await admin.graphql(
      `#graphql
      mutation flowTriggerReceive($handle: String!, $payload: JSON!) {
        flowTriggerReceive(handle: $handle, payload: $payload) {
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          handle: "order-profit-calculated",
          payload: {
            order_id: orderId, // reference field gebruikt altijd z'n vaste ID
            "Order Name": orderName,
            "Margin Percent": Math.round(marginPercent * 100) / 100,
            "Net Profit": Math.round(netProfit * 100) / 100,
            "Revenue": Math.round(revenue * 100) / 100,
            "Is Loss": isLoss,
          },
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
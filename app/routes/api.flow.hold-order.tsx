// app/routes/api.flow.hold-order.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Flow Action endpoint — called by Shopify Flow when merchant triggers
 * the "Hold Order for Review" action in their Flow workflow.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // Destructure session instead of shop directly
  const { admin, payload, session } = await authenticate.flow(request);

  try {
    const orderId = payload?.order_id as string;
    const reason = (payload?.reason as string) || "Held by Shopify Flow";

    // Safely extract the shop domain from the session, fallback to payload
    const shop = session?.shop || (payload?.shop_domain as string);

    if (!orderId || !shop) {
      return json({ error: "order_id and shop are required" }, { status: 400 });
    }

    // Get fulfillment orders from Shopify
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
        { variables: { id: orderId } }
      );

      const foData: any = await foResponse.json();
      const candidate = foData.data?.order?.fulfillmentOrders?.nodes?.[0];

      if (candidate && candidate.status === "OPEN") {
        fo = candidate;
        break;
      }
    }

    if (fo) {
      const mutationRes = await admin.graphql(
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
            reasonNotes: reason,
          },
        }
      );
      
      const mutationData: any = await mutationRes.json();
      const errors = mutationData.data?.fulfillmentOrderHold?.userErrors;

      // Check if Shopify actually accepted the hold action
      if (errors && errors.length > 0) {
        console.error("[Flow Action] Shopify rejected hold:", errors);
        return json({ error: errors[0].message }, { status: 400 });
      }

      // Update our DB safely using an exact match and scoping to the shop
      const dbOrder = await db.order.findFirst({
        where: { shop, shopifyOrderId: orderId },
      });

      if (dbOrder) {
        await db.order.update({
          where: { id: dbOrder.id },
          data: { isHeld: true, heldReason: reason },
        });
      }

      console.log(`[Flow Action] Hold placed on ${orderId} — reason: ${reason}`);
    }

    return json({ success: true });
  } catch (err) {
    console.error("[Flow Action] hold-order error:", err);
    return json({ error: "Internal error" }, { status: 500 });
  }
};
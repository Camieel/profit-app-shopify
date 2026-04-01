import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";
import { sendWeeklySummaryEmail } from "../lib/email.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Simple secret check — zet SYNC_SECRET ook in Railway
  const secret = request.headers.get("x-cron-secret");
  if (secret !== process.env.SYNC_SECRET) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const weekEnd = new Date(now);
  weekEnd.setDate(weekEnd.getDate() - 1); // gisteren
  const weekStart = new Date(weekEnd);
  weekStart.setDate(weekStart.getDate() - 6); // 7 dagen geleden

  const weekStartStr = weekStart.toISOString().split("T")[0];
  const weekEndStr = weekEnd.toISOString().split("T")[0];

  // Alle shops met een alertEmail
  const shops = await db.shopSettings.findMany({
  where: {
    alertEmail: { not: null },
  },
  select: {
    shop: true,
    alertEmail: true,
  },
});

  let sent = 0;

  for (const shopSettings of shops) {
    if (!shopSettings.alertEmail) continue;

    try {
      const orders = await db.order.findMany({
        where: {
          shop: shopSettings.shop,
          shopifyCreatedAt: {
            gte: new Date(weekStartStr + "T00:00:00.000Z"),
            lte: new Date(weekEndStr + "T23:59:59.999Z"),
          },
        },
        select: {
          shopifyOrderName: true,
          totalPrice: true,
          netProfit: true,
          marginPercent: true,
          isHeld: true,
        },
        orderBy: { shopifyCreatedAt: "desc" },
      });

      if (orders.length === 0) continue;

      const totalRevenue = orders.reduce((s, o) => s + o.totalPrice, 0);
      const totalNetProfit = orders.reduce((s, o) => s + o.netProfit, 0);
      const avgMargin =
        orders.reduce((s, o) => s + o.marginPercent, 0) / orders.length;
      const heldCount = orders.filter((o) => o.isHeld).length;
      const lossOrders = orders.filter((o) => o.netProfit < 0);
      const topLosses = lossOrders
        .sort((a, b) => a.netProfit - b.netProfit)
        .slice(0, 5)
        .map((o) => ({
          orderName: o.shopifyOrderName,
          netProfit: o.netProfit,
          marginPercent: o.marginPercent,
        }));

      await sendWeeklySummaryEmail({
        to: shopSettings.alertEmail,
        shopDomain: shopSettings.shop,
        weekStart: weekStartStr,
        weekEnd: weekEndStr,
        totalRevenue,
        totalNetProfit,
        avgMargin,
        orderCount: orders.length,
        heldCount,
        lossCount: lossOrders.length,
        topLosses,
      });

      sent++;
    } catch (err) {
      console.error(`[Weekly Email] Failed for ${shopSettings.shop}:`, err);
    }
  }

  return json({ ok: true, sent, weekStart: weekStartStr, weekEnd: weekEndStr });
};
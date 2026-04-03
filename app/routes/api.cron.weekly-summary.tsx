// app/routes/api.cron.weekly-summary.tsx

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
    try {
      const dateFilter = {
        gte: new Date(`${weekStartStr}T00:00:00.000Z`),
        lte: new Date(`${weekEndStr}T23:59:59.999Z`),
      };

      // 1. Haal alle totalen op via de database
      const aggregations = await db.order.aggregate({
        where: { shop: shopSettings.shop, shopifyCreatedAt: dateFilter },
        _sum: { totalPrice: true, netProfit: true },
        _avg: { marginPercent: true },
        _count: { id: true },
      });

      const orderCount = aggregations._count.id;
      
      // Geen orders deze week? Dan geen e-mail sturen.
      if (orderCount === 0) continue;

      // 2. Haal de specifieke counts en top 5 verliezen efficiënt op
      const [heldCount, lossCount, topLosses] = await Promise.all([
        db.order.count({
          where: { shop: shopSettings.shop, shopifyCreatedAt: dateFilter, isHeld: true },
        }),
        db.order.count({
          where: { shop: shopSettings.shop, shopifyCreatedAt: dateFilter, netProfit: { lt: 0 } },
        }),
        db.order.findMany({
          where: { shop: shopSettings.shop, shopifyCreatedAt: dateFilter, netProfit: { lt: 0 } },
          select: { shopifyOrderName: true, netProfit: true, marginPercent: true },
          orderBy: { netProfit: "asc" }, // Sorteert van meest negatief naar minst negatief
          take: 5,
        }),
      ]);

      const totalRevenue = aggregations._sum.totalPrice ?? 0;
      const totalNetProfit = aggregations._sum.netProfit ?? 0;
      const avgMargin = aggregations._avg.marginPercent ?? 0;

      // We weten zeker dat alertEmail bestaat dankzij de Prisma query filter
      await sendWeeklySummaryEmail({
        to: shopSettings.alertEmail!,
        shopDomain: shopSettings.shop,
        weekStart: weekStartStr,
        weekEnd: weekEndStr,
        totalRevenue,
        totalNetProfit,
        avgMargin,
        orderCount,
        heldCount,
        lossCount,
        topLosses: topLosses.map((o) => ({
          orderName: o.shopifyOrderName,
          netProfit: o.netProfit,
          marginPercent: o.marginPercent,
        })),
      });

      sent++;
    } catch (err) {
      console.error(`[Weekly Email] Failed for ${shopSettings.shop}:`, err);
    }
  }

  return json({ ok: true, sent, weekStart: weekStartStr, weekEnd: weekEndStr });
};
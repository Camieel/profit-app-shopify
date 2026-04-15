import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useNavigate, useSearchParams } from "react-router";
import { useState, useEffect, useCallback } from "react";
import {
  Page, Layout, EmptyState, Modal, Checkbox, BlockStack, Text,
  SkeletonPage, SkeletonBodyText, SkeletonDisplayText,
} from "@shopify/polaris";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceDot, ReferenceLine,
} from "recharts";
import { authenticate } from "../shopify.server";
import { DateRangePicker, loadFromStorage } from "../DateRangePicker";
import db from "../db.server";
import { toMonthly } from "./app.expenses";

// ── Card config ───────────────────────────────────────────────────────────────
const ALL_CARDS = [
  { id: "action_center", label: "Action Center" },
  { id: "kpi_strip", label: "Key Metrics" },
  { id: "revenue_allocation", label: "Revenue Allocation" },
  { id: "product_leaderboard", label: "Product Leaderboard" },
  { id: "chart", label: "Profit Stability Chart" },
  { id: "priority_orders", label: "Priority Orders" },
  { id: "held_orders", label: "Held Orders" },
] as const;

type CardId = (typeof ALL_CARDS)[number]["id"];
const DEFAULT_CARDS: CardId[] = [
  "action_center", "kpi_strip", "revenue_allocation",
  "product_leaderboard", "chart", "priority_orders", "held_orders",
];

// ── Types ─────────────────────────────────────────────────────────────────────
type LossReason = "loss_due_to_ads"|"loss_due_to_cogs"|"loss_due_to_shipping"|"loss_due_to_fees"|"loss_mixed"|"low_margin"|"high_expenses";
type Confidence = "high"|"medium"|"low";

interface ActionItem {
  type: LossReason; severity: "critical"|"warning"|"info"; confidence: Confidence; score: number;
  title: string; description: string; impact: string; potentialRecovery: number | null;
  timeToFix: string; filterUrl: string; actions: { label: string; url: string; primary?: boolean }[];
}
interface TopLossProduct {
  productId: string; title: string; totalLoss: number; percentOfTotalLoss: number;
  topCostSource: "ads"|"cogs"|"shipping"|"fees"; topCostSourcePercent: number;
}
interface LossBreakdown {
  ads: number; cogs: number; shipping: number; fees: number; discounts: number; total: number;
  topSource: "ads"|"cogs"|"shipping"|"fees"|"discounts"; topSourcePercent: number;
  topSourceAmount: number; isDominant: boolean; topProduct: TopLossProduct | null;
}
interface ActionCenterState {
  state: "critical"|"warning"|"healthy"; heroInsight: string; items: ActionItem[];
  lossBreakdown: LossBreakdown | null;
  summary: { lossAmount: number; lossOrders: number; avgMargin: number; profit7d: number; lossPercent: number; maxSingleLoss: number };
}
interface KpiMetric {
  label: string; value: string; sub: string; trend: "up"|"down"|"neutral"; trendPositive: boolean; highlighted: boolean;
}
interface ChartPoint { date: string; dateKey: string; profit: number; revenue: number; orderCount: number; isLoss: boolean; }
interface PriorityOrder {
  id: string; shopifyOrderId: string; shopifyOrderName: string; netProfit: number; marginPercent: number;
  isHeld: boolean; cogsComplete: boolean; financialStatus: string | null; currency: string;
  topCostReason: string; repeatLossCount: number;
}
interface HeldOrder {
  id: string; shopifyOrderName: string; shopifyOrderId: string; netProfit: number;
  marginPercent: number; heldReason: string | null; totalPrice: number; currency: string;
}
interface RevenueAllocation { revenue: number; cogs: number; adSpend: number; shipping: number; fees: number; expenses: number; profit: number; }
interface ProductStat { title: string; profit: number; unitsSold: number; }
interface ExtendedKpis { unitsSold: number; avgOrderValue: number; avgOrderProfit: number; totalCogs: number; totalShipping: number; totalFees: number; }
interface LoaderData {
  actionCenter: ActionCenterState; kpiMetrics: KpiMetric[]; extendedKpis: ExtendedKpis;
  revenueAllocation: RevenueAllocation; productLeaderboard: { top: ProductStat[]; leaks: ProductStat[] };
  chartData: ChartPoint[]; priorityOrders: PriorityOrder[]; heldOrders: HeldOrder[];
  heldSavedAmount: number; missingCogsCount: number; missingCogsImpact: number;
  visibleCards: CardId[]; hasOrders: boolean; shop: string; dateFrom: string; dateTo: string;
}

// ── Server helpers ────────────────────────────────────────────────────────────
function toDateStr(d: Date) { return d.toISOString().split("T")[0]; }
function fmtCurrency(amount: number, currency = "USD") { return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(amount); }
function fmtK(n: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n); }
function getShopifyOrderUrl(shop: string, shopifyOrderId: string) { return `https://${shop}/admin/orders/${shopifyOrderId.replace("gid://shopify/Order/", "")}`; }
function getTopCostReason(o: { adSpendAllocated: number; cogs: number; shippingCost: number; transactionFee: number }): string {
  return [{ label: "Ads", value: o.adSpendAllocated ?? 0 }, { label: "COGS", value: o.cogs ?? 0 }, { label: "Shipping", value: o.shippingCost ?? 0 }, { label: "Fees", value: o.transactionFee ?? 0 }].reduce((max, c) => c.value > max.value ? c : max).label;
}

// ── Root cause analysis (unchanged) ──────────────────────────────────────────
function analyzeLossReasons(
  orders: Array<{ id: string; netProfit: number; adSpendAllocated: number; cogs: number; shippingCost: number; transactionFee: number; totalDiscounts: number }>,
  lineItemsByOrder: Map<string, Array<{ productId: string; productTitle: string; cogs: number; price: number; quantity: number }>>
): LossBreakdown | null {
  const lossOrders = orders.filter((o) => o.netProfit < 0);
  if (lossOrders.length === 0) return null;
  const breakdown = { ads: 0, cogs: 0, shipping: 0, fees: 0, discounts: 0 };
  for (const o of lossOrders) {
    const totalCosts = (o.adSpendAllocated ?? 0) + (o.cogs ?? 0) + (o.shippingCost ?? 0) + (o.transactionFee ?? 0) + (o.totalDiscounts ?? 0);
    if (totalCosts === 0) continue;
    const lossShare = Math.abs(o.netProfit) / totalCosts;
    breakdown.ads += (o.adSpendAllocated ?? 0) * lossShare; breakdown.cogs += (o.cogs ?? 0) * lossShare;
    breakdown.shipping += (o.shippingCost ?? 0) * lossShare; breakdown.fees += (o.transactionFee ?? 0) * lossShare;
    breakdown.discounts += (o.totalDiscounts ?? 0) * lossShare;
  }
  const total = breakdown.ads + breakdown.cogs + breakdown.shipping + breakdown.fees + breakdown.discounts;
  if (total === 0) return null;
  const entries = Object.entries(breakdown) as [keyof typeof breakdown, number][];
  const [topSource, topSourceAmount] = entries.reduce((max, cur) => cur[1] > max[1] ? cur : max);
  const topSourcePercent = Math.round((topSourceAmount / total) * 100);
  const isDominant = topSourcePercent > 50;
  const productLossMap = new Map<string, { title: string; loss: number; costBreakdown: { ads: number; cogs: number; shipping: number; fees: number } }>();
  for (const o of lossOrders) {
    const items = lineItemsByOrder.get(o.id) ?? [];
    const totalItemQuantity = items.reduce((s, i) => s + i.quantity, 0) || 1;
    const adsPerUnit = (o.adSpendAllocated ?? 0) / totalItemQuantity;
    const shippingPerUnit = (o.shippingCost ?? 0) / totalItemQuantity;
    const feesPerUnit = (o.transactionFee ?? 0) / totalItemQuantity;
    for (const item of items) {
      const revenue = item.price * item.quantity;
      const extraCosts = (adsPerUnit + shippingPerUnit + feesPerUnit) * item.quantity;
      const itemProfit = revenue - item.cogs - extraCosts;
      const existing = productLossMap.get(item.productId);
      const itemCostBreakdown = { ads: adsPerUnit * item.quantity, cogs: item.cogs, shipping: shippingPerUnit * item.quantity, fees: feesPerUnit * item.quantity };
      if (existing) { existing.loss += itemProfit; existing.costBreakdown.ads += itemCostBreakdown.ads; existing.costBreakdown.cogs += itemCostBreakdown.cogs; existing.costBreakdown.shipping += itemCostBreakdown.shipping; existing.costBreakdown.fees += itemCostBreakdown.fees; }
      else { productLossMap.set(item.productId, { title: item.productTitle, loss: itemProfit, costBreakdown: itemCostBreakdown }); }
    }
  }
  const lossProducts = [...productLossMap.entries()].filter(([, v]) => v.loss < 0).sort((a, b) => a[1].loss - b[1].loss);
  const totalProductLoss = lossProducts.reduce((s, [, v]) => s + Math.abs(v.loss), 0);
  let topProduct: TopLossProduct | null = null;
  if (lossProducts.length > 0) {
    const [pid, pdata] = lossProducts[0];
    const productLossAmount = Math.abs(pdata.loss);
    const pct = totalProductLoss > 0 ? Math.round((productLossAmount / totalProductLoss) * 100) : 0;
    const pBreakdown = pdata.costBreakdown;
    const pEntries = Object.entries(pBreakdown) as ["ads"|"cogs"|"shipping"|"fees", number][];
    const pTotal = pEntries.reduce((s, [, v]) => s + v, 0);
    const [pTopSource] = pEntries.reduce((max, cur) => cur[1] > max[1] ? cur : max);
    const pTopPct = pTotal > 0 ? Math.round((pBreakdown[pTopSource] / pTotal) * 100) : 0;
    topProduct = { productId: pid, title: pdata.title, totalLoss: productLossAmount, percentOfTotalLoss: pct, topCostSource: pTopSource, topCostSourcePercent: pTopPct };
  }
  return { ...breakdown, total, topSource, topSourcePercent, topSourceAmount, isDominant, topProduct };
}

// ── Loader (unchanged) ────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;
  const url = new URL(request.url);
  const now = new Date();
  const bypassOnboarding = url.searchParams.get("from") === "onboarding";
  if (!bypassOnboarding) {
    const onboardingCheck = await db.shopSettings.findUnique({ where: { shop }, select: { onboardingComplete: true } });
    if (!onboardingCheck?.onboardingComplete) return redirect("/app/onboarding");
  }
  const defaultTo = toDateStr(now);
  const defaultFrom = toDateStr(new Date(now.getTime() - 30 * 86400000));
  const rawFrom = url.searchParams.get("from");
  const dateFrom = (rawFrom && rawFrom !== "onboarding") ? rawFrom : defaultFrom;
  const dateTo = url.searchParams.get("to") || defaultTo;
  const since = new Date(dateFrom + "T00:00:00.000Z");
  const until = new Date(dateTo + "T23:59:59.999Z");
  const periodMs = until.getTime() - since.getTime();
  const prevSince = new Date(since.getTime() - periodMs);
  const prevUntil = new Date(since.getTime() - 1);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const [ordersInRange, ordersPrev, orders7d, heldOrders, missingCogsVariants, settings, expenses, totalOrderCount, lineItemsInRange] = await Promise.all([
    db.order.findMany({ where: { shop, shopifyCreatedAt: { gte: since, lte: until } }, select: { id: true, shopifyOrderId: true, shopifyOrderName: true, totalPrice: true, netProfit: true, marginPercent: true, isHeld: true, cogsComplete: true, financialStatus: true, currency: true, shopifyCreatedAt: true, cogs: true, transactionFee: true, shippingCost: true, adSpendAllocated: true } }),
    db.order.aggregate({ where: { shop, shopifyCreatedAt: { gte: prevSince, lte: prevUntil } }, _sum: { totalPrice: true, netProfit: true }, _avg: { marginPercent: true }, _count: { id: true } }),
    db.order.findMany({ where: { shop, shopifyCreatedAt: { gte: sevenDaysAgo } }, select: { id: true, netProfit: true, marginPercent: true, isHeld: true, adSpendAllocated: true, cogs: true, shippingCost: true, transactionFee: true, totalPrice: true, totalDiscounts: true } }),
    db.order.findMany({ where: { shop, isHeld: true }, orderBy: { shopifyCreatedAt: "desc" }, take: 10, select: { id: true, shopifyOrderId: true, shopifyOrderName: true, netProfit: true, marginPercent: true, heldReason: true, totalPrice: true, currency: true } }),
    db.productVariant.findMany({ where: { product: { shop }, effectiveCost: null }, select: { id: true } }),
    db.shopSettings.findUnique({ where: { shop } }),
    db.expense?.findMany({ where: { shop, isActive: true } }).catch(() => []),
    db.order.count({ where: { shop } }),
    db.orderLineItem.findMany({ where: { order: { shop, shopifyCreatedAt: { gte: since, lte: until } } }, select: { productTitle: true, price: true, quantity: true, cogs: true } }),
  ]);
  const alertMarginThreshold = settings?.alertMarginThreshold ?? 10;
  const monthlyExpenses = (expenses ?? []).reduce((s: number, e: { amount: number; interval: string }) => s + toMonthly(e.amount, e.interval), 0);
  const totalRevenue = ordersInRange.reduce((s, o) => s + o.totalPrice, 0);
  const totalNetProfit = ordersInRange.reduce((s, o) => s + o.netProfit, 0) - monthlyExpenses;
  const totalCogs = ordersInRange.reduce((s, o) => s + o.cogs, 0);
  const totalAdSpend = ordersInRange.reduce((s, o) => s + (o.adSpendAllocated ?? 0), 0);
  const totalShipping = ordersInRange.reduce((s, o) => s + o.shippingCost, 0);
  const totalFees = ordersInRange.reduce((s, o) => s + o.transactionFee, 0);
  const avgMargin = ordersInRange.length > 0 ? ordersInRange.reduce((s, o) => s + o.marginPercent, 0) / ordersInRange.length : 0;
  const unitsSold = lineItemsInRange.reduce((s, i) => s + i.quantity, 0);
  const avgOrderValue = ordersInRange.length > 0 ? totalRevenue / ordersInRange.length : 0;
  const avgOrderProfit = ordersInRange.length > 0 ? totalNetProfit / ordersInRange.length : 0;
  const prevRevenue = ordersPrev._sum.totalPrice ?? 0;
  const prevProfit = (ordersPrev._sum.netProfit ?? 0) - monthlyExpenses;
  const prevMargin = ordersPrev._avg.marginPercent ?? 0;
  const prevCount = ordersPrev._count.id ?? 0;
  const revenueAllocation: RevenueAllocation = { revenue: totalRevenue, cogs: totalCogs, adSpend: totalAdSpend, shipping: totalShipping, fees: totalFees, expenses: monthlyExpenses, profit: Math.max(0, totalNetProfit) };
  const productMap = new Map<string, { profit: number; unitsSold: number }>();
  for (const item of lineItemsInRange) {
    const key = item.productTitle || "Unknown product";
    const gross = item.price * item.quantity - item.cogs;
    const existing = productMap.get(key) ?? { profit: 0, unitsSold: 0 };
    productMap.set(key, { profit: existing.profit + gross, unitsSold: existing.unitsSold + item.quantity });
  }
  const allProducts: ProductStat[] = [...productMap.entries()].map(([title, v]) => ({ title, ...v }));
  const topProducts = [...allProducts].sort((a, b) => b.profit - a.profit).slice(0, 3);
  const leakProducts = [...allProducts].filter((p) => p.profit < 0).sort((a, b) => a.profit - b.profit).slice(0, 3);
  const lossOrders7d = orders7d.filter((o) => o.netProfit < 0);
  const lossAmount7d = lossOrders7d.reduce((s, o) => s + Math.abs(o.netProfit), 0);
  const maxSingleLoss = lossOrders7d.length > 0 ? Math.max(...lossOrders7d.map((o) => Math.abs(o.netProfit))) : 0;
  const avgMargin7d = orders7d.length > 0 ? orders7d.reduce((s, o) => s + o.marginPercent, 0) / orders7d.length : 0;
  const profit7d = orders7d.reduce((s, o) => s + o.netProfit, 0);
  const lossPercent7d = orders7d.length > 0 ? (lossOrders7d.length / orders7d.length) * 100 : 0;
  const lossOrderIds7d = lossOrders7d.map((o) => o.id).filter(Boolean);
  const lossLineItemsRaw = lossOrderIds7d.length > 0 ? await db.orderLineItem.findMany({ where: { orderId: { in: lossOrderIds7d } }, select: { orderId: true, cogs: true, price: true, quantity: true, shopifyVariantId: true, productTitle: true } }) : [];
  const lineItemsByOrder = new Map<string, Array<{ productId: string; productTitle: string; cogs: number; price: number; quantity: number }>>();
  for (const item of lossLineItemsRaw) {
    const productId = item.shopifyVariantId ?? item.productTitle;
    const existing = lineItemsByOrder.get(item.orderId) ?? [];
    existing.push({ productId, productTitle: item.productTitle, cogs: item.cogs, price: item.price, quantity: item.quantity });
    lineItemsByOrder.set(item.orderId, existing);
  }
  const lossBreakdown = analyzeLossReasons(lossOrders7d, lineItemsByOrder);
  const actionItems: ActionItem[] = [];
  if (lossOrders7d.length > 0 && lossBreakdown) {
    const { topSource, topSourcePercent, isDominant, topProduct } = lossBreakdown;
    const bigLossPenalty = maxSingleLoss > 200 ? 300 : maxSingleLoss > 100 ? 200 : maxSingleLoss > 50 ? 100 : 0;
    const score = Math.pow(lossAmount7d, 1.2) * 0.6 + lossOrders7d.length * 30 * 0.3 + 100 * 0.1 + bigLossPenalty;
    const sourceLabels: Record<string, string> = { ads: "Ad spend", cogs: "Product costs", shipping: "Shipping costs", fees: "Transaction fees", discounts: "Discounts" };
    const filterUrls: Record<string, string> = { ads: "/app/orders?profitability=loss&reason=ads", cogs: "/app/orders?profitability=loss&reason=cogs", shipping: "/app/orders?profitability=loss&reason=shipping", fees: "/app/orders?profitability=loss", discounts: "/app/orders?profitability=loss" };
    const typeMap: Record<string, LossReason> = { ads: "loss_due_to_ads", cogs: "loss_due_to_cogs", shipping: "loss_due_to_shipping", fees: "loss_due_to_fees", discounts: "loss_mixed" };
    const sourceAdvice: Record<string, string> = { ads: "Consider pausing high-spend campaigns or raising prices.", cogs: "Your product costs are too high relative to prices.", shipping: "Shipping costs exceed what your margins can absorb.", fees: "Payment processor fees are eroding thin margins.", discounts: "You're discounting too aggressively — margins can't absorb it." };
    const unheld = lossOrders7d.filter((o) => !o.isHeld).length;
    let title: string; let actionType: LossReason; let itemSeverity: "critical"|"warning" = "critical"; let itemTimeToFix = isDominant ? (topSource === "cogs" ? "10 min" : "5 min") : "10 min"; const itemActions: { label: string; url: string; primary?: boolean }[] = [];
    if (topProduct && topProduct.percentOfTotalLoss >= 40) {
      const costSourceNames: Record<string, string> = { ads: "ads", cogs: "product cost", shipping: "shipping", fees: "fees", discounts: "discounts" };
      title = topProduct.topCostSourcePercent >= 50 ? `"${topProduct.title}" is losing money mainly due to ${costSourceNames[topProduct.topCostSource]} (${topProduct.topCostSourcePercent}%)` : `"${topProduct.title}" caused ${topProduct.percentOfTotalLoss}% of your losses this week`;
      itemSeverity = topProduct.percentOfTotalLoss > 60 ? "critical" : "warning"; itemTimeToFix = "2 min";
      actionType = typeMap[topProduct.topCostSource] ?? "loss_due_to_ads";
      if (topProduct.topCostSource === "cogs") itemActions.push({ label: "Update cost price", url: `/app/cogs?search=${encodeURIComponent(topProduct.title)}`, primary: true }, { label: "View loss orders", url: filterUrls["cogs"] });
      else if (topProduct.topCostSource === "ads") itemActions.push({ label: "Review ad spend", url: filterUrls["ads"], primary: true }, { label: "Fix cost price", url: `/app/cogs?search=${encodeURIComponent(topProduct.title)}` });
      else if (topProduct.topCostSource === "shipping") itemActions.push({ label: "View shipping orders", url: filterUrls["shipping"], primary: true }, { label: "Fix cost price", url: `/app/cogs?search=${encodeURIComponent(topProduct.title)}` });
      else itemActions.push({ label: "Fix cost price", url: `/app/cogs?search=${encodeURIComponent(topProduct.title)}`, primary: true }, { label: "View loss orders", url: filterUrls[topProduct.topCostSource] ?? "/app/orders?profitability=loss" });
    } else if (isDominant) {
      title = `${sourceLabels[topSource]} caused ${topSourcePercent}% of your losses this week`; actionType = typeMap[topSource] ?? "loss_due_to_ads";
      itemActions.push({ label: "View affected orders", url: filterUrls[topSource], primary: true }, ...(!settings?.holdEnabled ? [{ label: "Enable auto-hold", url: "/app/settings" }] : []));
    } else {
      title = "Losses spread across multiple cost factors"; actionType = "loss_mixed";
      itemActions.push({ label: "View loss orders", url: "/app/orders?profitability=loss", primary: true }, { label: "Review cost prices", url: "/app/cogs" });
    }
    const cogsAdvice = topProduct?.topCostSource === "cogs" ? ` Update the cost price in ClearProfit or raise the selling price in Shopify to break even.` : "";
    const description = `${lossOrders7d.length} order${lossOrders7d.length > 1 ? "s" : ""} unprofitable${unheld > 0 ? ` · ${unheld} shipped without being held` : ""}. ${isDominant ? sourceAdvice[topSource] : "Review your pricing, COGS, and ad spend together."}${cogsAdvice}`;
    const potentialRecovery = topProduct ? topProduct.totalLoss : lossAmount7d;
    actionItems.push({ type: actionType, severity: itemSeverity, confidence: lossOrders7d.length >= 3 ? "high" : "medium", score, title, description, impact: `Total loss: ${fmtK(lossAmount7d)}${topProduct ? ` · "${topProduct.title}": ${fmtK(topProduct.totalLoss)}` : ""}`, potentialRecovery, timeToFix: itemTimeToFix, filterUrl: filterUrls[topSource] ?? "/app/orders?profitability=loss", actions: itemActions });
  }
  if (avgMargin7d > 0 && avgMargin7d < alertMarginThreshold && lossOrders7d.length === 0) {
    const gap = alertMarginThreshold - avgMargin7d; const score = Math.pow(gap * 20, 1.1) * 0.6 + orders7d.length * 5 * 0.3 + 50 * 0.1;
    actionItems.push({ type: "low_margin", severity: "warning", confidence: orders7d.length >= 5 ? "high" : "medium", score, title: `Margins are ${gap.toFixed(1)}% below target`, description: `Avg margin this week: ${avgMargin7d.toFixed(1)}% — target is ${alertMarginThreshold}%+. Check product pricing or COGS.`, impact: `${gap.toFixed(1)}% gap — every order underperforms`, potentialRecovery: null, timeToFix: "10 min", filterUrl: "/app/orders", actions: [{ label: "Fix cost prices", url: "/app/cogs", primary: true }, { label: "Check settings", url: "/app/settings" }] });
  }
  if (totalAdSpend > 0 && totalRevenue > 0 && totalAdSpend / totalRevenue > 0.4) {
    const excessSpend = totalAdSpend - totalRevenue * 0.3; const score = Math.pow(excessSpend, 1.1) * 0.6 + ordersInRange.length * 2 * 0.3 + 30 * 0.1;
    actionItems.push({ type: "loss_due_to_ads", severity: "warning", confidence: "high", score, title: "Ad spend is too high relative to revenue", description: `Ad spend is ${((totalAdSpend / totalRevenue) * 100).toFixed(0)}% of revenue — healthy is below 30%.`, impact: `Excess: ~${fmtK(excessSpend)}/month`, potentialRecovery: excessSpend, timeToFix: "5 min", filterUrl: "/app/orders?profitability=loss", actions: [{ label: "View ad breakdown", url: "/app/ads", primary: true }] });
  }
  if (monthlyExpenses > totalRevenue * 0.2) {
    const ratio = monthlyExpenses / Math.max(totalRevenue, 1); const score = Math.pow(ratio * 100, 1.05) * 5;
    actionItems.push({ type: "high_expenses", severity: "info", confidence: "high", score, title: `Fixed costs: ${fmtK(monthlyExpenses)}/month`, description: `Your fixed expenses are ${(ratio * 100).toFixed(0)}% of monthly revenue.`, impact: `${(ratio * 100).toFixed(0)}% of revenue`, potentialRecovery: null, timeToFix: "5 min", filterUrl: "/app/expenses", actions: [{ label: "Review expenses", url: "/app/expenses", primary: true }] });
  }
  if (missingCogsVariants.length > 0) {
    const cogsImpactCalc = ordersInRange.filter((o) => !o.cogsComplete).length * (totalRevenue / Math.max(ordersInRange.length, 1)) * 0.15;
    actionItems.push({ type: "loss_mixed" as LossReason, severity: "info", confidence: "low", score: missingCogsVariants.length * 10, title: `Data health: ${missingCogsVariants.length} products missing cost data`, description: `Orders with missing COGS show inflated margins and may not trigger holds correctly.`, impact: `Profit may be overstated by ~${fmtK(cogsImpactCalc)}`, potentialRecovery: null, timeToFix: "2 min", filterUrl: "/app/cogs", actions: [{ label: "Fix now", url: "/app/cogs", primary: true }] });
  }
  const prioritizedItems = actionItems.sort((a, b) => b.score - a.score).slice(0, 3);
  let acState: "critical"|"warning"|"healthy" = "healthy";
  if (prioritizedItems.some((i) => i.severity === "critical")) acState = "critical";
  else if (prioritizedItems.some((i) => i.severity === "warning")) acState = "warning";
  let heroInsight = `${fmtK(profit7d)} profit this week · Avg margin ${avgMargin7d.toFixed(1)}% · No action needed`;
  if (acState === "critical" && lossBreakdown) {
    const { topSource, topSourcePercent, isDominant, topProduct } = lossBreakdown;
    const sourceNames: Record<string, string> = { ads: "Facebook/Google ads", cogs: "product costs", shipping: "shipping costs", fees: "transaction fees", discounts: "discounts" };
    if (topProduct && topProduct.percentOfTotalLoss >= 40 && topProduct.topCostSourcePercent >= 50) heroInsight = `"${topProduct.title}" is losing money mainly due to ${sourceNames[topProduct.topCostSource]} — ${fmtK(topProduct.totalLoss)} lost this week`;
    else if (topProduct && topProduct.percentOfTotalLoss >= 40) heroInsight = `"${topProduct.title}" caused ${topProduct.percentOfTotalLoss}% of your losses — ${fmtK(lossAmount7d)} total this week`;
    else if (isDominant) heroInsight = `${sourceNames[topSource]} caused ${topSourcePercent}% of your losses — ${fmtK(lossAmount7d)} lost this week`;
    else if (lossPercent7d >= 30) heroInsight = `${lossPercent7d.toFixed(0)}% of orders lost money — losses spread across multiple cost factors`;
    else heroInsight = `${lossOrders7d.length} order${lossOrders7d.length > 1 ? "s" : ""} lost ${fmtK(lossAmount7d)} — costs split across multiple factors`;
  } else if (acState === "warning") {
    heroInsight = `Avg margin ${avgMargin7d.toFixed(1)}% — ${(alertMarginThreshold - avgMargin7d).toFixed(1)}% below your ${alertMarginThreshold}% target`;
  }
  const actionCenter: ActionCenterState = { state: acState, heroInsight, items: prioritizedItems, lossBreakdown, summary: { lossAmount: lossAmount7d, lossOrders: lossOrders7d.length, avgMargin: avgMargin7d, profit7d, lossPercent: lossPercent7d, maxSingleLoss } };
  const pctChange = (curr: number, prev: number) => prev === 0 ? null : ((curr - prev) / Math.abs(prev)) * 100;
  const trendDir = (n: number | null): "up"|"down"|"neutral" => n == null ? "neutral" : n >= 0 ? "up" : "down";
  const fmtPct = (n: number | null) => n == null ? "vs prev period" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}% vs prev period`;
  const profitPct = pctChange(totalNetProfit, prevProfit); const revenuePct = pctChange(totalRevenue, prevRevenue); const marginPct = pctChange(avgMargin, prevMargin); const ordersPct = pctChange(ordersInRange.length, prevCount);
  const kpiMetrics: KpiMetric[] = [
    { label: "Net Profit", value: fmtK(totalNetProfit), sub: fmtPct(profitPct), trend: trendDir(profitPct), trendPositive: (profitPct ?? 0) >= 0, highlighted: acState === "critical" && totalNetProfit < 0 },
    { label: "Revenue", value: fmtK(totalRevenue), sub: fmtPct(revenuePct), trend: trendDir(revenuePct), trendPositive: (revenuePct ?? 0) >= 0, highlighted: false },
    { label: "Avg Margin", value: avgMargin.toFixed(1) + "%", sub: fmtPct(marginPct), trend: trendDir(marginPct), trendPositive: (marginPct ?? 0) >= 0, highlighted: acState !== "healthy" && avgMargin < alertMarginThreshold },
    { label: "Orders", value: String(ordersInRange.length), sub: fmtPct(ordersPct), trend: trendDir(ordersPct), trendPositive: (ordersPct ?? 0) >= 0, highlighted: false },
    { label: "Ad Spend", value: fmtK(totalAdSpend), sub: totalRevenue > 0 ? `${((totalAdSpend / totalRevenue) * 100).toFixed(0)}% of revenue` : "No revenue", trend: "neutral", trendPositive: totalRevenue > 0 && totalAdSpend / totalRevenue < 0.4, highlighted: totalRevenue > 0 && totalAdSpend / totalRevenue > 0.4 },
    { label: "Fixed Expenses", value: fmtK(monthlyExpenses), sub: "per month", trend: "neutral", trendPositive: true, highlighted: monthlyExpenses > totalRevenue * 0.2 },
  ];
  const chartMap = new Map<string, { date: string; dateKey: string; profit: number; revenue: number; orderCount: number }>();
  let d = new Date(since);
  while (d <= until) {
    const dateStr = toDateStr(d);
    chartMap.set(dateStr, { date: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }), dateKey: dateStr, profit: 0, revenue: 0, orderCount: 0 });
    d = new Date(d.getTime() + 86400000);
  }
  for (const o of ordersInRange) { const dStr = o.shopifyCreatedAt.toISOString().split("T")[0]; const entry = chartMap.get(dStr); if (entry) { entry.profit += o.netProfit; entry.revenue += o.totalPrice; entry.orderCount += 1; } }
  const chartData: ChartPoint[] = Array.from(chartMap.values()).map((p) => ({ ...p, profit: parseFloat(p.profit.toFixed(2)), revenue: parseFloat(p.revenue.toFixed(2)), isLoss: p.profit < 0 }));
  const lossOrders30d = ordersInRange.filter((o) => o.netProfit < 0);
  const reasonCounts = new Map<string, number>();
  for (const o of lossOrders30d) { const reason = getTopCostReason(o); reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1); }
  const priorityOrders: PriorityOrder[] = [...ordersInRange].sort((a, b) => a.netProfit - b.netProfit).slice(0, 8).map((o) => {
    const topCostReason = getTopCostReason(o);
    return { id: o.id, shopifyOrderId: o.shopifyOrderId, shopifyOrderName: o.shopifyOrderName, netProfit: o.netProfit, marginPercent: o.marginPercent, isHeld: o.isHeld, cogsComplete: o.cogsComplete, financialStatus: o.financialStatus, currency: o.currency, topCostReason, repeatLossCount: reasonCounts.get(topCostReason) ?? 0 };
  });
  const heldSavedAmount = heldOrders.filter((o) => o.netProfit < 0).reduce((s, o) => s + Math.abs(o.netProfit), 0);
  const missingCogsCount = missingCogsVariants.length;
  const ordersWithMissingCogs = ordersInRange.filter((o) => !o.cogsComplete).length;
  const avgOrderRevenue = totalRevenue / Math.max(ordersInRange.length, 1);
  const missingCogsImpact = ordersWithMissingCogs * avgOrderRevenue * 0.15;
  let visibleCards: CardId[] = DEFAULT_CARDS;
  if (settings?.dashboardCards) { try { visibleCards = JSON.parse(settings.dashboardCards); } catch { visibleCards = DEFAULT_CARDS; } }
  return json({ actionCenter, kpiMetrics, extendedKpis: { unitsSold, avgOrderValue, avgOrderProfit, totalCogs, totalShipping, totalFees }, revenueAllocation, productLeaderboard: { top: topProducts, leaks: leakProducts }, chartData, priorityOrders, heldOrders: heldOrders.map((o) => ({ id: o.id, shopifyOrderName: o.shopifyOrderName, shopifyOrderId: o.shopifyOrderId, netProfit: o.netProfit, marginPercent: o.marginPercent, heldReason: o.heldReason, totalPrice: o.totalPrice, currency: o.currency })), heldSavedAmount, missingCogsCount, missingCogsImpact, visibleCards, hasOrders: totalOrderCount > 0, shop, dateFrom, dateTo });
};

// ── Action (unchanged) ────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  if (intent === "saveDashboardConfig") {
    const cards = formData.get("cards") as string;
    await db.shopSettings.upsert({ where: { shop: session.shop }, update: { dashboardCards: cards } as any, create: { shop: session.shop, dashboardCards: cards } as any });
    return json({ success: true });
  }
  if (intent === "releaseHold") {
    const orderId = formData.get("orderId") as string;
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) return json({ error: "Order not found" }, { status: 404 });
    const foResponse: any = await admin.graphql(`query getFulfillmentOrders($id: ID!) { order(id: $id) { fulfillmentOrders(first: 1) { nodes { id status } } } }`, { variables: { id: order.shopifyOrderId } });
    const fo = (await foResponse.json()).data?.order?.fulfillmentOrders?.nodes?.[0];
    if (fo) {
      const mutRes: any = await admin.graphql(`mutation releaseHold($id: ID!) { fulfillmentOrderReleaseHold(id: $id) { fulfillmentOrder { id status } userErrors { field message } } }`, { variables: { id: fo.id } });
      const errors = (await mutRes.json()).data?.fulfillmentOrderReleaseHold?.userErrors;
      if (errors?.length > 0) return json({ error: errors[0].message }, { status: 400 });
    }
    await db.order.update({ where: { id: orderId }, data: { isHeld: false, heldReason: null } });
    return json({ success: true });
  }
  return json({ error: "Unknown intent" }, { status: 400 });
};

// ── Dismiss hook ──────────────────────────────────────────────────────────────
const DISMISS_KEY = "cp_dismissed_actions";
const DISMISS_TTL = 24 * 60 * 60 * 1000;
function useDismissed() {
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    try { const raw = sessionStorage.getItem(DISMISS_KEY); if (!raw) return; const parsed: { type: string; at: number }[] = JSON.parse(raw); setDismissed(parsed.filter((d) => Date.now() - d.at < DISMISS_TTL).map((d) => d.type)); } catch {}
  }, []);
  const snooze24h = useCallback((type: string) => {
    setDismissed((prev) => {
      const next = [...prev, type];
      try { const raw = sessionStorage.getItem(DISMISS_KEY); const existing: { type: string; at: number }[] = raw ? JSON.parse(raw) : []; sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...existing.filter((d) => d.type !== type), { type, at: Date.now() }])); } catch {}
      return next;
    });
  }, []);
  return { dismissed, snooze24h };
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const tokens = {
  profit: "#16a34a", profitBg: "#f0fdf4", profitBorder: "#bbf7d0",
  loss: "#dc2626", lossBg: "#fef2f2", lossBorder: "#fecaca",
  warning: "#d97706", warningBg: "#fffbeb", warningBorder: "#fde68a",
  border: "#e2e8f0", cardBg: "#ffffff", pageBg: "#f8fafc",
  text: "#0f172a", textMuted: "#64748b",
};

function DCard({ children, onClick, style }: { children: React.ReactNode; onClick?: () => void; style?: React.CSSProperties }) {
  return (
    <div onClick={onClick} style={{ background: tokens.cardBg, border: `1px solid ${tokens.border}`, borderRadius: "12px", overflow: "hidden", cursor: onClick ? "pointer" : undefined, transition: onClick ? "box-shadow 0.15s, transform 0.15s" : undefined, ...style }}
      onMouseEnter={onClick ? (e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)"; (e.currentTarget as HTMLDivElement).style.transform = "translateY(-1px)"; } : undefined}
      onMouseLeave={onClick ? (e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = "none"; (e.currentTarget as HTMLDivElement).style.transform = "none"; } : undefined}
    >{children}</div>
  );
}
function DCardHeader({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) { return <div style={{ padding: "16px 20px", borderBottom: `1px solid ${tokens.border}`, ...style }}>{children}</div>; }
function DCardBody({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) { return <div style={{ padding: "16px 20px", ...style }}>{children}</div>; }
function DBadge({ children, variant = "default", size = "md" }: { children: React.ReactNode; variant?: "default"|"success"|"danger"|"warning"|"info"|"neutral"; size?: "sm"|"md" }) {
  const colors: Record<string, { bg: string; color: string; border: string }> = { default: { bg: "#f1f5f9", color: "#475569", border: "#e2e8f0" }, success: { bg: tokens.profitBg, color: tokens.profit, border: tokens.profitBorder }, danger: { bg: tokens.lossBg, color: tokens.loss, border: tokens.lossBorder }, warning: { bg: tokens.warningBg, color: tokens.warning, border: tokens.warningBorder }, info: { bg: "#eff6ff", color: "#2563eb", border: "#bfdbfe" }, neutral: { bg: "#f8fafc", color: tokens.textMuted, border: tokens.border } };
  const c = colors[variant];
  return <span style={{ display: "inline-flex", alignItems: "center", padding: size === "sm" ? "2px 8px" : "3px 10px", borderRadius: "100px", fontSize: size === "sm" ? "11px" : "12px", fontWeight: 600, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>{children}</span>;
}
function TrendArrow({ positive }: { positive: boolean }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: "2px", fontSize: "12px", fontWeight: 600, color: positive ? tokens.profit : tokens.loss }}>{positive ? "↑" : "↓"}</span>;
}
function DashboardSkeleton() {
  const shimmer: React.CSSProperties = { background: "linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 50%, #f1f5f9 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite", borderRadius: "8px" };
  return (<><style>{`@keyframes shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style><SkeletonPage title="Dashboard"><Layout><Layout.Section><div style={{ height: 80, ...shimmer }} /></Layout.Section><Layout.Section><div style={{ height: 120, ...shimmer }} /></Layout.Section><Layout.Section><div style={{ height: 80, ...shimmer }} /></Layout.Section><Layout.Section><div style={{ height: 300, ...shimmer }} /></Layout.Section></Layout></SkeletonPage></>);
}

// ── Action Center (dashboard variant — compact, max 3 items + hub link) ───────
const actionTypeIcons: Record<string, string> = {
  loss_due_to_ads: "📢", loss_due_to_cogs: "📦", loss_due_to_shipping: "🚚",
  loss_due_to_fees: "💳", loss_mixed: "⚖️", low_margin: "📉", high_expenses: "🏢",
};

function ActionCenter({ actionCenter }: { actionCenter: ActionCenterState }) {
  const navigate = useNavigate();
  const { state, items, lossBreakdown } = actionCenter;
  const { dismissed, snooze24h } = useDismissed();
  const visibleItems = items.filter((i) => !dismissed.includes(i.type));

  const stateConfig = {
    critical: { border: tokens.lossBorder, bg: tokens.lossBg, icon: "🔴", label: "Action required", labelColor: tokens.loss },
    warning:  { border: tokens.warningBorder, bg: tokens.warningBg, icon: "⚠️", label: "Attention needed", labelColor: tokens.warning },
    healthy:  { border: tokens.profitBorder, bg: tokens.profitBg, icon: "✅", label: "You're on track", labelColor: tokens.profit },
  }[state];

  // ── FIX 1: Header shows count summary, not duplicated item text ───────────
  const headerSubtitle = state !== "healthy"
    ? `${visibleItems.length} issue${visibleItems.length !== 1 ? "s" : ""} found — last 7 days`
    : actionCenter.heroInsight;

  return (
    <DCard style={{ border: `1px solid ${stateConfig.border}` }}>
      {/* Header */}
      <div style={{ background: stateConfig.bg, padding: "14px 20px", borderBottom: visibleItems.length > 0 ? `1px solid ${stateConfig.border}` : undefined }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1 }}>
            <span style={{ fontSize: "18px" }}>{stateConfig.icon}</span>
            <div>
              <p style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: tokens.text }}>{stateConfig.label}</p>
              {/* FIX 1 applied here */}
              <p style={{ margin: 0, fontSize: "13px", color: state === "healthy" ? tokens.textMuted : stateConfig.labelColor, marginTop: "2px" }}>
                {headerSubtitle}
              </p>
            </div>
          </div>
          {/* Loss breakdown mini-bar */}
          {lossBreakdown && state === "critical" && (
            <div style={{ flexShrink: 0 }}>
              <div style={{ display: "flex", gap: "2px", borderRadius: "4px", overflow: "hidden", height: "6px", width: "180px", marginBottom: "4px" }}>
                {[{ key: "ads", color: "#ef4444" }, { key: "cogs", color: "#f97316" }, { key: "shipping", color: "#eab308" }, { key: "fees", color: "#94a3b8" }].map(({ key, color }) => {
                  const val = lossBreakdown[key as keyof typeof lossBreakdown] as number;
                  const pct = lossBreakdown.total > 0 ? (val / lossBreakdown.total) * 100 : 0;
                  return pct > 1 ? <div key={key} style={{ width: `${pct}%`, background: color }} title={`${key}: ${pct.toFixed(0)}%`} /> : null;
                })}
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {[{ key: "ads", color: "#ef4444", label: "Ads" }, { key: "cogs", color: "#f97316", label: "COGS" }, { key: "shipping", color: "#eab308", label: "Ship." }, { key: "fees", color: "#94a3b8", label: "Fees" }].map(({ key, color, label }) => {
                  const val = lossBreakdown[key as keyof typeof lossBreakdown] as number;
                  const pct = lossBreakdown.total > 0 ? (val / lossBreakdown.total) * 100 : 0;
                  return pct > 1 ? (<span key={key} style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "11px", color: tokens.textMuted }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0 }} />{label} {pct.toFixed(0)}%</span>) : null;
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Action items */}
      {visibleItems.length > 0 && (
        <div>
          {visibleItems.map((item, i) => {
            const primaryAction = item.actions.find((a) => a.primary) ?? item.actions[0];
            const secondaryActions = item.actions.filter((a) => !a.primary);
            const typeIcon = actionTypeIcons[item.type] ?? "•";
            return (
              <div key={item.type} style={{ padding: "14px 20px", borderBottom: i < visibleItems.length - 1 ? `1px solid ${tokens.border}` : undefined, position: "relative" }}>
                {/* Dismiss */}
                <button onClick={() => snooze24h(item.type)} title="Dismiss for 24h"
                  style={{ position: "absolute", top: "10px", right: "14px", background: "none", border: "none", cursor: "pointer", fontSize: "18px", color: "#cbd5e1", lineHeight: 1, padding: "2px 4px", transition: "color 0.1s" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#94a3b8")} onMouseLeave={(e) => (e.currentTarget.style.color = "#cbd5e1")}
                >×</button>
                <div style={{ display: "flex", gap: "12px", alignItems: "flex-start", paddingRight: "24px" }}>
                  <div style={{ width: 32, height: 32, borderRadius: "8px", flexShrink: 0, background: item.severity === "critical" ? tokens.lossBg : item.severity === "warning" ? tokens.warningBg : "#eff6ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "15px" }}>{typeIcon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "14px", fontWeight: 600, color: tokens.text }}>{item.title}</span>
                      <DBadge variant={item.severity === "critical" ? "danger" : item.severity === "warning" ? "warning" : "info"} size="sm">{item.timeToFix}</DBadge>
                    </div>
                    <p style={{ margin: "0 0 8px", fontSize: "13px", color: tokens.textMuted, lineHeight: "1.5" }}>
                      {item.description}
                      {item.potentialRecovery != null && item.potentialRecovery > 0 && (
                        <span style={{ color: tokens.profit, fontWeight: 500 }}>{` Potential recovery: ~${fmtK(item.potentialRecovery)}/week.`}</span>
                      )}
                    </p>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      {primaryAction && (
                        <button onClick={() => navigate(primaryAction.url)}
                          style={{ padding: "6px 14px", borderRadius: "8px", background: "#0f172a", color: "#ffffff", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 600, transition: "background 0.15s" }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "#1e293b")} onMouseLeave={(e) => (e.currentTarget.style.background = "#0f172a")}
                        >{primaryAction.label}</button>
                      )}
                      {secondaryActions.map((a) => (
                        <button key={a.label} onClick={() => navigate(a.url)}
                          style={{ background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: tokens.textMuted, textDecoration: "underline", padding: 0, transition: "color 0.1s" }}
                          onMouseEnter={(e) => (e.currentTarget.style.color = tokens.text)} onMouseLeave={(e) => (e.currentTarget.style.color = tokens.textMuted)}
                        >{a.label}</button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {/* ── FIX 2: Footer link to hub ────────────────────────────────── */}
          <div style={{ padding: "10px 20px", borderTop: `1px solid ${tokens.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: "12px", color: tokens.textMuted }}>
              Showing top {visibleItems.length} issue{visibleItems.length !== 1 ? "s" : ""}
            </span>
            <button
              onClick={() => navigate("/app/actions")}
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: "#2563eb", fontWeight: 600, padding: 0 }}
              onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
              onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
            >
              View all in Action Center →
            </button>
          </div>
        </div>
      )}
    </DCard>
  );
}

// ── KPI strip ─────────────────────────────────────────────────────────────────
function KpiStrip({ metrics, extended }: { metrics: KpiMetric[]; extended: ExtendedKpis }) {
  const navigate = useNavigate();
  const [showExtended, setShowExtended] = useState(false);
  const kpiUrls: Record<string, string> = { "Net Profit": "/app/orders?profitability=loss", "Revenue": "/app/orders", "Avg Margin": "/app/orders?profitability=all", "Orders": "/app/orders", "Ad Spend": "/app/ads", "Fixed Expenses": "/app/expenses" };
  const extraMetrics = [
    { label: "Units Sold", value: String(extended.unitsSold), sub: "in period", critical: false },
    { label: "Avg Order Value", value: fmtCurrency(extended.avgOrderValue), sub: "per order", critical: false },
    { label: "Avg Order Profit", value: fmtCurrency(extended.avgOrderProfit), sub: "per order", critical: extended.avgOrderProfit < 0 },
    { label: "Total COGS", value: fmtCurrency(extended.totalCogs), sub: "cost of goods", critical: false },
    { label: "Shipping Costs", value: fmtCurrency(extended.totalShipping), sub: "carrier costs", critical: false },
    { label: "Transaction Fees", value: fmtCurrency(extended.totalFees), sub: "payment fees", critical: false },
  ];
  return (
    <DCard>
      <div style={{ display: "flex", overflowX: "auto" }}>
        {metrics.map((m, i) => {
          const url = kpiUrls[m.label];
          return (
            <div key={m.label} onClick={url ? () => navigate(url) : undefined}
              style={{ flex: "1 1 0", minWidth: "140px", padding: "18px 20px", borderRight: i < metrics.length - 1 ? `1px solid ${tokens.border}` : undefined, background: m.highlighted ? "#fffbeb" : tokens.cardBg, cursor: url ? "pointer" : "default", transition: "background 0.15s" }}
              onMouseEnter={url ? (e) => ((e.currentTarget as HTMLDivElement).style.background = "#f8fafc") : undefined}
              onMouseLeave={url ? (e) => ((e.currentTarget as HTMLDivElement).style.background = m.highlighted ? "#fffbeb" : tokens.cardBg) : undefined}
            >
              <div style={{ marginBottom: "4px", display: "flex", alignItems: "center", gap: "4px" }}>
                <span style={{ fontSize: "12px", fontWeight: 500, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{m.label}</span>
                {m.highlighted && <span style={{ fontSize: "10px" }}>⚠️</span>}
                {url && <span style={{ fontSize: "10px", color: "#cbd5e1", marginLeft: "auto" }}>→</span>}
              </div>
              <p style={{ margin: "0 0 4px", fontSize: "24px", fontWeight: 700, color: !m.trendPositive && m.trend !== "neutral" ? tokens.loss : tokens.text, letterSpacing: "-0.02em" }}>{m.value}</p>
              <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                {m.trend !== "neutral" && <TrendArrow positive={m.trendPositive} />}
                <span style={{ fontSize: "12px", color: tokens.textMuted }}>{m.sub}</span>
              </div>
            </div>
          );
        })}
      </div>
      {showExtended && (
        <div style={{ borderTop: `1px solid ${tokens.border}`, display: "flex", overflowX: "auto", background: "#f8fafc" }}>
          {extraMetrics.map((m, i) => (
            <div key={m.label} style={{ flex: "1 1 0", minWidth: "130px", padding: "14px 20px", borderRight: i < extraMetrics.length - 1 ? `1px solid ${tokens.border}` : undefined }}>
              <p style={{ margin: "0 0 4px", fontSize: "11px", fontWeight: 500, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{m.label}</p>
              <p style={{ margin: "0 0 2px", fontSize: "18px", fontWeight: 700, color: m.critical ? tokens.loss : tokens.text, letterSpacing: "-0.01em" }}>{m.value}</p>
              <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>{m.sub}</p>
            </div>
          ))}
        </div>
      )}
      <button onClick={() => setShowExtended(v => !v)} style={{ width: "100%", padding: "10px 20px", background: "none", border: "none", borderTop: `1px solid ${tokens.border}`, cursor: "pointer", textAlign: "left", fontSize: "13px", color: tokens.textMuted, fontWeight: 500, display: "flex", alignItems: "center", gap: "6px", transition: "color 0.1s" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = tokens.text)} onMouseLeave={(e) => (e.currentTarget.style.color = tokens.textMuted)}
      >
        <span>{showExtended ? "▲" : "▼"}</span>{showExtended ? "Hide extended metrics" : "View extended metrics"}
      </button>
    </DCard>
  );
}

// ── Revenue allocation bar ────────────────────────────────────────────────────
function RevenueAllocationBar({ allocation }: { allocation: RevenueAllocation }) {
  const { revenue, cogs, adSpend, shipping, fees, expenses, profit } = allocation;
  if (revenue === 0) return null;
  const pct = (n: number) => Math.max(0, (n / revenue) * 100);
  const segments = [
    { label: "COGS", value: cogs, color: "#f97316", pct: pct(cogs) }, { label: "Ad Spend", value: adSpend, color: "#a855f7", pct: pct(adSpend) },
    { label: "Shipping", value: shipping, color: "#3b82f6", pct: pct(shipping) }, { label: "Fees", value: fees, color: "#94a3b8", pct: pct(fees) },
    { label: "Expenses", value: expenses, color: "#ef4444", pct: pct(expenses) }, { label: "Cash in Pocket", value: profit, color: "#16a34a", pct: pct(profit) },
  ].filter((s) => s.pct > 0.5);
  return (
    <DCard><DCardBody>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
        <p style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: tokens.text }}>Revenue Allocation</p>
        <span style={{ fontSize: "13px", color: tokens.textMuted }}>Total: {fmtCurrency(revenue)}</span>
      </div>
      <div style={{ height: "20px", borderRadius: "6px", overflow: "hidden", display: "flex", gap: "2px", marginBottom: "12px" }}>
        {segments.map((s) => <div key={s.label} style={{ width: `${s.pct}%`, background: s.color, transition: "width 0.3s" }} title={`${s.label}: ${s.pct.toFixed(1)}% (${fmtCurrency(s.value)})`} />)}
      </div>
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
        {segments.map((s) => (<div key={s.label} style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: s.color, flexShrink: 0, display: "inline-block" }} /><span style={{ fontSize: "12px", color: tokens.textMuted }}>{s.label}</span><span style={{ fontSize: "12px", fontWeight: 600, color: tokens.text }}>{s.pct.toFixed(1)}%</span></div>))}
      </div>
    </DCardBody></DCard>
  );
}

// ── Product leaderboard ───────────────────────────────────────────────────────
function ProductLeaderboard({ top, leaks }: { top: ProductStat[]; leaks: ProductStat[] }) {
  const navigate = useNavigate();
  if (top.length === 0 && leaks.length === 0) return null;
  return (
    <DCard>
      <DCardHeader>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <p style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: tokens.text }}>Performance Leaderboard</p>
          <span style={{ fontSize: "12px", color: tokens.textMuted }}>Gross contribution · last period</span>
        </div>
      </DCardHeader>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1px 1fr" }}>
        <div style={{ padding: "16px 20px" }}>
          <p style={{ margin: "0 0 12px", fontSize: "11px", fontWeight: 700, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>🏆 Top Performing</p>
          {top.length === 0 ? <p style={{ margin: 0, fontSize: "13px", color: tokens.textMuted }}>No data yet</p> : top.map((p, i) => (
            <div key={p.title} onClick={() => navigate(`/app/orders?profitability=all&search=${encodeURIComponent(p.title)}`)}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px", borderRadius: "8px", marginBottom: "4px", cursor: "pointer", transition: "background 0.1s" }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.background = "#f8fafc")} onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.background = "transparent")}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                <span style={{ width: 22, height: 22, borderRadius: "50%", flexShrink: 0, background: tokens.profitBg, border: `1px solid ${tokens.profitBorder}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: 700, color: tokens.profit }}>{i + 1}</span>
                <span style={{ fontSize: "13px", color: tokens.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
              </div>
              <span style={{ fontSize: "13px", fontWeight: 700, color: tokens.profit, flexShrink: 0, marginLeft: "8px" }}>+{fmtCurrency(p.profit)}</span>
            </div>
          ))}
        </div>
        <div style={{ background: tokens.border }} />
        <div style={{ padding: "16px 20px" }}>
          <p style={{ margin: "0 0 12px", fontSize: "11px", fontWeight: 700, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>⚠️ Profit Leaks</p>
          {leaks.length === 0 ? <p style={{ margin: 0, fontSize: "13px", color: tokens.profit }}>No loss-making products 🎉</p> : leaks.map((p) => (
            <div key={p.title} onClick={() => navigate(`/app/orders?profitability=loss&search=${encodeURIComponent(p.title)}`)}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px", borderRadius: "8px", marginBottom: "4px", cursor: "pointer", transition: "background 0.1s" }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.background = "#fef2f2")} onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.background = "transparent")}
            >
              <span style={{ fontSize: "13px", color: tokens.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
              <span style={{ fontSize: "13px", fontWeight: 700, color: tokens.loss, flexShrink: 0, marginLeft: "8px" }}>{fmtCurrency(p.profit)}</span>
            </div>
          ))}
        </div>
      </div>
    </DCard>
  );
}

// ── Chart ─────────────────────────────────────────────────────────────────────
function ChartTooltipCustom({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const profit = payload.find((p: any) => p.name === "profit")?.value ?? 0;
  const revenue = payload.find((p: any) => p.name === "revenue")?.value ?? 0;
  return (
    <div style={{ background: "#fff", border: `1px solid ${tokens.border}`, borderRadius: "10px", padding: "12px 16px", fontSize: "13px", boxShadow: "0 4px 16px rgba(0,0,0,0.1)" }}>
      <p style={{ margin: "0 0 8px", fontWeight: 700, color: tokens.text }}>{label}</p>
      <p style={{ margin: "0 0 3px", color: profit < 0 ? tokens.loss : tokens.profit }}>Profit: <strong>{fmtCurrency(profit)}</strong></p>
      <p style={{ margin: 0, color: tokens.textMuted }}>Revenue: {fmtCurrency(revenue)}</p>
      {profit < 0 && <p style={{ margin: "6px 0 0", fontSize: "11px", color: tokens.loss, fontWeight: 600 }}>📉 Click to view loss orders</p>}
    </div>
  );
}
function ProfitChart({ chartData }: { chartData: ChartPoint[] }) {
  const navigate = useNavigate();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const lossDays = chartData.filter((d) => d.isLoss);
  if (!mounted) return <div style={{ height: "300px", background: "#f8fafc", borderRadius: "12px" }} />;
  return (
    <DCard>
      <DCardHeader>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div><p style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: tokens.text }}>Profit Stability</p><p style={{ margin: "2px 0 0", fontSize: "12px", color: tokens.textMuted }}>Click red dots to drill into loss days</p></div>
          {lossDays.length > 0 && <DBadge variant="danger">{`${lossDays.length} loss day${lossDays.length > 1 ? "s" : ""}`}</DBadge>}
        </div>
      </DCardHeader>
      <DCardBody>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={chartData} margin={{ top: 8, right: 20, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: tokens.textMuted }} interval={Math.max(1, Math.floor(chartData.length / 8))} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: tokens.textMuted }} tickFormatter={(v) => "$" + v} axisLine={false} tickLine={false} />
            <Tooltip content={<ChartTooltipCustom />} />
            <Line type="monotone" dataKey="revenue" stroke="#e2e8f0" strokeWidth={2} dot={false} strokeDasharray="4 4" name="revenue" />
            <Line type="monotone" dataKey="profit" stroke={tokens.profit} strokeWidth={2.5} dot={false} activeDot={{ r: 5, fill: tokens.profit }} name="profit" />
            <ReferenceLine y={0} stroke={tokens.loss} strokeDasharray="5 3" strokeWidth={1} label={{ value: "Break even", position: "right", fontSize: 10, fill: tokens.loss }} />
            {lossDays.map((d) => (<ReferenceDot key={d.dateKey} x={d.date} y={d.profit} r={6} fill={tokens.loss} stroke="white" strokeWidth={2} style={{ cursor: "pointer" }} onClick={() => navigate(`/app/orders?from=${d.dateKey}&to=${d.dateKey}&profitability=loss`)} />))}
          </LineChart>
        </ResponsiveContainer>
        <div style={{ display: "flex", gap: "20px", justifyContent: "center", marginTop: "12px" }}>
          {[{ color: tokens.profit, label: "Net Profit", circle: false }, { color: "#e2e8f0", label: "Revenue", circle: false }, { color: tokens.loss, label: "Loss day", circle: true }].map((l) => (
            <div key={l.label} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {l.circle ? <span style={{ width: 8, height: 8, borderRadius: "50%", background: l.color, display: "inline-block" }} /> : <span style={{ width: 16, height: 2, background: l.color, display: "inline-block", borderRadius: 2 }} />}
              <span style={{ fontSize: "12px", color: tokens.textMuted }}>{l.label}</span>
            </div>
          ))}
        </div>
      </DCardBody>
    </DCard>
  );
}

// ── Priority Orders ───────────────────────────────────────────────────────────
function PriorityOrders({ orders, shop }: { orders: PriorityOrder[]; shop: string }) {
  const navigate = useNavigate();
  const needsAttention = orders.filter((o) => o.netProfit < 0 || o.marginPercent < 10 || o.isHeld || o.cogsComplete === false);
  return (
    <DCard>
      <DCardHeader>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div><p style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: tokens.text }}>Needs Attention</p><p style={{ margin: "2px 0 0", fontSize: "12px", color: tokens.textMuted }}>Worst orders first</p></div>
          {needsAttention.length > 0 && <DBadge variant="danger">{`${needsAttention.length} orders`}</DBadge>}
        </div>
      </DCardHeader>
      {orders.length === 0 ? (
        <DCardBody><p style={{ margin: 0, fontSize: "13px", color: tokens.textMuted }}>No orders yet.</p></DCardBody>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 70px 80px 80px", padding: "8px 16px", background: "#f8fafc", borderBottom: `1px solid ${tokens.border}` }}>
            {["Order", "Net Profit", "Margin", "Top Cost", "Action"].map((h) => (<span key={h} style={{ fontSize: "11px", fontWeight: 700, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</span>))}
          </div>
          {needsAttention.map((o) => (
            <div key={o.id} style={{ display: "grid", gridTemplateColumns: "1fr 90px 70px 80px 80px", padding: "10px 16px", borderBottom: `1px solid ${tokens.border}`, background: o.netProfit < 0 ? "#fef2f2" : o.cogsComplete === false ? "#fffbeb" : "#ffffff", transition: "background 0.1s", alignItems: "center" }}
              onMouseEnter={(e) => { if (o.netProfit >= 0 && o.cogsComplete !== false) (e.currentTarget as HTMLDivElement).style.background = "#f8fafc"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = o.netProfit < 0 ? "#fef2f2" : o.cogsComplete === false ? "#fffbeb" : "#ffffff"; }}
            >
              <a href={getShopifyOrderUrl(shop, o.shopifyOrderId)} target="_blank" rel="noopener noreferrer" style={{ fontSize: "13px", fontWeight: 600, color: "#2563eb", textDecoration: "none", display: "flex", alignItems: "center", gap: "4px" }}
                onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")} onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
              >{o.shopifyOrderName}<span style={{ fontSize: "10px", color: "#94a3b8" }}>↗</span></a>
              <span style={{ fontSize: "13px", fontWeight: 700, color: o.netProfit < 0 ? tokens.loss : tokens.profit }}>{fmtCurrency(o.netProfit, o.currency)}</span>
              <DBadge variant={o.marginPercent < 0 ? "danger" : o.marginPercent < 10 ? "warning" : "success"} size="sm">{o.cogsComplete ? `${o.marginPercent.toFixed(1)}%` : "?%"}</DBadge>
              <span style={{ fontSize: "12px", color: tokens.textMuted }}>{o.topCostReason}</span>
              {o.isHeld ? <DBadge variant="warning" size="sm">On Hold</DBadge> : <a href={getShopifyOrderUrl(shop, o.shopifyOrderId)} target="_blank" rel="noopener noreferrer" style={{ fontSize: "12px", color: "#2563eb", textDecoration: "none", fontWeight: 500 }}>Review ↗</a>}
            </div>
          ))}
          <div style={{ padding: "10px 16px" }}>
            <button onClick={() => navigate("/app/orders?profitability=loss")} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: "#2563eb", fontWeight: 500, padding: 0, textDecoration: "underline" }}>View all loss orders →</button>
          </div>
        </>
      )}
    </DCard>
  );
}

// ── Held Orders ───────────────────────────────────────────────────────────────
function HeldOrdersCard({ heldOrders, heldSavedAmount, onRelease, isSubmitting }: { heldOrders: HeldOrder[]; heldSavedAmount: number; onRelease: (id: string) => void; isSubmitting: boolean }) {
  return (
    <DCard>
      <DCardHeader>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <p style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: tokens.text }}>Held Orders</p>
            {heldSavedAmount > 0 ? <p style={{ margin: "2px 0 0", fontSize: "12px", color: tokens.profit, fontWeight: 500 }}>🛡 Saved ~{fmtCurrency(heldSavedAmount)}</p> : <p style={{ margin: "2px 0 0", fontSize: "12px", color: tokens.textMuted }}>Auto-hold active</p>}
          </div>
          {heldOrders.length > 0 && <DBadge variant="warning">{String(heldOrders.length)}</DBadge>}
        </div>
      </DCardHeader>
      {heldOrders.length === 0 ? (
        <DCardBody><p style={{ margin: 0, fontSize: "13px", color: tokens.textMuted }}>No orders on hold right now.</p></DCardBody>
      ) : (
        heldOrders.map((order) => (
          <div key={order.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: `1px solid ${tokens.border}` }}>
            <div>
              <p style={{ margin: 0, fontSize: "14px", fontWeight: 600, color: tokens.text }}>{order.shopifyOrderName}</p>
              <p style={{ margin: "2px 0 0", fontSize: "12px", color: tokens.textMuted }}>{order.heldReason ?? "Held for review"}</p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <DBadge variant={order.marginPercent < 0 ? "danger" : "warning"}>{order.marginPercent.toFixed(1)}%</DBadge>
              <button onClick={() => onRelease(order.id)} disabled={isSubmitting}
                style={{ padding: "6px 14px", borderRadius: "8px", background: tokens.text, color: "#fff", border: "none", cursor: "pointer", fontSize: "12px", fontWeight: 600, opacity: isSubmitting ? 0.6 : 1, transition: "background 0.15s" }}
                onMouseEnter={(e) => { if (!isSubmitting) (e.currentTarget.style.background = "#1e293b"); }} onMouseLeave={(e) => (e.currentTarget.style.background = tokens.text)}
              >Release</button>
            </div>
          </div>
        ))
      )}
    </DCard>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { actionCenter, kpiMetrics, extendedKpis, revenueAllocation, productLeaderboard, chartData, priorityOrders, heldOrders, heldSavedAmount, missingCogsCount, missingCogsImpact, visibleCards: initialVisibleCards, hasOrders, shop, dateFrom, dateTo } = useLoaderData() as LoaderData;
  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isLoading = navigation.state === "loading";
  const isSubmitting = navigation.state === "submitting";

  useEffect(() => {
    const hasDateParam = searchParams.has("from") || searchParams.has("to");
    if (!hasDateParam) {
      const saved = loadFromStorage();
      if (saved && (saved.from !== dateFrom || saved.to !== dateTo)) {
        const next = new URLSearchParams(searchParams);
        next.set("from", saved.from); next.set("to", saved.to);
        setSearchParams(next, { replace: true });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [visibleCards, setVisibleCards] = useState<CardId[]>(initialVisibleCards);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [draftCards, setDraftCards] = useState<CardId[]>(initialVisibleCards);

  if (isLoading) return <DashboardSkeleton />;

  if (!hasOrders) {
    return (
      <Page title="Dashboard">
        <Layout>
          <Layout.Section>
            <DCard>
              <EmptyState heading="ClearProfit is ready to go" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png" action={{ content: "Set up product costs", url: "/app/products" }} secondaryAction={{ content: "Configure settings", url: "/app/settings" }}>
                <p>Your first order will be calculated the moment it comes in.</p>
              </EmptyState>
            </DCard>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const isVisible = (id: CardId) => visibleCards.includes(id);
  const handleSaveConfig = () => {
    const newCards = ALL_CARDS.map((c) => c.id).filter((id) => draftCards.includes(id)) as CardId[];
    setVisibleCards(newCards);
    submit({ intent: "saveDashboardConfig", cards: JSON.stringify(newCards) }, { method: "POST" });
    setCustomizeOpen(false);
  };
  const handleDateUpdate = (from: string, to: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("from", from); next.set("to", to);
    setSearchParams(next);
  };
  const gap = "16px";

  return (
    <Page title="Dashboard" primaryAction={{ content: "Customize", onAction: () => { setDraftCards([...visibleCards]); setCustomizeOpen(true); } }}>
      <div style={{ display: "flex", flexDirection: "column", gap }}>
        <DateRangePicker dateFrom={dateFrom} dateTo={dateTo} onUpdate={handleDateUpdate} />
        {isVisible("action_center") && <ActionCenter actionCenter={actionCenter} />}
        {isVisible("kpi_strip") && <KpiStrip metrics={kpiMetrics} extended={extendedKpis} />}
        {isVisible("revenue_allocation") && <RevenueAllocationBar allocation={revenueAllocation} />}
        {isVisible("product_leaderboard") && <ProductLeaderboard top={productLeaderboard.top} leaks={productLeaderboard.leaks} />}
        {isVisible("chart") && <ProfitChart chartData={chartData} />}
        {(isVisible("priority_orders") || isVisible("held_orders")) && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))", gap }}>
            {isVisible("priority_orders") && <PriorityOrders orders={priorityOrders} shop={shop} />}
            {isVisible("held_orders") && <HeldOrdersCard heldOrders={heldOrders} heldSavedAmount={heldSavedAmount} onRelease={(id) => submit({ intent: "releaseHold", orderId: id }, { method: "POST" })} isSubmitting={isSubmitting} />}
          </div>
        )}
      </div>

      <Modal open={customizeOpen} onClose={() => setCustomizeOpen(false)} title="Customize dashboard" primaryAction={{ content: "Save", onAction: handleSaveConfig }} secondaryActions={[{ content: "Cancel", onAction: () => setCustomizeOpen(false) }]}>
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" tone="subdued">Choose which sections to show.</Text>
            {ALL_CARDS.map((card) => (
              <Checkbox key={card.id} label={card.label} checked={draftCards.includes(card.id)}
                onChange={(checked) => setDraftCards((prev) => checked ? [...prev, card.id] : prev.filter((c) => c !== card.id))}
              />
            ))}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
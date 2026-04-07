import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useNavigate, useSearchParams } from "react-router";
import { useState, useEffect, useCallback } from "react";
import {
  Page, Layout, Card, Text, Badge, Box, BlockStack, InlineStack,
  Button, Banner, ResourceList, ResourceItem, EmptyState, Modal,
  Checkbox, DataTable, SkeletonPage, SkeletonBodyText, SkeletonDisplayText, InlineGrid,
  TextField,
} from "@shopify/polaris";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceDot, ReferenceLine,
} from "recharts";
import { authenticate } from "../shopify.server";
import { DateRangePicker, loadFromStorage } from "../components/DateRangePicker";
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
type LossReason =
  | "loss_due_to_ads"
  | "loss_due_to_cogs"
  | "loss_due_to_shipping"
  | "loss_due_to_fees"
  | "loss_mixed"
  | "low_margin"
  | "high_expenses";

type Confidence = "high" | "medium" | "low";

interface ActionItem {
  type: LossReason;
  severity: "critical" | "warning" | "info";
  confidence: Confidence;
  score: number;
  title: string;
  description: string;
  impact: string;
  potentialRecovery: number | null;
  timeToFix: string;
  filterUrl: string;
  actions: { label: string; url: string; primary?: boolean }[];
}

interface TopLossProduct {
  productId: string;
  title: string;
  totalLoss: number;
  percentOfTotalLoss: number;
  topCostSource: "ads" | "cogs" | "shipping" | "fees";
  topCostSourcePercent: number;
}

interface LossBreakdown {
  ads: number;
  cogs: number;
  shipping: number;
  fees: number;
  discounts: number;
  total: number;
  topSource: "ads" | "cogs" | "shipping" | "fees" | "discounts";
  topSourcePercent: number;
  topSourceAmount: number;
  isDominant: boolean;
  topProduct: TopLossProduct | null;
}

interface ActionCenterState {
  state: "critical" | "warning" | "healthy";
  heroInsight: string;
  items: ActionItem[];
  lossBreakdown: LossBreakdown | null;
  summary: {
    lossAmount: number;
    lossOrders: number;
    avgMargin: number;
    profit7d: number;
    lossPercent: number;
    maxSingleLoss: number;
  };
}

interface KpiMetric {
  label: string;
  value: string;
  sub: string;
  trend: "up" | "down" | "neutral";
  trendPositive: boolean;
  highlighted: boolean;
}

interface ChartPoint {
  date: string;
  dateKey: string;
  profit: number;
  revenue: number;
  orderCount: number;
  isLoss: boolean;
}

interface PriorityOrder {
  id: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  netProfit: number;
  marginPercent: number;
  isHeld: boolean;
  cogsComplete: boolean;
  financialStatus: string | null;
  currency: string;
  topCostReason: string;
  repeatLossCount: number;
}

interface HeldOrder {
  id: string;
  shopifyOrderName: string;
  shopifyOrderId: string;
  netProfit: number;
  marginPercent: number;
  heldReason: string | null;
  totalPrice: number;
  currency: string;
}

// New: revenue allocation
interface RevenueAllocation {
  revenue: number;
  cogs: number;
  adSpend: number;
  shipping: number;
  fees: number;
  expenses: number;
  profit: number;
}

// New: product leaderboard entry
interface ProductStat {
  title: string;
  profit: number;
  unitsSold: number;
}

// New: extended KPIs
interface ExtendedKpis {
  unitsSold: number;
  avgOrderValue: number;
  avgOrderProfit: number;
  totalCogs: number;
  totalShipping: number;
  totalFees: number;
}

interface LoaderData {
  actionCenter: ActionCenterState;
  kpiMetrics: KpiMetric[];
  extendedKpis: ExtendedKpis;
  revenueAllocation: RevenueAllocation;
  productLeaderboard: { top: ProductStat[]; leaks: ProductStat[] };
  chartData: ChartPoint[];
  priorityOrders: PriorityOrder[];
  heldOrders: HeldOrder[];
  heldSavedAmount: number;
  missingCogsCount: number;
  missingCogsImpact: number;
  visibleCards: CardId[];
  hasOrders: boolean;
  shop: string;
  dateFrom: string;
  dateTo: string;
}

// ── Server helpers ────────────────────────────────────────────────────────────
function toDateStr(d: Date) { return d.toISOString().split("T")[0]; }

function fmtCurrency(amount: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency, minimumFractionDigits: 2,
  }).format(amount);
}
function fmtK(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(n);
}
function getShopifyOrderUrl(shop: string, shopifyOrderId: string) {
  return `https://${shop}/admin/orders/${shopifyOrderId.replace("gid://shopify/Order/", "")}`;
}
function getTopCostReason(o: {
  adSpendAllocated: number; cogs: number; shippingCost: number; transactionFee: number;
}): string {
  return [
    { label: "Ads", value: o.adSpendAllocated ?? 0 },
    { label: "COGS", value: o.cogs ?? 0 },
    { label: "Shipping", value: o.shippingCost ?? 0 },
    { label: "Fees", value: o.transactionFee ?? 0 },
  ].reduce((max, c) => c.value > max.value ? c : max).label;
}

// ── Root cause analysis ───────────────────────────────────────────────────────
function analyzeLossReasons(
  orders: Array<{
    id: string;
    netProfit: number;
    adSpendAllocated: number;
    cogs: number;
    shippingCost: number;
    transactionFee: number;
    totalDiscounts: number;
  }>,
  lineItemsByOrder: Map<string, Array<{
    productId: string;
    productTitle: string;
    cogs: number;
    price: number;
    quantity: number;
  }>>
): LossBreakdown | null {
  const lossOrders = orders.filter((o) => o.netProfit < 0);
  if (lossOrders.length === 0) return null;

  const breakdown = { ads: 0, cogs: 0, shipping: 0, fees: 0, discounts: 0 };

  for (const o of lossOrders) {
    const totalCosts =
      (o.adSpendAllocated ?? 0) + (o.cogs ?? 0) +
      (o.shippingCost ?? 0) + (o.transactionFee ?? 0) +
      (o.totalDiscounts ?? 0);
    if (totalCosts === 0) continue;
    const lossShare = Math.abs(o.netProfit) / totalCosts;
    breakdown.ads += (o.adSpendAllocated ?? 0) * lossShare;
    breakdown.cogs += (o.cogs ?? 0) * lossShare;
    breakdown.shipping += (o.shippingCost ?? 0) * lossShare;
    breakdown.fees += (o.transactionFee ?? 0) * lossShare;
    breakdown.discounts += (o.totalDiscounts ?? 0) * lossShare;
  }

  const total = breakdown.ads + breakdown.cogs + breakdown.shipping + breakdown.fees + breakdown.discounts;
  if (total === 0) return null;

  const entries = Object.entries(breakdown) as [keyof typeof breakdown, number][];
  const [topSource, topSourceAmount] = entries.reduce((max, cur) => cur[1] > max[1] ? cur : max);
  const topSourcePercent = Math.round((topSourceAmount / total) * 100);
  const isDominant = topSourcePercent > 50;

  const productLossMap = new Map<string, {
    title: string;
    loss: number;
    costBreakdown: { ads: number; cogs: number; shipping: number; fees: number };
  }>();

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
      const itemCostBreakdown = {
        ads: adsPerUnit * item.quantity,
        cogs: item.cogs,
        shipping: shippingPerUnit * item.quantity,
        fees: feesPerUnit * item.quantity,
      };
      if (existing) {
        existing.loss += itemProfit;
        existing.costBreakdown.ads += itemCostBreakdown.ads;
        existing.costBreakdown.cogs += itemCostBreakdown.cogs;
        existing.costBreakdown.shipping += itemCostBreakdown.shipping;
        existing.costBreakdown.fees += itemCostBreakdown.fees;
      } else {
        productLossMap.set(item.productId, {
          title: item.productTitle,
          loss: itemProfit,
          costBreakdown: itemCostBreakdown,
        });
      }
    }
  }

  const lossProducts = [...productLossMap.entries()]
    .filter(([, v]) => v.loss < 0)
    .sort((a, b) => a[1].loss - b[1].loss);
  const totalProductLoss = lossProducts.reduce((s, [, v]) => s + Math.abs(v.loss), 0);
  let topProduct: TopLossProduct | null = null;

  if (lossProducts.length > 0) {
    const [pid, pdata] = lossProducts[0];
    const productLossAmount = Math.abs(pdata.loss);
    const pct = totalProductLoss > 0 ? Math.round((productLossAmount / totalProductLoss) * 100) : 0;
    const pBreakdown = pdata.costBreakdown;
    const pEntries = Object.entries(pBreakdown) as ["ads" | "cogs" | "shipping" | "fees", number][];
    const pTotal = pEntries.reduce((s, [, v]) => s + v, 0);
    const [pTopSource] = pEntries.reduce((max, cur) => cur[1] > max[1] ? cur : max);
    const pTopPct = pTotal > 0 ? Math.round((pBreakdown[pTopSource] / pTotal) * 100) : 0;
    topProduct = {
      productId: pid, title: pdata.title, totalLoss: productLossAmount,
      percentOfTotalLoss: pct, topCostSource: pTopSource, topCostSourcePercent: pTopPct,
    };
  }

  return { ...breakdown, total, topSource, topSourcePercent, topSourceAmount, isDominant, topProduct };
}

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const url = new URL(request.url);
  const now = new Date();

  // Redirect to onboarding if not yet completed.
  // ?from=onboarding bypasses the check (used when opening COGS from onboarding).
  const bypassOnboarding = url.searchParams.get("from") === "onboarding";
  if (!bypassOnboarding) {
    const onboardingCheck = await db.shopSettings.findUnique({
      where: { shop },
      select: { onboardingComplete: true },
    });
    if (!onboardingCheck?.onboardingComplete) {
      return redirect("/app/onboarding");
    }
  }

  // Date range — "from" param also used as bypass flag so treat "onboarding" as default
  const defaultTo = toDateStr(now);
  const defaultFrom = toDateStr(new Date(now.getTime() - 30 * 86400000));
  const rawFrom = url.searchParams.get("from");
  const dateFrom = (rawFrom && rawFrom !== "onboarding") ? rawFrom : defaultFrom;
  const dateTo = url.searchParams.get("to") || defaultTo;
  const since = new Date(dateFrom + "T00:00:00.000Z");
  const until = new Date(dateTo + "T23:59:59.999Z");

  // Prev period (same length, immediately before)
  const periodMs = until.getTime() - since.getTime();
  const prevSince = new Date(since.getTime() - periodMs);
  const prevUntil = new Date(since.getTime() - 1);

  // Action Center always uses last 7 days (fixed — shows current issues)
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

  const [
    ordersInRange, ordersPrev, orders7d, heldOrders,
    missingCogsVariants, settings, expenses, totalOrderCount,
    lineItemsInRange,
  ] = await Promise.all([
    db.order.findMany({
      where: { shop, shopifyCreatedAt: { gte: since, lte: until } },
      select: {
        id: true, shopifyOrderId: true, shopifyOrderName: true,
        totalPrice: true, netProfit: true, marginPercent: true,
        isHeld: true, cogsComplete: true, financialStatus: true,
        currency: true, shopifyCreatedAt: true,
        cogs: true, transactionFee: true, shippingCost: true, adSpendAllocated: true,
      },
    }),
    db.order.aggregate({
      where: { shop, shopifyCreatedAt: { gte: prevSince, lte: prevUntil } },
      _sum: { totalPrice: true, netProfit: true },
      _avg: { marginPercent: true },
      _count: { id: true },
    }),
    db.order.findMany({
      where: { shop, shopifyCreatedAt: { gte: sevenDaysAgo } },
      select: {
        id: true, netProfit: true, marginPercent: true, isHeld: true,
        adSpendAllocated: true, cogs: true, shippingCost: true,
        transactionFee: true, totalPrice: true, totalDiscounts: true,
      },
    }),
    db.order.findMany({
      where: { shop, isHeld: true },
      orderBy: { shopifyCreatedAt: "desc" },
      take: 10,
      select: {
        id: true, shopifyOrderId: true, shopifyOrderName: true,
        netProfit: true, marginPercent: true, heldReason: true,
        totalPrice: true, currency: true,
      },
    }),
    db.productVariant.findMany({
      where: { product: { shop }, effectiveCost: null },
      select: { id: true },
    }),
    db.shopSettings.findUnique({ where: { shop } }),
    db.expense?.findMany({ where: { shop, isActive: true } }).catch(() => []),
    db.order.count({ where: { shop } }),
    // New: line items for product leaderboard
    db.orderLineItem.findMany({
      where: { order: { shop, shopifyCreatedAt: { gte: since, lte: until } } },
      select: {
        productTitle: true,
        price: true, quantity: true, cogs: true,
      },
    }),
  ]);

  const alertMarginThreshold = settings?.alertMarginThreshold ?? 10;

  const monthlyExpenses = (expenses ?? []).reduce(
    (s: number, e: { amount: number; interval: string }) => s + toMonthly(e.amount, e.interval), 0
  );

  // ── Core metrics ──────────────────────────────────────────────────────────
  const totalRevenue = ordersInRange.reduce((s, o) => s + o.totalPrice, 0);
  const totalNetProfit = ordersInRange.reduce((s, o) => s + o.netProfit, 0) - monthlyExpenses;
  const totalCogs = ordersInRange.reduce((s, o) => s + o.cogs, 0);
  const totalAdSpend = ordersInRange.reduce((s, o) => s + (o.adSpendAllocated ?? 0), 0);
  const totalShipping = ordersInRange.reduce((s, o) => s + o.shippingCost, 0);
  const totalFees = ordersInRange.reduce((s, o) => s + o.transactionFee, 0);
  const avgMargin = ordersInRange.length > 0
    ? ordersInRange.reduce((s, o) => s + o.marginPercent, 0) / ordersInRange.length : 0;

  // Extended KPIs
  const unitsSold = lineItemsInRange.reduce((s, i) => s + i.quantity, 0);
  const avgOrderValue = ordersInRange.length > 0 ? totalRevenue / ordersInRange.length : 0;
  const avgOrderProfit = ordersInRange.length > 0 ? totalNetProfit / ordersInRange.length : 0;

  // Previous period
  const prevRevenue = ordersPrev._sum.totalPrice ?? 0;
  const prevProfit = (ordersPrev._sum.netProfit ?? 0) - monthlyExpenses;
  const prevMargin = ordersPrev._avg.marginPercent ?? 0;
  const prevCount = ordersPrev._count.id ?? 0;

  // ── Revenue allocation ────────────────────────────────────────────────────
  const revenueAllocation: RevenueAllocation = {
    revenue: totalRevenue,
    cogs: totalCogs,
    adSpend: totalAdSpend,
    shipping: totalShipping,
    fees: totalFees,
    expenses: monthlyExpenses,
    profit: Math.max(0, totalNetProfit), // only show positive profit in bar
  };

  // ── Product leaderboard ───────────────────────────────────────────────────
  // Aggregate line items by product title (gross contribution: revenue - cogs)
  const productMap = new Map<string, { profit: number; unitsSold: number }>();
  for (const item of lineItemsInRange) {
    const key = item.productTitle || "Unknown product";
    const gross = item.price * item.quantity - item.cogs;
    const existing = productMap.get(key) ?? { profit: 0, unitsSold: 0 };
    productMap.set(key, {
      profit: existing.profit + gross,
      unitsSold: existing.unitsSold + item.quantity,
    });
  }
  const allProducts: ProductStat[] = [...productMap.entries()].map(([title, v]) => ({
    title, ...v,
  }));
  const topProducts = [...allProducts].sort((a, b) => b.profit - a.profit).slice(0, 3);
  const leakProducts = [...allProducts]
    .filter((p) => p.profit < 0)
    .sort((a, b) => a.profit - b.profit)
    .slice(0, 3);

  // ── 7-day analysis for Action Center (always fixed) ───────────────────────
  const lossOrders7d = orders7d.filter((o) => o.netProfit < 0);
  const lossAmount7d = lossOrders7d.reduce((s, o) => s + Math.abs(o.netProfit), 0);
  const maxSingleLoss = lossOrders7d.length > 0
    ? Math.max(...lossOrders7d.map((o) => Math.abs(o.netProfit))) : 0;
  const avgMargin7d = orders7d.length > 0
    ? orders7d.reduce((s, o) => s + o.marginPercent, 0) / orders7d.length : 0;
  const profit7d = orders7d.reduce((s, o) => s + o.netProfit, 0);
  const lossPercent7d = orders7d.length > 0
    ? (lossOrders7d.length / orders7d.length) * 100 : 0;

  const lossOrderIds7d = lossOrders7d.map((o) => o.id).filter(Boolean);
  const lossLineItemsRaw = lossOrderIds7d.length > 0
    ? await db.orderLineItem.findMany({
        where: { orderId: { in: lossOrderIds7d } },
        select: {
          orderId: true, cogs: true, price: true, quantity: true,
          shopifyVariantId: true, productTitle: true,
        },
      })
    : [];

  const lineItemsByOrder = new Map<string, Array<{
    productId: string; productTitle: string;
    cogs: number; price: number; quantity: number;
  }>>();
  for (const item of lossLineItemsRaw) {
    const productId = item.shopifyVariantId ?? item.productTitle;
    const existing = lineItemsByOrder.get(item.orderId) ?? [];
    existing.push({
      productId, productTitle: item.productTitle,
      cogs: item.cogs, price: item.price, quantity: item.quantity,
    });
    lineItemsByOrder.set(item.orderId, existing);
  }

  const lossBreakdown = analyzeLossReasons(lossOrders7d, lineItemsByOrder);

  // ── Scoring engine ────────────────────────────────────────────────────────
  const actionItems: ActionItem[] = [];

  if (lossOrders7d.length > 0 && lossBreakdown) {
    const { topSource, topSourcePercent, isDominant, topProduct } = lossBreakdown;
    const bigLossPenalty = maxSingleLoss > 200 ? 300 : maxSingleLoss > 100 ? 200 : maxSingleLoss > 50 ? 100 : 0;
    const score = Math.pow(lossAmount7d, 1.2) * 0.6 + lossOrders7d.length * 30 * 0.3 + 100 * 0.1 + bigLossPenalty;

    const sourceLabels: Record<string, string> = {
      ads: "Ad spend", cogs: "Product costs", shipping: "Shipping costs",
      fees: "Transaction fees", discounts: "Discounts",
    };
    const filterUrls: Record<string, string> = {
      ads: "/app/orders?profitability=loss&reason=ads",
      cogs: "/app/orders?profitability=loss&reason=cogs",
      shipping: "/app/orders?profitability=loss&reason=shipping",
      fees: "/app/orders?profitability=loss",
      discounts: "/app/orders?profitability=loss",
    };
    const typeMap: Record<string, LossReason> = {
      ads: "loss_due_to_ads", cogs: "loss_due_to_cogs",
      shipping: "loss_due_to_shipping", fees: "loss_due_to_fees",
      discounts: "loss_mixed",
    };
    const sourceAdvice: Record<string, string> = {
      ads: "Consider pausing high-spend campaigns or raising prices.",
      cogs: "Your product costs are too high relative to prices.",
      shipping: "Shipping costs exceed what your margins can absorb.",
      fees: "Payment processor fees are eroding thin margins.",
      discounts: "You're discounting too aggressively — margins can't absorb it.",
    };

    const unheld = lossOrders7d.filter((o) => !o.isHeld).length;
    let title: string;
    let actionType: LossReason;
    let itemSeverity: "critical" | "warning" = "critical";
    let itemTimeToFix = isDominant ? (topSource === "cogs" ? "10 min" : "5 min") : "10 min";
    const itemActions: { label: string; url: string; primary?: boolean }[] = [];

    if (topProduct && topProduct.percentOfTotalLoss >= 40) {
      const costSourceNames: Record<string, string> = {
        ads: "ads", cogs: "product cost", shipping: "shipping",
        fees: "fees", discounts: "discounts",
      };
      title = topProduct.topCostSourcePercent >= 50
        ? `"${topProduct.title}" is losing money mainly due to ${costSourceNames[topProduct.topCostSource]} (${topProduct.topCostSourcePercent}%)`
        : `"${topProduct.title}" caused ${topProduct.percentOfTotalLoss}% of your losses this week`;
      itemSeverity = topProduct.percentOfTotalLoss > 60 ? "critical" : "warning";
      itemTimeToFix = "2 min";
      actionType = typeMap[topProduct.topCostSource] ?? "loss_due_to_ads";
      if (topProduct.topCostSource === "cogs") {
        itemActions.push(
          { label: "Update cost price", url: `/app/products?search=${encodeURIComponent(topProduct.title)}`, primary: true },
          { label: "View loss orders", url: filterUrls["cogs"] },
        );
      } else if (topProduct.topCostSource === "ads") {
        itemActions.push(
          { label: "Review ad spend", url: filterUrls["ads"], primary: true },
          { label: "View product", url: `/app/products?search=${encodeURIComponent(topProduct.title)}` },
        );
      } else if (topProduct.topCostSource === "shipping") {
        itemActions.push(
          { label: "View shipping orders", url: filterUrls["shipping"], primary: true },
          { label: "View product", url: `/app/products?search=${encodeURIComponent(topProduct.title)}` },
        );
      } else {
        itemActions.push(
          { label: "View product", url: `/app/products?search=${encodeURIComponent(topProduct.title)}`, primary: true },
          { label: "View loss orders", url: filterUrls[topProduct.topCostSource] ?? "/app/orders?profitability=loss" },
        );
      }
    } else if (isDominant) {
      title = `${sourceLabels[topSource]} caused ${topSourcePercent}% of your losses this week`;
      actionType = typeMap[topSource] ?? "loss_due_to_ads";
      itemActions.push(
        { label: "View affected orders", url: filterUrls[topSource], primary: true },
        ...(!settings?.holdEnabled ? [{ label: "Enable auto-hold", url: "/app/settings" }] : []),
      );
    } else {
      title = "Losses spread across multiple cost factors";
      actionType = "loss_mixed";
      itemActions.push(
        { label: "View loss orders", url: "/app/orders?profitability=loss", primary: true },
        { label: "Review products", url: "/app/products" },
      );
    }

    const cogsAdvice = topProduct?.topCostSource === "cogs"
      ? ` Update the cost price in ClearProfit or raise the selling price in Shopify to break even.` : "";
    const description = `${lossOrders7d.length} order${lossOrders7d.length > 1 ? "s" : ""} unprofitable${unheld > 0 ? ` · ${unheld} shipped without being held` : ""}. ${isDominant ? sourceAdvice[topSource] : "Review your pricing, COGS, and ad spend together."}${cogsAdvice}`;
    const potentialRecovery = topProduct ? topProduct.totalLoss : lossAmount7d;

    actionItems.push({
      type: actionType, severity: itemSeverity,
      confidence: lossOrders7d.length >= 3 ? "high" : "medium",
      score, title, description,
      impact: `Total loss: ${fmtK(lossAmount7d)}${topProduct ? ` · "${topProduct.title}": ${fmtK(topProduct.totalLoss)}` : ""}`,
      potentialRecovery, timeToFix: itemTimeToFix,
      filterUrl: filterUrls[topSource] ?? "/app/orders?profitability=loss",
      actions: itemActions,
    });
  }

  if (avgMargin7d > 0 && avgMargin7d < alertMarginThreshold && lossOrders7d.length === 0) {
    const gap = alertMarginThreshold - avgMargin7d;
    const score = Math.pow(gap * 20, 1.1) * 0.6 + orders7d.length * 5 * 0.3 + 50 * 0.1;
    actionItems.push({
      type: "low_margin", severity: "warning",
      confidence: orders7d.length >= 5 ? "high" : "medium", score,
      title: `Margins are ${gap.toFixed(1)}% below target`,
      description: `Avg margin this week: ${avgMargin7d.toFixed(1)}% — target is ${alertMarginThreshold}%+. Check product pricing or COGS.`,
      impact: `${gap.toFixed(1)}% gap — every order underperforms`,
      potentialRecovery: null, timeToFix: "10 min", filterUrl: "/app/orders",
      actions: [
        { label: "View products", url: "/app/products", primary: true },
        { label: "Check settings", url: "/app/settings" },
      ],
    });
  }

  if (totalAdSpend > 0 && totalRevenue > 0 && totalAdSpend / totalRevenue > 0.4) {
    const excessSpend = totalAdSpend - totalRevenue * 0.3;
    const score = Math.pow(excessSpend, 1.1) * 0.6 + ordersInRange.length * 2 * 0.3 + 30 * 0.1;
    actionItems.push({
      type: "loss_due_to_ads", severity: "warning", confidence: "high", score,
      title: "Ad spend is too high relative to revenue",
      description: `Ad spend is ${((totalAdSpend / totalRevenue) * 100).toFixed(0)}% of revenue — healthy is below 30%.`,
      impact: `Excess: ~${fmtK(excessSpend)}/month`,
      potentialRecovery: excessSpend, timeToFix: "5 min",
      filterUrl: "/app/orders?profitability=loss",
      actions: [{ label: "View ad breakdown", url: "/app/orders", primary: true }],
    });
  }

  if (monthlyExpenses > totalRevenue * 0.2) {
    const ratio = monthlyExpenses / Math.max(totalRevenue, 1);
    const score = Math.pow(ratio * 100, 1.05) * 5;
    actionItems.push({
      type: "high_expenses", severity: "info", confidence: "high", score,
      title: `Fixed costs: ${fmtK(monthlyExpenses)}/month`,
      description: `Your fixed expenses are ${(ratio * 100).toFixed(0)}% of monthly revenue.`,
      impact: `${(ratio * 100).toFixed(0)}% of revenue`,
      potentialRecovery: null, timeToFix: "5 min", filterUrl: "/app/expenses",
      actions: [{ label: "Review expenses", url: "/app/expenses", primary: true }],
    });
  }

  if (missingCogsVariants.length > 0) {
    const cogsImpactCalc = ordersInRange.filter((o) => !o.cogsComplete).length *
      (totalRevenue / Math.max(ordersInRange.length, 1)) * 0.15;
    actionItems.push({
      type: "loss_mixed" as LossReason, severity: "info", confidence: "low",
      score: missingCogsVariants.length * 10,
      title: `Data health: ${missingCogsVariants.length} products missing cost data`,
      description: `Orders with missing COGS show inflated margins and may not trigger holds correctly.`,
      impact: `Profit may be overstated by ~${fmtK(cogsImpactCalc)}`,
      potentialRecovery: null, timeToFix: "2 min",
      filterUrl: "/app/products?filter=missing",
      actions: [{ label: "Fix now", url: "/app/products?filter=missing", primary: true }],
    });
  }

  const prioritizedItems = actionItems.sort((a, b) => b.score - a.score).slice(0, 3);

  let acState: "critical" | "warning" | "healthy" = "healthy";
  if (prioritizedItems.some((i) => i.severity === "critical")) acState = "critical";
  else if (prioritizedItems.some((i) => i.severity === "warning")) acState = "warning";

  let heroInsight = `${fmtK(profit7d)} profit this week · Avg margin ${avgMargin7d.toFixed(1)}% · No action needed`;

  if (acState === "critical" && lossBreakdown) {
    const { topSource, topSourcePercent, isDominant, topProduct } = lossBreakdown;
    const sourceNames: Record<string, string> = {
      ads: "Facebook/Google ads", cogs: "product costs",
      shipping: "shipping costs", fees: "transaction fees", discounts: "discounts",
    };
    if (topProduct && topProduct.percentOfTotalLoss >= 40 && topProduct.topCostSourcePercent >= 50) {
      heroInsight = `"${topProduct.title}" is losing money mainly due to ${sourceNames[topProduct.topCostSource]} — ${fmtK(topProduct.totalLoss)} lost this week`;
    } else if (topProduct && topProduct.percentOfTotalLoss >= 40) {
      heroInsight = `"${topProduct.title}" caused ${topProduct.percentOfTotalLoss}% of your losses — ${fmtK(lossAmount7d)} total this week`;
    } else if (isDominant) {
      heroInsight = `${sourceNames[topSource]} caused ${topSourcePercent}% of your losses — ${fmtK(lossAmount7d)} lost this week`;
    } else if (lossPercent7d >= 30) {
      heroInsight = `${lossPercent7d.toFixed(0)}% of orders lost money — losses spread across multiple cost factors`;
    } else {
      heroInsight = `${lossOrders7d.length} order${lossOrders7d.length > 1 ? "s" : ""} lost ${fmtK(lossAmount7d)} — costs split across multiple factors`;
    }
  } else if (acState === "warning") {
    heroInsight = `Avg margin ${avgMargin7d.toFixed(1)}% — ${(alertMarginThreshold - avgMargin7d).toFixed(1)}% below your ${alertMarginThreshold}% target`;
  }

  const actionCenter: ActionCenterState = {
    state: acState, heroInsight, items: prioritizedItems, lossBreakdown,
    summary: {
      lossAmount: lossAmount7d, lossOrders: lossOrders7d.length,
      avgMargin: avgMargin7d, profit7d, lossPercent: lossPercent7d, maxSingleLoss,
    },
  };

  // ── KPI metrics ───────────────────────────────────────────────────────────
  const pctChange = (curr: number, prev: number) =>
    prev === 0 ? null : ((curr - prev) / Math.abs(prev)) * 100;
  const trendDir = (n: number | null): "up" | "down" | "neutral" =>
    n == null ? "neutral" : n >= 0 ? "up" : "down";
  const fmtPct = (n: number | null) =>
    n == null ? "vs prev period" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}% vs prev period`;

  const profitPct = pctChange(totalNetProfit, prevProfit);
  const revenuePct = pctChange(totalRevenue, prevRevenue);
  const marginPct = pctChange(avgMargin, prevMargin);
  const ordersPct = pctChange(ordersInRange.length, prevCount);

  const kpiMetrics: KpiMetric[] = [
    { label: "Net Profit", value: fmtK(totalNetProfit), sub: fmtPct(profitPct), trend: trendDir(profitPct), trendPositive: (profitPct ?? 0) >= 0, highlighted: acState === "critical" && totalNetProfit < 0 },
    { label: "Revenue", value: fmtK(totalRevenue), sub: fmtPct(revenuePct), trend: trendDir(revenuePct), trendPositive: (revenuePct ?? 0) >= 0, highlighted: false },
    { label: "Avg Margin", value: avgMargin.toFixed(1) + "%", sub: fmtPct(marginPct), trend: trendDir(marginPct), trendPositive: (marginPct ?? 0) >= 0, highlighted: acState !== "healthy" && avgMargin < alertMarginThreshold },
    { label: "Orders", value: String(ordersInRange.length), sub: fmtPct(ordersPct), trend: trendDir(ordersPct), trendPositive: (ordersPct ?? 0) >= 0, highlighted: false },
    { label: "Ad Spend", value: fmtK(totalAdSpend), sub: totalRevenue > 0 ? `${((totalAdSpend / totalRevenue) * 100).toFixed(0)}% of revenue` : "No revenue", trend: "neutral", trendPositive: totalRevenue > 0 && totalAdSpend / totalRevenue < 0.4, highlighted: totalRevenue > 0 && totalAdSpend / totalRevenue > 0.4 },
    { label: "Fixed Expenses", value: fmtK(monthlyExpenses), sub: "per month", trend: "neutral", trendPositive: true, highlighted: monthlyExpenses > totalRevenue * 0.2 },
  ];

  // ── Chart data ────────────────────────────────────────────────────────────
  const chartMap = new Map<string, { date: string; dateKey: string; profit: number; revenue: number; orderCount: number }>();
  let d = new Date(since);
  while (d <= until) {
    const dateStr = toDateStr(d);
    chartMap.set(dateStr, {
      date: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
      dateKey: dateStr, profit: 0, revenue: 0, orderCount: 0,
    });
    d = new Date(d.getTime() + 86400000);
  }
  for (const o of ordersInRange) {
    const dStr = o.shopifyCreatedAt.toISOString().split("T")[0];
    const entry = chartMap.get(dStr);
    if (entry) { entry.profit += o.netProfit; entry.revenue += o.totalPrice; entry.orderCount += 1; }
  }
  const chartData: ChartPoint[] = Array.from(chartMap.values()).map((p) => ({
    ...p,
    profit: parseFloat(p.profit.toFixed(2)),
    revenue: parseFloat(p.revenue.toFixed(2)),
    isLoss: p.profit < 0,
  }));

  // ── Priority orders ───────────────────────────────────────────────────────
  const lossOrders30d = ordersInRange.filter((o) => o.netProfit < 0);
  const reasonCounts = new Map<string, number>();
  for (const o of lossOrders30d) {
    const reason = getTopCostReason(o);
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const priorityOrders: PriorityOrder[] = [...ordersInRange]
    .sort((a, b) => a.netProfit - b.netProfit)
    .slice(0, 8)
    .map((o) => {
      const topCostReason = getTopCostReason(o);
      return {
        id: o.id, shopifyOrderId: o.shopifyOrderId, shopifyOrderName: o.shopifyOrderName,
        netProfit: o.netProfit, marginPercent: o.marginPercent, isHeld: o.isHeld,
        cogsComplete: o.cogsComplete, financialStatus: o.financialStatus, currency: o.currency,
        topCostReason, repeatLossCount: reasonCounts.get(topCostReason) ?? 0,
      };
    });

  const heldSavedAmount = heldOrders
    .filter((o) => o.netProfit < 0)
    .reduce((s, o) => s + Math.abs(o.netProfit), 0);

  const missingCogsCount = missingCogsVariants.length;
  const ordersWithMissingCogs = ordersInRange.filter((o) => !o.cogsComplete).length;
  const avgOrderRevenue = totalRevenue / Math.max(ordersInRange.length, 1);
  const missingCogsImpact = ordersWithMissingCogs * avgOrderRevenue * 0.15;

  let visibleCards: CardId[] = DEFAULT_CARDS;
  if (settings?.dashboardCards) {
    try { visibleCards = JSON.parse(settings.dashboardCards); } catch { visibleCards = DEFAULT_CARDS; }
  }

  return json({
    actionCenter, kpiMetrics,
    extendedKpis: { unitsSold, avgOrderValue, avgOrderProfit, totalCogs, totalShipping, totalFees },
    revenueAllocation, productLeaderboard: { top: topProducts, leaks: leakProducts },
    chartData, priorityOrders,
    heldOrders: heldOrders.map((o) => ({
      id: o.id, shopifyOrderName: o.shopifyOrderName, shopifyOrderId: o.shopifyOrderId,
      netProfit: o.netProfit, marginPercent: o.marginPercent, heldReason: o.heldReason,
      totalPrice: o.totalPrice, currency: o.currency,
    })),
    heldSavedAmount, missingCogsCount, missingCogsImpact, visibleCards,
    hasOrders: totalOrderCount > 0, shop, dateFrom, dateTo,
  });
};

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "saveDashboardConfig") {
    const cards = formData.get("cards") as string;
    await db.shopSettings.upsert({
      where: { shop: session.shop },
      update: { dashboardCards: cards } as any,
      create: { shop: session.shop, dashboardCards: cards } as any,
    });
    return json({ success: true });
  }

  if (intent === "releaseHold") {
    const orderId = formData.get("orderId") as string;
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) return json({ error: "Order not found" }, { status: 404 });
    const foResponse: any = await admin.graphql(
      `#graphql query getFulfillmentOrders($id: ID!) { order(id: $id) { fulfillmentOrders(first: 1) { nodes { id status } } } }`,
      { variables: { id: order.shopifyOrderId } }
    );
    const fo = (await foResponse.json()).data?.order?.fulfillmentOrders?.nodes?.[0];
    if (fo) {
      const mutRes: any = await admin.graphql(
        `#graphql mutation releaseHold($id: ID!) { fulfillmentOrderReleaseHold(id: $id) { fulfillmentOrder { id status } userErrors { field message } } }`,
        { variables: { id: fo.id } }
      );
      const errors = (await mutRes.json()).data?.fulfillmentOrderReleaseHold?.userErrors;
      if (errors?.length > 0) return json({ error: errors[0].message }, { status: 400 });
    }
    await db.order.update({ where: { id: orderId }, data: { isHeld: false, heldReason: null } });
    return json({ success: true });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

// ── Hooks ─────────────────────────────────────────────────────────────────────
const DISMISS_KEY = "cp_dismissed_actions";
const DISMISS_TTL = 24 * 60 * 60 * 1000;

function useDismissed() {
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DISMISS_KEY);
      if (!raw) return;
      const parsed: { type: string; at: number }[] = JSON.parse(raw);
      setDismissed(parsed.filter((d) => Date.now() - d.at < DISMISS_TTL).map((d) => d.type));
    } catch {}
  }, []);
  const snooze24h = useCallback((type: string) => {
    setDismissed((prev) => {
      const next = [...prev, type];
      try {
        const raw = sessionStorage.getItem(DISMISS_KEY);
        const existing: { type: string; at: number }[] = raw ? JSON.parse(raw) : [];
        sessionStorage.setItem(DISMISS_KEY, JSON.stringify([
          ...existing.filter((d) => d.type !== type),
          { type, at: Date.now() },
        ]));
      } catch {}
      return next;
    });
  }, []);
  return { dismissed, snooze24h };
}

// ── Components ────────────────────────────────────────────────────────────────
function DashboardSkeleton() {
  return (
    <SkeletonPage title="Dashboard">
      <Layout>
        <Layout.Section><Card><BlockStack gap="400"><SkeletonDisplayText size="small" /><SkeletonBodyText lines={3} /></BlockStack></Card></Layout.Section>
        <Layout.Section><Card><SkeletonBodyText lines={2} /></Card></Layout.Section>
        <Layout.Section><Card><SkeletonBodyText lines={8} /></Card></Layout.Section>
      </Layout>
    </SkeletonPage>
  );
}

const confidenceConfig: Record<Confidence, { text: string; color: string }> = {
  high: { text: "High confidence", color: "#008060" },
  medium: { text: "Medium confidence", color: "#b54708" },
  low: { text: "Low confidence — some data missing", color: "#6b7280" },
};

const actionTypeIcons: Record<string, string> = {
  loss_due_to_ads: "📢", loss_due_to_cogs: "📦", loss_due_to_shipping: "🚚",
  loss_due_to_fees: "💳", loss_mixed: "⚖️", low_margin: "📉", high_expenses: "🏢",
};

// ── Revenue allocation bar ────────────────────────────────────────────────────
function RevenueAllocationBar({ allocation }: { allocation: RevenueAllocation }) {
  const { revenue, cogs, adSpend, shipping, fees, expenses, profit } = allocation;
  if (revenue === 0) return null;

  const pct = (n: number) => Math.max(0, (n / revenue) * 100);
  const segments = [
    { label: "COGS", value: cogs, color: "#f97316", pct: pct(cogs) },
    { label: "Ad Spend", value: adSpend, color: "#a855f7", pct: pct(adSpend) },
    { label: "Shipping", value: shipping, color: "#3b82f6", pct: pct(shipping) },
    { label: "Fees", value: fees, color: "#6b7280", pct: pct(fees) },
    { label: "Expenses", value: expenses, color: "#ef4444", pct: pct(expenses) },
    { label: "Cash in Pocket", value: profit, color: "#22c55e", pct: pct(profit) },
  ].filter((s) => s.pct > 0.5); // hide negligible segments

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text variant="headingMd" as="h2">Revenue Allocation</Text>
          <Text variant="bodySm" as="p" tone="subdued">
            {`Total revenue: ${fmtCurrency(revenue)}`}
          </Text>
        </InlineStack>
        <div style={{ height: "24px", borderRadius: "6px", overflow: "hidden", display: "flex", gap: "2px" }}>
          {segments.map((s) => (
            <div
              key={s.label}
              style={{ width: `${s.pct}%`, background: s.color, minWidth: s.pct > 1 ? undefined : "2px" }}
              title={`${s.label}: ${s.pct.toFixed(1)}%`}
            />
          ))}
        </div>
        <InlineStack gap="400" wrap>
          {segments.map((s) => (
            <InlineStack key={s.label} gap="100" blockAlign="center">
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: s.color, flexShrink: 0 }} />
              <Text variant="bodySm" as="span" tone="subdued">
                {`${s.label} ${s.pct.toFixed(1)}%`}
              </Text>
            </InlineStack>
          ))}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// ── Product leaderboard ───────────────────────────────────────────────────────
function ProductLeaderboard({ top, leaks }: { top: ProductStat[]; leaks: ProductStat[] }) {
  const hasData = top.length > 0 || leaks.length > 0;
  if (!hasData) return null;

  return (
    <Card padding="0">
      <Box padding="400" borderBlockEndWidth="025" borderColor="border">
        <InlineStack align="space-between" blockAlign="center">
          <Text variant="headingMd" as="h2">Performance Leaderboard</Text>
          <Text variant="bodySm" as="p" tone="subdued">Gross contribution per product</Text>
        </InlineStack>
      </Box>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1px 1fr" }}>
        {/* Top performers */}
        <div style={{ padding: "16px 20px" }}>
          <Text variant="bodySm" as="p" tone="subdued" fontWeight="semibold">
            TOP PERFORMING
          </Text>
          <div style={{ marginTop: "12px" }}>
            <BlockStack gap="200">
            {top.length === 0 ? (
              <Text variant="bodySm" as="p" tone="subdued">No data yet</Text>
            ) : top.map((p, i) => (
              <InlineStack key={p.title} align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <div style={{
                    width: 24, height: 24, borderRadius: "50%",
                    background: "#f0fdf8", border: "1px solid #b3e8d8",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: "11px", fontWeight: 700, color: "#008060", flexShrink: 0,
                  }}>
                    {i + 1}
                  </div>
                  <div style={{ maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <Text variant="bodySm" as="span">{p.title}</Text>
                  </div>
                </InlineStack>
                <Text variant="bodySm" as="span" tone="success" fontWeight="semibold">
                  {`+${fmtCurrency(p.profit)}`}
                </Text>
              </InlineStack>
            ))}
            </BlockStack>
          </div>
        </div>

        {/* Divider */}
        <div style={{ background: "#e5e7eb" }} />

        {/* Profit leaks */}
        <div style={{ padding: "16px 20px" }}>
          <Text variant="bodySm" as="p" tone="subdued" fontWeight="semibold">
            PROFIT LEAKS
          </Text>
          <div style={{ marginTop: "12px" }}>
            <BlockStack gap="200">
            {leaks.length === 0 ? (
              <Text variant="bodySm" as="p" tone="success">No loss-making products 🎉</Text>
            ) : leaks.map((p) => (
              <InlineStack key={p.title} align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <span style={{ fontSize: "14px" }}>⚠️</span>
                  <div style={{ maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <Text variant="bodySm" as="span">{p.title}</Text>
                  </div>
                </InlineStack>
                <Text variant="bodySm" as="span" tone="critical" fontWeight="semibold">
                  {fmtCurrency(p.profit)}
                </Text>
              </InlineStack>
            ))}
            </BlockStack>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── Action Center ─────────────────────────────────────────────────────────────
function ActionCenter({ actionCenter, missingCogsCount }: {
  actionCenter: ActionCenterState;
  missingCogsCount: number;
}) {
  const navigate = useNavigate();
  const { state, heroInsight, items, lossBreakdown } = actionCenter;
  const { dismissed, snooze24h } = useDismissed();
  const visibleItems = items.filter((i) => !dismissed.includes(i.type));

  const borderColor = state === "critical" ? "#ffa39e" : state === "warning" ? "#ffe58f" : "#b7eb8f";
  const headerBg = state === "critical" ? "#fff1f0" : state === "warning" ? "#fffbe6" : "#f6ffed";
  const icon = state === "critical" ? "🔴" : state === "warning" ? "⚠️" : "✅";

  return (
    <div style={{ border: `1px solid ${borderColor}`, borderRadius: "12px", overflow: "hidden" }}>
      <div style={{ background: headerBg, padding: "20px 24px", borderBottom: visibleItems.length > 0 ? `1px solid ${borderColor}` : undefined }}>
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="300" blockAlign="center">
            <span style={{ fontSize: "20px" }}>{icon}</span>
            <BlockStack gap="0">
              <Text variant="headingMd" as="h2">
                {state === "healthy" ? "You're on track" : state === "critical" ? "Action required" : "Attention needed"}
              </Text>
              <Text variant="bodySm" as="p" tone={state === "critical" ? "critical" : state === "warning" ? "caution" : "subdued"}>
                {heroInsight}
              </Text>
            </BlockStack>
          </InlineStack>
          <Badge tone={state === "critical" ? "critical" : state === "warning" ? "warning" : "success"}>
            {state === "healthy" ? "Healthy" : state === "critical" ? "Critical" : "Warning"}
          </Badge>
        </InlineStack>

        {lossBreakdown && state === "critical" && (
          <div style={{ marginTop: "16px" }}>
            <Text variant="bodySm" as="p" tone="subdued" fontWeight="semibold">
              Loss contribution this week (proportional attribution)
            </Text>
            <div style={{ display: "flex", gap: "2px", marginTop: "6px", borderRadius: "4px", overflow: "hidden", height: "8px" }}>
              {[
                { key: "ads", color: "#ef4444" },
                { key: "cogs", color: "#f97316" },
                { key: "shipping", color: "#eab308" },
                { key: "fees", color: "#6b7280" },
              ].map(({ key, color }) => {
                const val = lossBreakdown[key as keyof typeof lossBreakdown] as number;
                const pct = lossBreakdown.total > 0 ? (val / lossBreakdown.total) * 100 : 0;
                return pct > 0 ? (
                  <div key={key} style={{ width: `${pct}%`, background: color }} title={`${key}: ${pct.toFixed(0)}%`} />
                ) : null;
              })}
            </div>
            <InlineStack gap="300" blockAlign="center" wrap>
              {[
                { key: "ads", color: "#ef4444", label: "Ads" },
                { key: "cogs", color: "#f97316", label: "COGS" },
                { key: "shipping", color: "#eab308", label: "Shipping" },
                { key: "fees", color: "#6b7280", label: "Fees" },
              ].map(({ key, color, label }) => {
                const val = lossBreakdown[key as keyof typeof lossBreakdown] as number;
                const pct = lossBreakdown.total > 0 ? (val / lossBreakdown.total) * 100 : 0;
                return pct > 0 ? (
                  <InlineStack key={key} gap="100" blockAlign="center">
                    <div style={{ width: 8, height: 8, background: color, borderRadius: "50%" }} />
                    <Text variant="bodySm" as="span" tone="subdued">{label}: {pct.toFixed(0)}%</Text>
                  </InlineStack>
                ) : null;
              })}
            </InlineStack>
          </div>
        )}
      </div>

      {visibleItems.length > 0 && (
        <div style={{ background: "#ffffff" }}>
          {visibleItems.map((item, i) => {
            const conf = confidenceConfig[item.confidence];
            const typeIcon = actionTypeIcons[item.type] ?? "•";
            return (
              <div
                key={item.type}
                style={{ padding: "20px 24px", borderBottom: i < visibleItems.length - 1 ? "1px solid #f5f5f5" : undefined }}
              >
                <InlineStack align="space-between" blockAlign="start" gap="400">
                  <InlineStack gap="300" blockAlign="start">
                    <div style={{
                      width: 36, height: 36, borderRadius: "8px", flexShrink: 0,
                      background: item.severity === "critical" ? "#fff1f0" : item.severity === "warning" ? "#fffbe6" : "#f5f5f5",
                      display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px",
                    }}>
                      {typeIcon}
                    </div>
                    <BlockStack gap="100">
                      <InlineStack gap="200" blockAlign="center">
                        <Text variant="bodyMd" fontWeight="semibold" as="p">{item.title}</Text>
                        <Badge tone={item.severity === "critical" ? "critical" : item.severity === "warning" ? "warning" : "info"}>
                          {item.timeToFix}
                        </Badge>
                      </InlineStack>
                      <Text variant="bodySm" as="p" tone="subdued">{item.description}</Text>
                      <InlineStack gap="300" blockAlign="center" wrap>
                        <Text variant="bodySm" as="p" tone={item.severity === "critical" ? "critical" : "caution"}>
                          {item.impact}
                        </Text>
                        {item.potentialRecovery != null && item.potentialRecovery > 0 && (
                          <Text variant="bodySm" as="p" tone="success">
                            · Recover ~{fmtK(item.potentialRecovery)}/week if fixed
                          </Text>
                        )}
                        <span style={{ fontSize: "11px", color: conf.color }}>· {conf.text}</span>
                      </InlineStack>
                    </BlockStack>
                  </InlineStack>
                  <BlockStack gap="100">
                    {item.actions.filter((a) => a.primary).map((a) => (
                      <Button key={a.label} variant="primary" size="slim" onClick={() => navigate(a.url)}>
                        {a.label}
                      </Button>
                    ))}
                    {item.actions.filter((a) => !a.primary).map((a) => (
                      <Button key={a.label} variant="plain" size="slim" onClick={() => navigate(a.url)}>
                        {a.label}
                      </Button>
                    ))}
                    <Button variant="plain" size="slim" onClick={() => snooze24h(item.type)}>
                      Snooze 24h
                    </Button>
                  </BlockStack>
                </InlineStack>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── KPI strip ─────────────────────────────────────────────────────────────────
function KpiStrip({ metrics, extended }: { metrics: KpiMetric[]; extended: ExtendedKpis }) {
  const [showExtended, setShowExtended] = useState(false);

  const extraMetrics = [
    { label: "Units Sold", value: String(extended.unitsSold), sub: "in period", critical: false },
    { label: "Avg Order Value", value: fmtCurrency(extended.avgOrderValue), sub: "per order", critical: false },
    { label: "Avg Order Profit", value: fmtCurrency(extended.avgOrderProfit), sub: "per order", critical: extended.avgOrderProfit < 0 },
    { label: "Total COGS", value: fmtCurrency(extended.totalCogs), sub: "cost of goods", critical: false },
    { label: "Shipping Costs", value: fmtCurrency(extended.totalShipping), sub: "carrier costs", critical: false },
    { label: "Transaction Fees", value: fmtCurrency(extended.totalFees), sub: "payment fees", critical: false },
  ];

  return (
    <Card>
      <BlockStack gap="0">
        <div style={{ display: "flex", overflowX: "auto" }}>
          {metrics.map((m, i) => (
            <div
              key={m.label}
              style={{
                flex: "1 1 0", minWidth: "140px", padding: "16px 20px",
                borderRight: i < metrics.length - 1 ? "1px solid #e5e7eb" : undefined,
                background: m.highlighted ? "#fff7ed" : undefined,
              }}
            >
              <BlockStack gap="100">
                <InlineStack gap="100" blockAlign="center">
                  <Text variant="bodySm" as="p" tone="subdued">{m.label}</Text>
                  {m.highlighted && <span style={{ fontSize: "10px" }}>⚠️</span>}
                </InlineStack>
                <Text variant="headingLg" as="p" tone={!m.trendPositive && m.trend !== "neutral" ? "critical" : undefined}>
                  {m.value}
                </Text>
                <InlineStack gap="100" blockAlign="center">
                  {m.trend !== "neutral" && (
                    <span style={{ fontSize: "12px", color: m.trendPositive ? "#008060" : "#d92d20" }}>
                      {m.trend === "up" ? "↑" : "↓"}
                    </span>
                  )}
                  <Text variant="bodySm" as="span" tone="subdued">{m.sub}</Text>
                </InlineStack>
              </BlockStack>
            </div>
          ))}
        </div>

        {showExtended && (
          <div style={{ borderTop: "1px solid #e5e7eb", display: "flex", overflowX: "auto" }}>
            {extraMetrics.map((m, i) => (
              <div
                key={m.label}
                style={{
                  flex: "1 1 0", minWidth: "140px", padding: "14px 20px",
                  borderRight: i < extraMetrics.length - 1 ? "1px solid #e5e7eb" : undefined,
                  background: "#f9fafb",
                }}
              >
                <BlockStack gap="100">
                  <Text variant="bodySm" as="p" tone="subdued">{m.label}</Text>
                  <Text variant="headingMd" as="p" tone={m.critical ? "critical" : undefined}>{m.value}</Text>
                  <Text variant="bodySm" as="p" tone="subdued">{m.sub}</Text>
                </BlockStack>
              </div>
            ))}
          </div>
        )}

        <div style={{ padding: "10px 20px", borderTop: "1px solid #e5e7eb" }}>
          <Button
            variant="plain"
            onClick={() => setShowExtended((v) => !v)}
            disclosure={showExtended ? "up" : "down"}
          >
            {showExtended ? "Hide extended metrics" : "View extended metrics"}
          </Button>
        </div>
      </BlockStack>
    </Card>
  );
}

// ── Chart ─────────────────────────────────────────────────────────────────────
interface TooltipProps { active?: boolean; payload?: Array<{ value: number; name: string }>; label?: string; }

function ChartTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const profit = payload.find((p) => p.name === "profit")?.value ?? 0;
  const revenue = payload.find((p) => p.name === "revenue")?.value ?? 0;
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "12px 16px", fontSize: "13px", boxShadow: "0 2px 8px rgba(0,0,0,0.1)" }}>
      <p style={{ fontWeight: 700, marginBottom: 6, color: "#111827" }}>{label}</p>
      <p style={{ color: profit < 0 ? "#d92d20" : "#008060", marginBottom: 2 }}>Profit: {fmtCurrency(profit)}</p>
      <p style={{ color: "#6b7280" }}>Revenue: {fmtCurrency(revenue)}</p>
      {profit < 0 && <p style={{ color: "#d92d20", fontSize: "11px", marginTop: 6, fontWeight: 600 }}>📉 Click to view loss orders</p>}
    </div>
  );
}

function ProfitChart({ chartData }: { chartData: ChartPoint[] }) {
  const navigate = useNavigate();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const lossDays = chartData.filter((d) => d.isLoss);
  if (!mounted) return <Box minHeight="280px" />;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="0">
            <Text variant="headingMd" as="h2">Profit stability</Text>
            <Text variant="bodySm" as="p" tone="subdued">Selected period · Click red dots to view loss orders</Text>
          </BlockStack>
          {lossDays.length > 0 && (
            <Badge tone="critical">{`${lossDays.length} loss day${lossDays.length > 1 ? "s" : ""}`}</Badge>
          )}
        </InlineStack>
        <Box minHeight="260px">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#6b7280" }} interval={Math.max(1, Math.floor(chartData.length / 8))} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} tickFormatter={(v) => "$" + v} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Line type="monotone" dataKey="revenue" stroke="#e5e7eb" strokeWidth={2} dot={false} strokeDasharray="4 4" name="revenue" />
              <Line type="monotone" dataKey="profit" stroke="#008060" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} name="profit" />
              <ReferenceLine y={0} stroke="#d92d20" strokeDasharray="6 3" strokeWidth={1.5} label={{ value: "Break even", position: "right", fontSize: 10, fill: "#d92d20" }} />
              {lossDays.map((d) => (
                <ReferenceDot
                  key={d.dateKey} x={d.date} y={d.profit} r={6}
                  fill="#d92d20" stroke="white" strokeWidth={2}
                  style={{ cursor: "pointer" }}
                  onClick={() => navigate(`/app/orders?from=${d.dateKey}&to=${d.dateKey}&profitability=loss`)}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </Box>
        <InlineStack gap="400" align="center">
          <InlineStack gap="100" blockAlign="center">
            <div style={{ width: 12, height: 3, background: "#008060", borderRadius: 2 }} />
            <Text variant="bodySm" as="span" tone="subdued">Net Profit</Text>
          </InlineStack>
          <InlineStack gap="100" blockAlign="center">
            <div style={{ width: 12, height: 3, background: "#e5e7eb", borderRadius: 2 }} />
            <Text variant="bodySm" as="span" tone="subdued">Revenue</Text>
          </InlineStack>
          <InlineStack gap="100" blockAlign="center">
            <div style={{ width: 10, height: 10, background: "#d92d20", borderRadius: "50%" }} />
            <Text variant="bodySm" as="span" tone="subdued">Loss day</Text>
          </InlineStack>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// ── Priority Orders ───────────────────────────────────────────────────────────
function PriorityOrders({ orders, shop }: { orders: PriorityOrder[]; shop: string }) {
  const needsAttention = orders.filter((o) => o.netProfit < 0 || o.marginPercent < 10);
  return (
    <Card padding="0">
      <Box padding="400" borderBlockEndWidth="025" borderColor="border">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="0">
            <Text variant="headingMd" as="h2">Needs attention</Text>
            <Text variant="bodySm" as="p" tone="subdued">Worst orders first — selected period</Text>
          </BlockStack>
          {needsAttention.length > 0 && (
            <Badge tone="critical">{`${needsAttention.length} orders`}</Badge>
          )}
        </InlineStack>
      </Box>
      {orders.length === 0 ? (
        <Box padding="400"><Text as="p" tone="subdued">No orders yet.</Text></Box>
      ) : (
        <DataTable
          columnContentTypes={["text", "numeric", "text", "text", "text"]}
          headings={["Order", "Net Profit", "Margin", "Top Cost", "Action"]}
          rows={orders.map((o) => [
            <Button key={o.id} variant="plain" url={getShopifyOrderUrl(shop, o.shopifyOrderId)} external>
              {o.shopifyOrderName}
            </Button>,
            <Text as="span" tone={o.netProfit < 0 ? "critical" : undefined} fontWeight="semibold" key={o.id + "-p"}>
              {fmtCurrency(o.netProfit, o.currency)}
            </Text>,
            o.cogsComplete
              ? <Badge key={o.id + "-m"} tone={o.marginPercent < 0 ? "critical" : o.marginPercent < 10 ? "warning" : "success"}>{o.marginPercent.toFixed(1) + "%"}</Badge>
              : <Badge key={o.id + "-m"} tone="attention">Incomplete</Badge>,
            <InlineStack key={o.id + "-r"} gap="100" blockAlign="center">
              <Text variant="bodySm" as="span" tone="subdued">{o.topCostReason}</Text>
              {o.repeatLossCount >= 3 && o.netProfit < 0 && <Badge tone="critical">{`×${o.repeatLossCount}`}</Badge>}
              {o.repeatLossCount >= 2 && o.repeatLossCount < 3 && o.netProfit < 0 && <Badge tone="warning">{`×${o.repeatLossCount}`}</Badge>}
            </InlineStack>,
            o.isHeld
              ? <Badge key={o.id + "-s"} tone="warning">On Hold</Badge>
              : o.financialStatus === "refunded"
              ? <Badge key={o.id + "-s"} tone="critical">Refunded</Badge>
              : <Button key={o.id + "-s"} variant="plain" url={getShopifyOrderUrl(shop, o.shopifyOrderId)} external size="slim">Review ↗</Button>,
          ])}
        />
      )}
      <Box padding="400" borderBlockStartWidth="025" borderColor="border">
        <Button variant="plain" url="/app/orders?profitability=loss">View all loss orders →</Button>
      </Box>
    </Card>
  );
}

// ── Held Orders ───────────────────────────────────────────────────────────────
function HeldOrdersCard({ heldOrders, heldSavedAmount, onRelease, isSubmitting }: {
  heldOrders: HeldOrder[]; heldSavedAmount: number;
  onRelease: (id: string) => void; isSubmitting: boolean;
}) {
  return (
    <Card padding="0">
      <Box padding="400" borderBlockEndWidth="025" borderColor="border">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="0">
            <Text variant="headingMd" as="h2">Held Orders</Text>
            {heldSavedAmount > 0
              ? <Text variant="bodySm" as="p" tone="success">🛡 Saved ~{fmtCurrency(heldSavedAmount)} in potential losses</Text>
              : <Text variant="bodySm" as="p" tone="subdued">Auto-hold active</Text>}
          </BlockStack>
          {heldOrders.length > 0 && <Badge tone="warning">{String(heldOrders.length)}</Badge>}
        </InlineStack>
      </Box>
      {heldOrders.length === 0 ? (
        <Box padding="400"><Text as="p" tone="subdued">No orders on hold right now.</Text></Box>
      ) : (
        <ResourceList
          resourceName={{ singular: "held order", plural: "held orders" }}
          items={heldOrders}
          renderItem={(order: HeldOrder) => (
            <ResourceItem id={order.id} onClick={() => {}} accessibilityLabel={order.shopifyOrderName}>
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="bodyMd" fontWeight="semibold" as="p">{order.shopifyOrderName}</Text>
                  <Text variant="bodySm" as="p" tone="subdued">{order.heldReason ?? "Held for review"}</Text>
                </BlockStack>
                <InlineStack gap="300" blockAlign="center">
                  <Badge tone={order.marginPercent < 0 ? "critical" : "warning"}>
                    {order.marginPercent.toFixed(1) + "%"}
                  </Badge>
                  <Button variant="primary" size="slim" loading={isSubmitting} onClick={() => onRelease(order.id)}>
                    Release
                  </Button>
                </InlineStack>
              </InlineStack>
            </ResourceItem>
          )}
        />
      )}
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const {
    actionCenter, kpiMetrics, extendedKpis, revenueAllocation, productLeaderboard,
    chartData, priorityOrders, heldOrders, heldSavedAmount,
    missingCogsCount, missingCogsImpact, visibleCards: initialVisibleCards,
    hasOrders, shop, dateFrom, dateTo,
  } = useLoaderData() as LoaderData;

  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isLoading = navigation.state === "loading";
  const isSubmitting = navigation.state === "submitting";

  // Sync date range from localStorage on first load if no URL params set
  useEffect(() => {
    const hasDateParam = searchParams.has("from") || searchParams.has("to");
    if (!hasDateParam) {
      const saved = loadFromStorage();
      if (saved && (saved.from !== dateFrom || saved.to !== dateTo)) {
        const next = new URLSearchParams(searchParams);
        next.set("from", saved.from);
        next.set("to", saved.to);
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
            <Card>
              <EmptyState
                heading="ClearProfit is ready to go"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                action={{ content: "Set up product costs", url: "/app/products" }}
                secondaryAction={{ content: "Configure settings", url: "/app/settings" }}
              >
                <p>Your first order will be calculated the moment it comes in. Set up product costs so margins are accurate from day one.</p>
              </EmptyState>
            </Card>
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
    next.set("from", from);
    next.set("to", to);
    setSearchParams(next);
  };

  return (
    <Page
      title="Dashboard"
      primaryAction={{
        content: "Customize",
        onAction: () => { setDraftCards([...visibleCards]); setCustomizeOpen(true); },
      }}
    >
      <Layout>
        {/* Date range picker — always visible */}
        <Layout.Section>
          <DateRangePicker dateFrom={dateFrom} dateTo={dateTo} onUpdate={handleDateUpdate} />
        </Layout.Section>

        {isVisible("action_center") && (
          <Layout.Section>
            <ActionCenter actionCenter={actionCenter} missingCogsCount={missingCogsCount} />
          </Layout.Section>
        )}

        {isVisible("kpi_strip") && (
          <Layout.Section>
            <KpiStrip metrics={kpiMetrics} extended={extendedKpis} />
          </Layout.Section>
        )}

        {isVisible("revenue_allocation") && (
          <Layout.Section>
            <RevenueAllocationBar allocation={revenueAllocation} />
          </Layout.Section>
        )}

        {isVisible("product_leaderboard") && (
          <Layout.Section>
            <ProductLeaderboard top={productLeaderboard.top} leaks={productLeaderboard.leaks} />
          </Layout.Section>
        )}

        {isVisible("chart") && (
          <Layout.Section>
            <ProfitChart chartData={chartData} />
          </Layout.Section>
        )}

        {(isVisible("priority_orders") || isVisible("held_orders")) && (
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, lg: 2 }} gap="400">
              {isVisible("priority_orders") && <PriorityOrders orders={priorityOrders} shop={shop} />}
              {isVisible("held_orders") && (
                <HeldOrdersCard
                  heldOrders={heldOrders}
                  heldSavedAmount={heldSavedAmount}
                  onRelease={(id) => submit({ intent: "releaseHold", orderId: id }, { method: "POST" })}
                  isSubmitting={isSubmitting}
                />
              )}
            </InlineGrid>
          </Layout.Section>
        )}
      </Layout>

      <Modal
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        title="Customize dashboard"
        primaryAction={{ content: "Save", onAction: handleSaveConfig }}
        secondaryActions={[{ content: "Cancel", onAction: () => setCustomizeOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" tone="subdued">Choose which sections to show.</Text>
            {ALL_CARDS.map((card) => (
              <Checkbox
                key={card.id}
                label={card.label}
                checked={draftCards.includes(card.id)}
                onChange={(checked) =>
                  setDraftCards((prev) =>
                    checked ? [...prev, card.id] : prev.filter((c) => c !== card.id)
                  )
                }
              />
            ))}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
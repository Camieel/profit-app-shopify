import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useNavigate } from "react-router";
import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  Box,
  BlockStack,
  InlineStack,
  Button,
  Banner,
  ResourceList,
  ResourceItem,
  EmptyState,
  Modal,
  Checkbox,
  DataTable,
  SkeletonPage,
  SkeletonBodyText,
  SkeletonDisplayText,
  Divider,
  InlineGrid,
} from "@shopify/polaris";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
} from "recharts";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { toMonthly } from "./app.expenses";

// ── Card config ──────────────────────────────────────────────────────────────
const ALL_CARDS = [
  { id: "action_center", label: "Action Center" },
  { id: "kpi_strip", label: "Key Metrics" },
  { id: "chart", label: "Profit Stability Chart" },
  { id: "priority_orders", label: "Priority Orders" },
  { id: "held_orders", label: "Held Orders" },
  { id: "insights", label: "Insights" },
] as const;

type CardId = (typeof ALL_CARDS)[number]["id"];
const DEFAULT_CARDS: CardId[] = [
  "action_center",
  "kpi_strip",
  "chart",
  "priority_orders",
  "held_orders",
  "insights",
];

// ── Types ────────────────────────────────────────────────────────────────────
interface ActionItem {
  type: "loss_orders" | "low_margin" | "high_ad_spend" | "high_expenses" | "missing_cogs";
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  impact: string;
  actions: { label: string; url: string; primary?: boolean }[];
}

interface ActionCenterState {
  state: "critical" | "warning" | "healthy";
  items: ActionItem[];
  summary: {
    lossAmount: number;
    lossOrders: number;
    avgMargin: number;
    profit7d: number;
  };
}

interface KpiMetric {
  label: string;
  value: string;
  sub: string;
  trend: "up" | "down" | "neutral";
  trendPositive: boolean;
}

interface ChartPoint {
  date: string;
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

interface InsightItem {
  type: string;
  severity: "critical" | "warning" | "info";
  message: string;
  url: string;
}

interface LoaderData {
  actionCenter: ActionCenterState;
  kpiMetrics: KpiMetric[];
  chartData: ChartPoint[];
  priorityOrders: PriorityOrder[];
  heldOrders: HeldOrder[];
  heldSavedAmount: number;
  insights: InsightItem[];
  missingCogsCount: number;
  missingCogsImpact: number;
  visibleCards: CardId[];
  hasOrders: boolean;
  alertMarginThreshold: number;
  shop: string;
}

// ── Loader ───────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

  const [
    orders30d,
    ordersPrev30d,
    orders7d,
    heldOrders,
    missingCogsVariants,
    settings,
    expenses,
    totalOrderCount,
    ordersForChart,
  ] = await Promise.all([
    db.order.findMany({
      where: { shop, shopifyCreatedAt: { gte: thirtyDaysAgo } },
      select: {
        id: true, shopifyOrderId: true, shopifyOrderName: true,
        totalPrice: true, netProfit: true, marginPercent: true,
        isHeld: true, cogsComplete: true, financialStatus: true,
        currency: true, shopifyCreatedAt: true,
        cogs: true, transactionFee: true, shippingCost: true, adSpendAllocated: true,
      },
    }),
    db.order.aggregate({
      where: { shop, shopifyCreatedAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo } },
      _sum: { totalPrice: true, netProfit: true },
      _avg: { marginPercent: true },
      _count: { id: true },
    }),
    db.order.findMany({
      where: { shop, shopifyCreatedAt: { gte: sevenDaysAgo } },
      select: { netProfit: true, marginPercent: true, isHeld: true },
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
    db.order.findMany({
      where: { shop, shopifyCreatedAt: { gte: thirtyDaysAgo } },
      select: { shopifyCreatedAt: true, totalPrice: true, netProfit: true },
      orderBy: { shopifyCreatedAt: "asc" },
    }),
  ]);

  const alertMarginThreshold = settings?.alertMarginThreshold ?? 0;

  // ── KPI calculations ─────────────────────────────────────────────────────
  const monthlyExpenses = (expenses ?? []).reduce(
    (s: number, e: { amount: number; interval: string }) => s + toMonthly(e.amount, e.interval),
    0
  );

  const totalRevenue30d = orders30d.reduce((s, o) => s + o.totalPrice, 0);
  const totalNetProfit30d = orders30d.reduce((s, o) => s + o.netProfit, 0) - monthlyExpenses;
  const avgMargin30d = orders30d.length > 0
    ? orders30d.reduce((s, o) => s + o.marginPercent, 0) / orders30d.length : 0;
  const totalAdSpend30d = orders30d.reduce((s, o) => s + (o.adSpendAllocated ?? 0), 0);

  const prevRevenue = ordersPrev30d._sum.totalPrice ?? 0;
  const prevProfit = (ordersPrev30d._sum.netProfit ?? 0) - monthlyExpenses;
  const prevMargin = ordersPrev30d._avg.marginPercent ?? 0;
  const prevCount = ordersPrev30d._count.id ?? 0;

  const pctChange = (curr: number, prev: number) => {
    if (prev === 0) return null;
    return ((curr - prev) / Math.abs(prev)) * 100;
  };

  const profitPct = pctChange(totalNetProfit30d, prevProfit);
  const revenuePct = pctChange(totalRevenue30d, prevRevenue);
  const marginPct = pctChange(avgMargin30d, prevMargin);
  const ordersPct = pctChange(orders30d.length, prevCount);

  const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
  const fmtPct = (n: number | null) => n == null ? "vs prev period" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}% vs prev period`;
  const trendDir = (n: number | null) => n == null ? "neutral" : n >= 0 ? "up" : "down";

  const kpiMetrics: KpiMetric[] = [
    {
      label: "Net Profit (30d)",
      value: fmt(totalNetProfit30d),
      sub: fmtPct(profitPct),
      trend: trendDir(profitPct),
      trendPositive: (profitPct ?? 0) >= 0,
    },
    {
      label: "Revenue (30d)",
      value: fmt(totalRevenue30d),
      sub: fmtPct(revenuePct),
      trend: trendDir(revenuePct),
      trendPositive: (revenuePct ?? 0) >= 0,
    },
    {
      label: "Avg Margin",
      value: avgMargin30d.toFixed(1) + "%",
      sub: fmtPct(marginPct),
      trend: trendDir(marginPct),
      trendPositive: (marginPct ?? 0) >= 0,
    },
    {
      label: "Orders (30d)",
      value: String(orders30d.length),
      sub: fmtPct(ordersPct),
      trend: trendDir(ordersPct),
      trendPositive: (ordersPct ?? 0) >= 0,
    },
    {
      label: "Ad Spend (30d)",
      value: fmt(totalAdSpend30d),
      sub: totalRevenue30d > 0 ? `${((totalAdSpend30d / totalRevenue30d) * 100).toFixed(0)}% of revenue` : "No revenue",
      trend: "neutral",
      trendPositive: totalRevenue30d > 0 && (totalAdSpend30d / totalRevenue30d) < 0.4,
    },
    {
      label: "Fixed Expenses",
      value: fmt(monthlyExpenses),
      sub: "per month",
      trend: "neutral",
      trendPositive: true,
    },
  ];

  // ── Chart data ────────────────────────────────────────────────────────────
  const chartMap = new Map<string, { date: string; profit: number; revenue: number; orderCount: number }>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const dateStr = d.toISOString().split("T")[0];
    chartMap.set(dateStr, {
      date: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
      profit: 0, revenue: 0, orderCount: 0,
    });
  }
  for (const o of ordersForChart) {
    const dStr = o.shopifyCreatedAt.toISOString().split("T")[0];
    const entry = chartMap.get(dStr);
    if (entry) {
      entry.profit += o.netProfit;
      entry.revenue += o.totalPrice;
      entry.orderCount += 1;
    }
  }
  const chartData: ChartPoint[] = Array.from(chartMap.values()).map((p) => ({
    ...p,
    profit: parseFloat(p.profit.toFixed(2)),
    revenue: parseFloat(p.revenue.toFixed(2)),
    isLoss: p.profit < 0,
  }));

  // ── Priority orders ───────────────────────────────────────────────────────
  const priorityOrders: PriorityOrder[] = [...orders30d]
    .sort((a, b) => a.netProfit - b.netProfit)
    .slice(0, 8)
    .map((o) => ({
      id: o.id,
      shopifyOrderId: o.shopifyOrderId,
      shopifyOrderName: o.shopifyOrderName,
      netProfit: o.netProfit,
      marginPercent: o.marginPercent,
      isHeld: o.isHeld,
      cogsComplete: o.cogsComplete,
      financialStatus: o.financialStatus,
      currency: o.currency,
    }));

  // ── Held orders saved amount ──────────────────────────────────────────────
  // Estimate: if these orders had shipped, the loss would have been realized
  const heldSavedAmount = heldOrders
    .filter((o) => o.netProfit < 0)
    .reduce((s, o) => s + Math.abs(o.netProfit), 0);

  // ── Missing COGS impact ───────────────────────────────────────────────────
  const missingCogsCount = missingCogsVariants.length;
  // Estimate: average revenue per order × missing ratio as rough impact
  const avgOrderRevenue = totalRevenue30d / Math.max(orders30d.length, 1);
  const ordersWithMissingCogs = orders30d.filter((o) => !o.cogsComplete).length;
  const missingCogsImpact = ordersWithMissingCogs * avgOrderRevenue * 0.15; // ~15% margin assumption

  // ── Action center ─────────────────────────────────────────────────────────
  const lossOrders7d = orders7d.filter((o) => o.netProfit < 0);
  const lossAmount7d = lossOrders7d.reduce((s, o) => s + Math.abs(o.netProfit), 0);
  const avgMargin7d = orders7d.length > 0
    ? orders7d.reduce((s, o) => s + o.marginPercent, 0) / orders7d.length : 0;
  const profit7d = orders7d.reduce((s, o) => s + o.netProfit, 0);

  const actionItems: ActionItem[] = [];

  if (lossOrders7d.length > 0) {
    const unheldLossOrders = lossOrders7d.filter((o) => !o.isHeld).length;
    actionItems.push({
      type: "loss_orders",
      severity: "critical",
      title: `You lost money on ${lossOrders7d.length} order${lossOrders7d.length > 1 ? "s" : ""} this week`,
      description: `${lossOrders7d.length} orders had negative profit in the last 7 days.${unheldLossOrders > 0 ? ` ${unheldLossOrders} were not held.` : ""}`,
      impact: `Estimated loss: ${fmt(lossAmount7d)}`,
      actions: [
        { label: "Review loss orders", url: "/app/orders?profitability=loss&from=" + sevenDaysAgo.toISOString().split("T")[0], primary: true },
        ...(!(settings?.holdEnabled) ? [{ label: "Enable auto-hold", url: "/app/settings" }] : []),
      ],
    });
  }

  if (avgMargin7d > 0 && avgMargin7d < (alertMarginThreshold || 10) && lossOrders7d.length === 0) {
    actionItems.push({
      type: "low_margin",
      severity: "warning",
      title: "Margins are dropping",
      description: `Your avg margin is ${avgMargin7d.toFixed(1)}% — below the healthy range of ${alertMarginThreshold || 10}–15%.`,
      impact: "Check your pricing or product costs",
      actions: [
        { label: "View products", url: "/app/products", primary: true },
        { label: "Check settings", url: "/app/settings" },
      ],
    });
  }

  if (totalAdSpend30d > 0 && totalRevenue30d > 0 && totalAdSpend30d / totalRevenue30d > 0.4) {
    actionItems.push({
      type: "high_ad_spend",
      severity: "warning",
      title: "Ad spend is eating your profit",
      description: `Ad spend is ${((totalAdSpend30d / totalRevenue30d) * 100).toFixed(0)}% of revenue — target is below 30%.`,
      impact: `Excess spend: ~${fmt(totalAdSpend30d - totalRevenue30d * 0.3)}/mo`,
      actions: [{ label: "View ad breakdown", url: "/app/orders", primary: true }],
    });
  }

  if (monthlyExpenses > totalRevenue30d * 0.2) {
    actionItems.push({
      type: "high_expenses",
      severity: "info",
      title: `Fixed expenses: ${fmt(monthlyExpenses)}/month`,
      description: "Your fixed costs are a significant portion of revenue.",
      impact: `${((monthlyExpenses / Math.max(totalRevenue30d, 1)) * 100).toFixed(0)}% of monthly revenue`,
      actions: [{ label: "Review expenses", url: "/app/expenses", primary: true }],
    });
  }

  let acState: "critical" | "warning" | "healthy" = "healthy";
  if (actionItems.some((i) => i.severity === "critical")) acState = "critical";
  else if (actionItems.some((i) => i.severity === "warning")) acState = "warning";

  const actionCenter: ActionCenterState = {
    state: acState,
    items: actionItems,
    summary: { lossAmount: lossAmount7d, lossOrders: lossOrders7d.length, avgMargin: avgMargin7d, profit7d },
  };

  // ── Insights ─────────────────────────────────────────────────────────────
  const insights: InsightItem[] = [];
  const lossOrders30d = orders30d.filter((o) => o.netProfit < 0);
  if (lossOrders30d.length > 0) {
    insights.push({
      type: "loss_orders",
      severity: "critical",
      message: `${lossOrders30d.length} unprofitable orders in the last 30 days`,
      url: "/app/orders?profitability=loss",
    });
  }
  const lowMarginOrders = orders30d.filter((o) => o.marginPercent > 0 && o.marginPercent < 5);
  if (lowMarginOrders.length > 0) {
    insights.push({
      type: "low_margin",
      severity: "warning",
      message: `${lowMarginOrders.length} orders below 5% margin`,
      url: "/app/orders?profitability=profitable",
    });
  }
  const ordersNoAdSpend = orders30d.filter((o) => o.adSpendAllocated === 0).length;
  if (ordersNoAdSpend > 0 && totalAdSpend30d > 0) {
    insights.push({
      type: "no_ad_spend",
      severity: "info",
      message: `Ad costs missing on ${ordersNoAdSpend} orders`,
      url: "/app/settings",
    });
  }
  if (missingCogsCount > 0) {
    insights.push({
      type: "missing_cogs",
      severity: "warning",
      message: `${missingCogsCount} products missing cost data — profit may be overstated`,
      url: "/app/products",
    });
  }

  // ── Visible cards ─────────────────────────────────────────────────────────
  let visibleCards: CardId[] = DEFAULT_CARDS;
  if (settings?.dashboardCards) {
    try { visibleCards = JSON.parse(settings.dashboardCards); } catch { visibleCards = DEFAULT_CARDS; }
  }

  return json({
    actionCenter,
    kpiMetrics,
    chartData,
    priorityOrders,
    heldOrders: heldOrders.map((o) => ({
      id: o.id,
      shopifyOrderName: o.shopifyOrderName,
      shopifyOrderId: o.shopifyOrderId,
      netProfit: o.netProfit,
      marginPercent: o.marginPercent,
      heldReason: o.heldReason,
      totalPrice: o.totalPrice,
      currency: o.currency,
    })),
    heldSavedAmount,
    insights,
    missingCogsCount,
    missingCogsImpact,
    visibleCards,
    hasOrders: totalOrderCount > 0,
    alertMarginThreshold,
    shop,
  });
};

// ── Action ───────────────────────────────────────────────────────────────────
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
      `#graphql
      query getFulfillmentOrders($id: ID!) {
        order(id: $id) {
          fulfillmentOrders(first: 1) {
            nodes { id status }
          }
        }
      }`,
      { variables: { id: order.shopifyOrderId } }
    );
    const foData: any = await foResponse.json();
    const fo = foData.data?.order?.fulfillmentOrders?.nodes?.[0];
    if (fo) {
      const mutRes: any = await admin.graphql(
        `#graphql
        mutation releaseHold($id: ID!) {
          fulfillmentOrderReleaseHold(id: $id) {
            fulfillmentOrder { id status }
            userErrors { field message }
          }
        }`,
        { variables: { id: fo.id } }
      );
      const mutData: any = await mutRes.json();
      const errors = mutData.data?.fulfillmentOrderReleaseHold?.userErrors;
      if (errors?.length > 0) return json({ error: errors[0].message }, { status: 400 });
    }
    await db.order.update({ where: { id: orderId }, data: { isHeld: false, heldReason: null } });
    return json({ success: true });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtCurrency(amount: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(amount);
}

function getShopifyOrderUrl(shop: string, shopifyOrderId: string) {
  const numericId = shopifyOrderId.replace("gid://shopify/Order/", "");
  return `https://${shop}/admin/orders/${numericId}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <SkeletonPage title="Dashboard">
      <Layout>
        <Layout.Section><Card><BlockStack gap="400"><SkeletonDisplayText size="small" /><SkeletonBodyText lines={3} /></BlockStack></Card></Layout.Section>
        <Layout.Section><Card><SkeletonBodyText lines={2} /></Card></Layout.Section>
        <Layout.Section><Card><SkeletonBodyText lines={8} /></Card></Layout.Section>
        <Layout.Section><Card><SkeletonBodyText lines={6} /></Card></Layout.Section>
      </Layout>
    </SkeletonPage>
  );
}

function ActionCenter({ actionCenter }: { actionCenter: ActionCenterState }) {
  const { state, items, summary } = actionCenter;

  const stateConfig = {
    critical: { bg: "#fff1f0", border: "#ffa39e", icon: "🔴", headerBg: "#ff4d4f", label: "Action required" },
    warning: { bg: "#fffbe6", border: "#ffe58f", icon: "⚠️", headerBg: "#faad14", label: "Attention needed" },
    healthy: { bg: "#f6ffed", border: "#b7eb8f", icon: "✅", headerBg: "#52c41a", label: "Looking good" },
  }[state];

  if (state === "healthy") {
    return (
      <div style={{ border: "1px solid #b7eb8f", borderRadius: "12px", overflow: "hidden" }}>
        <div style={{ background: "#f6ffed", padding: "20px 24px" }}>
          <InlineStack align="space-between" blockAlign="center">
            <InlineStack gap="300" blockAlign="center">
              <span style={{ fontSize: "24px" }}>✅</span>
              <BlockStack gap="0">
                <Text variant="headingMd" as="h2">You're profitable</Text>
                <Text variant="bodySm" as="p" tone="subdued">
                  {`Profit this week: ${fmtCurrency(summary.profit7d)} · Avg margin: ${summary.avgMargin.toFixed(1)}%`}
                </Text>
              </BlockStack>
            </InlineStack>
            <Badge tone="success">No action needed</Badge>
          </InlineStack>
        </div>
      </div>
    );
  }

  return (
    <div style={{ border: `1px solid ${stateConfig.border}`, borderRadius: "12px", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ background: stateConfig.bg, padding: "16px 24px", borderBottom: `1px solid ${stateConfig.border}` }}>
        <InlineStack gap="200" blockAlign="center">
          <span style={{ fontSize: "18px" }}>{stateConfig.icon}</span>
          <Text variant="headingMd" as="h2">
            {state === "critical" ? "You are losing money" : "Margins are under pressure"}
          </Text>
          <Badge tone={state === "critical" ? "critical" : "warning"}>{stateConfig.label}</Badge>
        </InlineStack>
      </div>

      {/* Items */}
      <div style={{ background: "#ffffff" }}>
        {items.map((item, i) => (
          <div key={item.type} style={{ padding: "20px 24px", borderBottom: i < items.length - 1 ? "1px solid #f0f0f0" : undefined }}>
            <InlineStack align="space-between" blockAlign="start">
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone={item.severity === "critical" ? "critical" : item.severity === "warning" ? "warning" : "info"}>
                    {item.severity === "critical" ? "Critical" : item.severity === "warning" ? "Warning" : "Info"}
                  </Badge>
                  <Text variant="bodyMd" fontWeight="semibold" as="p">{item.title}</Text>
                </InlineStack>
                <Text variant="bodySm" as="p" tone="subdued">{item.description}</Text>
                <Text variant="bodySm" as="p" tone={item.severity === "critical" ? "critical" : "caution"}>
                  {item.impact}
                </Text>
              </BlockStack>
              <InlineStack gap="200">
                {item.actions.map((a) => (
                  <Button key={a.label} variant={a.primary ? "primary" : "plain"} url={a.url} size="slim">
                    {a.label}
                  </Button>
                ))}
              </InlineStack>
            </InlineStack>
          </div>
        ))}
      </div>
    </div>
  );
}

function KpiStrip({ metrics }: { metrics: KpiMetric[] }) {
  return (
    <Card>
      <InlineStack gap="0" wrap={false}>
        {metrics.map((m, i) => (
          <div
            key={m.label}
            style={{
              flex: 1,
              padding: "16px 20px",
              borderRight: i < metrics.length - 1 ? "1px solid #e5e7eb" : undefined,
              minWidth: 0,
            }}
          >
            <BlockStack gap="100">
              <Text variant="bodySm" as="p" tone="subdued">{m.label}</Text>
              <Text
                variant="headingLg"
                as="p"
                tone={
                  m.trend === "neutral"
                    ? undefined
                    : m.trendPositive
                    ? undefined
                    : "critical"
                }
              >
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
      </InlineStack>
    </Card>
  );
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number; name: string }>;
  label?: string;
}

function CustomChartTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  const profit = payload.find((p) => p.name === "profit")?.value ?? 0;
  const revenue = payload.find((p) => p.name === "revenue")?.value ?? 0;
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "12px 16px", fontSize: "13px", boxShadow: "0 2px 8px rgba(0,0,0,0.1)" }}>
      <p style={{ fontWeight: 700, marginBottom: 6 }}>{label}</p>
      <p style={{ color: profit < 0 ? "#d92d20" : "#008060" }}>Profit: {fmtCurrency(profit)}</p>
      <p style={{ color: "#6b7280" }}>Revenue: {fmtCurrency(revenue)}</p>
    </div>
  );
}

function ProfitChart({ chartData }: { chartData: ChartPoint[] }) {
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
            <Text variant="bodySm" as="p" tone="subdued">Last 30 days · Red dots = loss days</Text>
          </BlockStack>
          {lossDays.length > 0 && (
            <Badge tone="critical">{`${lossDays.length} loss day${lossDays.length > 1 ? "s" : ""}`}</Badge>
          )}
        </InlineStack>
        <Box minHeight="260px">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#6b7280" }} interval={6} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} tickFormatter={(v) => "$" + v} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomChartTooltip />} />
              <Line type="monotone" dataKey="revenue" stroke="#e5e7eb" strokeWidth={2} dot={false} strokeDasharray="4 4" name="revenue" />
              <Line type="monotone" dataKey="profit" stroke="#008060" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} name="profit" />
              {lossDays.map((d) => (
                <ReferenceDot key={d.date} x={d.date} y={d.profit} r={5} fill="#d92d20" stroke="white" strokeWidth={2} />
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

function PriorityOrders({ orders, shop }: { orders: PriorityOrder[]; shop: string }) {
  const needsAttention = orders.filter((o) => o.netProfit < 0 || o.marginPercent < 10);

  return (
    <Card padding="0">
      <Box padding="400" borderBlockEndWidth="025" borderColor="border">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="0">
            <Text variant="headingMd" as="h2">Needs attention</Text>
            <Text variant="bodySm" as="p" tone="subdued">Sorted by profit — worst first</Text>
          </BlockStack>
          {needsAttention.length > 0 && (
            <Badge tone="critical">{`${needsAttention.length} orders`}</Badge>
          )}
        </InlineStack>
      </Box>
      {orders.length === 0 ? (
        <Box padding="400">
          <Text as="p" tone="subdued">No orders in the last 30 days.</Text>
        </Box>
      ) : (
        <DataTable
          columnContentTypes={["text", "numeric", "text", "text"]}
          headings={["Order", "Net Profit", "Margin", "Action"]}
          rows={orders.map((o) => [
            <Button
              key={o.id}
              variant="plain"
              url={getShopifyOrderUrl(shop, o.shopifyOrderId)}
              external
            >
              {o.shopifyOrderName}
            </Button>,
            <Text
              as="span"
              tone={o.netProfit < 0 ? "critical" : undefined}
              fontWeight="semibold"
              key={o.id + "-p"}
            >
              {fmtCurrency(o.netProfit, o.currency)}
            </Text>,
            o.cogsComplete ? (
              <Badge
                key={o.id + "-m"}
                tone={o.marginPercent < 0 ? "critical" : o.marginPercent < 10 ? "warning" : "success"}
              >
                {o.marginPercent.toFixed(1) + "%"}
              </Badge>
            ) : (
              <Badge key={o.id + "-m"} tone="attention">Incomplete</Badge>
            ),
            o.isHeld ? (
              <Badge key={o.id + "-s"} tone="warning">On Hold</Badge>
            ) : o.financialStatus === "refunded" ? (
              <Badge key={o.id + "-s"} tone="critical">Refunded</Badge>
            ) : (
              <Button
                key={o.id + "-s"}
                variant="plain"
                url={getShopifyOrderUrl(shop, o.shopifyOrderId)}
                external
                size="slim"
              >
                Review ↗
              </Button>
            ),
          ])}
        />
      )}
      <Box padding="400" borderBlockStartWidth="025" borderColor="border">
        <Button variant="plain" url="/app/orders?profitability=loss">
          View all loss orders →
        </Button>
      </Box>
    </Card>
  );
}

function HeldOrdersCard({
  heldOrders,
  heldSavedAmount,
  onRelease,
  isSubmitting,
}: {
  heldOrders: HeldOrder[];
  heldSavedAmount: number;
  onRelease: (id: string) => void;
  isSubmitting: boolean;
}) {
  return (
    <Card padding="0">
      <Box padding="400" borderBlockEndWidth="025" borderColor="border">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="0">
            <Text variant="headingMd" as="h2">Held Orders</Text>
            {heldSavedAmount > 0 && (
              <Text variant="bodySm" as="p" tone="success">
                {`Holds saved you ~${fmtCurrency(heldSavedAmount)} in losses`}
              </Text>
            )}
          </BlockStack>
          {heldOrders.length > 0 && (
            <Badge tone="warning">{String(heldOrders.length)}</Badge>
          )}
        </InlineStack>
      </Box>
      {heldOrders.length === 0 ? (
        <Box padding="400">
          <InlineStack gap="200" blockAlign="center">
            <Text as="p" tone="subdued">No orders on hold.</Text>
          </InlineStack>
        </Box>
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

function InsightsCard({ insights }: { insights: InsightItem[] }) {
  if (insights.length === 0) return null;

  const iconMap: Record<string, string> = {
    loss_orders: "🔴",
    low_margin: "🟡",
    no_ad_spend: "🔵",
    missing_cogs: "⚠️",
  };

  return (
    <Card>
      <BlockStack gap="300">
        <Text variant="headingMd" as="h2">Insights</Text>
        <Divider />
        <BlockStack gap="200">
          {insights.map((insight, i) => (
            <InlineStack key={i} align="space-between" blockAlign="center">
              <InlineStack gap="200" blockAlign="center">
                <span style={{ fontSize: "16px" }}>{iconMap[insight.type] ?? "•"}</span>
                <Text variant="bodyMd" as="p">{insight.message}</Text>
              </InlineStack>
              <Button variant="plain" url={insight.url} size="slim">
                View →
              </Button>
            </InlineStack>
          ))}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const {
    actionCenter,
    kpiMetrics,
    chartData,
    priorityOrders,
    heldOrders,
    heldSavedAmount,
    insights,
    missingCogsCount,
    missingCogsImpact,
    visibleCards: initialVisibleCards,
    hasOrders,
    shop,
  } = useLoaderData() as LoaderData;

  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";
  const isSubmitting = navigation.state === "submitting";

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
                <p>
                  Your first order will be calculated automatically the moment it comes in.
                  Make sure your product costs are set up so margins are accurate from day one.
                </p>
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

  const handleReleaseHold = (orderId: string) => {
    submit({ intent: "releaseHold", orderId }, { method: "POST" });
  };

  return (
    <Page
      title="Dashboard"
      primaryAction={{ content: "Customize", onAction: () => { setDraftCards([...visibleCards]); setCustomizeOpen(true); } }}
    >
      <Layout>

        {/* 1. Missing COGS — always visible if data issue */}
        {missingCogsCount > 0 && (
          <Layout.Section>
            <Banner
              tone="warning"
              action={{ content: "Fix now", url: "/app/products" }}
              title={`⚠️ ${missingCogsCount} products missing cost data — profit may be overstated by ~${fmtCurrency(missingCogsImpact)}`}
            >
              <p>Orders with these products show incomplete margins and may not trigger holds correctly.</p>
            </Banner>
          </Layout.Section>
        )}

        {/* 2. Action Center */}
        {isVisible("action_center") && (
          <Layout.Section>
            <ActionCenter actionCenter={actionCenter} />
          </Layout.Section>
        )}

        {/* 3. KPI Strip */}
        {isVisible("kpi_strip") && (
          <Layout.Section>
            <KpiStrip metrics={kpiMetrics} />
          </Layout.Section>
        )}

        {/* 4. Chart */}
        {isVisible("chart") && (
          <Layout.Section>
            <ProfitChart chartData={chartData} />
          </Layout.Section>
        )}

        {/* 5. Priority Orders + Held Orders side by side */}
        {(isVisible("priority_orders") || isVisible("held_orders")) && (
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, lg: 2 }} gap="400">
              {isVisible("priority_orders") && (
                <PriorityOrders orders={priorityOrders} shop={shop} />
              )}
              {isVisible("held_orders") && (
                <HeldOrdersCard
                  heldOrders={heldOrders}
                  heldSavedAmount={heldSavedAmount}
                  onRelease={handleReleaseHold}
                  isSubmitting={isSubmitting}
                />
              )}
            </InlineGrid>
          </Layout.Section>
        )}

        {/* 6. Insights */}
        {isVisible("insights") && insights.length > 0 && (
          <Layout.Section>
            <InsightsCard insights={insights} />
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
            <Text as="p" tone="subdued">Choose which sections to show on your dashboard.</Text>
            {ALL_CARDS.map((card) => (
              <Checkbox
                key={card.id}
                label={card.label}
                checked={draftCards.includes(card.id)}
                onChange={(checked) =>
                  setDraftCards((prev) => checked ? [...prev, card.id] : prev.filter((c) => c !== card.id))
                }
              />
            ))}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "react-router";
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
} from "recharts";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { toMonthly } from "./app.expenses";

// --- Card config ---
const ALL_CARDS = [
  { id: "summary", label: "Revenue & Profit Summary" },
  { id: "chart", label: "Profit Trend (30 days)" },
  { id: "held_orders", label: "Held Orders" },
  { id: "recent_orders", label: "Recent Orders" },
  { id: "alerts", label: "Alerts" },
  { id: "missing_cogs", label: "Missing COGS Warning" },
] as const;

type CardId = (typeof ALL_CARDS)[number]["id"];
const DEFAULT_CARDS: CardId[] = [
  "summary",
  "chart",
  "held_orders",
  "recent_orders",
  "alerts",
  "missing_cogs",
];

interface ChartPoint {
  date: string;
  profit: number;
  revenue: number;
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

interface AlertItem {
  id: string;
  type: string;
  message: string;
  createdAt: string;
}

interface RecentOrder {
  id: string;
  shopifyOrderName: string;
  totalPrice: number;
  totalDiscounts: number;
  adSpendAllocated: number;
  netProfit: number;
  marginPercent: number;
  isHeld: boolean;
  cogsComplete: boolean;
  financialStatus: string | null;
  shopifyCreatedAt: string;
  currency: string;
}

interface LoaderData {
  summary: {
    totalRevenue: number;
    totalNetProfit: number;
    avgMargin: number;
    orderCount: number;
    heldCount: number;
    monthlyExpenses: number;
  };
  chartData: ChartPoint[];
  heldOrders: HeldOrder[];
  recentOrders: RecentOrder[];
  alerts: AlertItem[];
  missingCogsCount: number;
  visibleCards: CardId[];
  hasOrders: boolean;
  shop: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // High-performance parallel queries
  const [
    thirtyDaysTotals,
    ordersForChart,
    heldOrders,
    unresolvedAlerts,
    missingCogs,
    settings,
    expenses,
    totalOrderCount,
    recentOrdersList,
  ] = await Promise.all([
    // 1. Let the DB do the heavy math
    db.order.aggregate({
      where: { shop, shopifyCreatedAt: { gte: thirtyDaysAgo } },
      _sum: { totalPrice: true, netProfit: true },
      _avg: { marginPercent: true },
      _count: { id: true },
    }),
    // 2. Fetch minimal fields for chart grouping (Prevents Out of Memory crashes)
    db.order.findMany({
      where: { shop, shopifyCreatedAt: { gte: thirtyDaysAgo } },
      select: { shopifyCreatedAt: true, totalPrice: true, netProfit: true },
    }),
    db.order.findMany({
      where: { shop, isHeld: true },
      orderBy: { shopifyCreatedAt: "desc" },
      take: 10,
    }),
    db.alert.findMany({
      where: { shop, isRead: false },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    db.productVariant.count({
      where: { product: { shop }, effectiveCost: null },
    }),
    db.shopSettings.findUnique({ where: { shop } }),
    db.expense?.findMany({
      where: { shop, isActive: true },
    }).catch(() => []),
    db.order.count({ where: { shop } }),
    // 3. Fetch full details only for the 5 most recent orders
    db.order.findMany({
      where: { shop, shopifyCreatedAt: { gte: thirtyDaysAgo } },
      orderBy: { shopifyCreatedAt: "desc" },
      take: 5,
    }),
  ]);

  // Summary Math
  const monthlyExpenses = (expenses ?? []).reduce(
    (s: number, e: { amount: number; interval: string }) =>
      s + toMonthly(e.amount, e.interval),
    0
  );
  
  const totalRevenue = thirtyDaysTotals._sum.totalPrice || 0;
  const ordersNetProfit = thirtyDaysTotals._sum.netProfit || 0;
  const totalNetProfit = ordersNetProfit - monthlyExpenses;
  const avgMargin = thirtyDaysTotals._avg.marginPercent || 0;

  // Chart data: O(N) grouping using a Map for massive speed improvements
  const chartMap = new Map<string, ChartPoint>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    chartMap.set(dateStr, {
      date: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
      profit: 0,
      revenue: 0,
    });
  }

  for (const o of ordersForChart) {
    const dStr = o.shopifyCreatedAt.toISOString().split("T")[0];
    if (chartMap.has(dStr)) {
      const entry = chartMap.get(dStr)!;
      entry.profit += o.netProfit;
      entry.revenue += o.totalPrice;
    }
  }

  const chartData = Array.from(chartMap.values()).map(point => ({
    ...point,
    profit: parseFloat(point.profit.toFixed(2)),
    revenue: parseFloat(point.revenue.toFixed(2)),
  }));

  // Parse Settings
  let visibleCards: CardId[] = DEFAULT_CARDS;
  if ((settings as any)?.dashboardCards) {
    try {
      visibleCards = JSON.parse((settings as any).dashboardCards);
    } catch {
      visibleCards = DEFAULT_CARDS;
    }
  }

  return json({
    summary: {
      totalRevenue,
      totalNetProfit,
      avgMargin,
      orderCount: thirtyDaysTotals._count.id || 0,
      heldCount: heldOrders.length,
      monthlyExpenses,
    },
    chartData,
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
    recentOrders: recentOrdersList.map((o) => ({
      id: o.id,
      shopifyOrderName: o.shopifyOrderName,
      totalPrice: o.totalPrice,
      totalDiscounts: o.totalDiscounts,
      adSpendAllocated: o.adSpendAllocated,
      netProfit: o.netProfit,
      marginPercent: o.marginPercent,
      isHeld: o.isHeld,
      cogsComplete: o.cogsComplete,
      financialStatus: o.financialStatus,
      shopifyCreatedAt: o.shopifyCreatedAt.toISOString(),
      currency: o.currency,
    })),
    alerts: unresolvedAlerts.map((a) => ({
      id: a.id,
      type: a.type,
      message: a.message,
      createdAt: a.createdAt.toISOString(),
    })),
    missingCogsCount: missingCogs,
    visibleCards,
    hasOrders: totalOrderCount > 0,
    shop,
  });
};

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
      const mutationRes = await admin.graphql(
        `#graphql
        mutation releaseHold($id: ID!) {
          fulfillmentOrderReleaseHold(id: $id) {
            fulfillmentOrder { id status }
            userErrors { field message }
          }
        }`,
        { variables: { id: fo.id } }
      );
      const mutationData: any = await mutationRes.json();
      
      // Strict Error Handling from Shopify API
      const errors = mutationData.data?.fulfillmentOrderReleaseHold?.userErrors;
      if (errors && errors.length > 0) {
        console.error("Shopify Hold Release Error:", errors);
        return json({ error: errors[0].message }, { status: 400 });
      }
    }

    await db.order.update({
      where: { id: orderId },
      data: { isHeld: false, heldReason: null },
    });
    return json({ success: true });
  }

  if (intent === "dismissAlert") {
    const alertId = formData.get("alertId") as string;
    await db.alert.update({ where: { id: alertId }, data: { isRead: true } });
    return json({ success: true });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

function fmt(amount: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

function MarginBadge({ margin, cogsComplete }: { margin: number; cogsComplete: boolean }) {
  if (!cogsComplete) return <Badge tone="attention">Incomplete</Badge>;
  if (margin < 0) return <Badge tone="critical">{margin.toFixed(1) + "%"}</Badge>;
  if (margin < 10) return <Badge tone="warning">{margin.toFixed(1) + "%"}</Badge>;
  return <Badge tone="success">{margin.toFixed(1) + "%"}</Badge>;
}

function StatusBadge({ isHeld, financialStatus }: { isHeld: boolean; financialStatus: string | null }) {
  if (financialStatus === "refunded") return <Badge tone="critical">Refunded</Badge>;
  if (financialStatus === "partially_refunded") return <Badge tone="warning">Partial Refund</Badge>;
  if (isHeld) return <Badge tone="warning">On Hold</Badge>;
  return <Badge tone="success">Clear</Badge>;
}

function DashboardSkeleton() {
  return (
    <SkeletonPage title="Dashboard">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <SkeletonDisplayText size="small" />
              <SkeletonBodyText lines={2} />
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <SkeletonBodyText lines={8} />
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
             <Card><SkeletonBodyText lines={5} /></Card>
             <Card><SkeletonBodyText lines={5} /></Card>
          </InlineGrid>
        </Layout.Section>
      </Layout>
    </SkeletonPage>
  );
}

export default function Dashboard() {
  const {
    summary,
    chartData,
    heldOrders,
    recentOrders,
    alerts,
    missingCogsCount,
    visibleCards: initialVisibleCards,
    hasOrders,
  } = useLoaderData() as LoaderData;

  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";
  const isSubmitting = navigation.state === "submitting";

  const [visibleCards, setVisibleCards] = useState<CardId[]>(initialVisibleCards);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [draftCards, setDraftCards] = useState<CardId[]>(initialVisibleCards);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

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
                  Your first order will be calculated automatically the moment
                  it comes in. In the meantime, make sure your product costs
                  are set up so margins are accurate from day one.
                </p>
              </EmptyState>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const isVisible = (id: CardId) => visibleCards.includes(id);

  const handleOpenCustomize = () => {
    setDraftCards([...visibleCards]);
    setCustomizeOpen(true);
  };

  const handleToggleCard = (id: CardId, checked: boolean) => {
    setDraftCards((prev) =>
      checked ? [...prev, id] : prev.filter((c) => c !== id)
    );
  };

  const handleSaveConfig = () => {
    const newCards = ALL_CARDS.map((c) => c.id).filter((id) =>
      draftCards.includes(id)
    ) as CardId[];
    setVisibleCards(newCards);
    submit(
      { intent: "saveDashboardConfig", cards: JSON.stringify(newCards) },
      { method: "POST" }
    );
    setCustomizeOpen(false);
  };

  const handleReleaseHold = (orderId: string) => {
    submit({ intent: "releaseHold", orderId }, { method: "POST" });
  };

  const handleDismissAlert = (alertId: string) => {
    submit({ intent: "dismissAlert", alertId }, { method: "POST" });
  };

  return (
    <Page
      title="Dashboard"
      primaryAction={{
        content: "Customize",
        onAction: handleOpenCustomize,
      }}
    >
      <Layout>
        {/* Row 1: Missing COGS Warning */}
        {isVisible("missing_cogs") && missingCogsCount > 0 && (
          <Layout.Section>
            <Banner
              title={`${missingCogsCount} variant${missingCogsCount > 1 ? "s" : ""} missing cost data`}
              tone="warning"
              action={{ content: "Fix now", url: "/app/products" }}
            >
              <p>
                Orders with these products show incomplete margins and may not trigger holds correctly.
              </p>
            </Banner>
          </Layout.Section>
        )}

        {/* Row 2: Summary Metrics */}
        {isVisible("summary") && (
          <Layout.Section>
            <Card>
              <InlineStack gap="800" wrap={true}>
                {[
                  { label: "Revenue (30d)", value: fmt(summary.totalRevenue), critical: false },
                  { label: "Net Profit (30d)", value: fmt(summary.totalNetProfit), critical: summary.totalNetProfit < 0 },
                  { label: "Avg Margin", value: summary.avgMargin.toFixed(1) + "%", critical: summary.avgMargin < 0 },
                  { label: "Orders", value: String(summary.orderCount), critical: false },
                  { label: "On Hold", value: String(summary.heldCount), critical: summary.heldCount > 0 },
                  { label: "Monthly expenses", value: fmt(summary.monthlyExpenses), critical: false },
                ].map((m) => (
                  <BlockStack key={m.label} gap="100">
                    <Text variant="bodySm" as="p" tone="subdued">{m.label}</Text>
                    <Text variant="headingLg" as="p" tone={m.critical ? "critical" : undefined}>{m.value}</Text>
                  </BlockStack>
                ))}
              </InlineStack>
            </Card>
          </Layout.Section>
        )}

        {/* Row 3: Profit Chart */}
        {isVisible("chart") && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Profit trend — last 30 days</Text>
                {mounted ? (
                  <Box minHeight="250px">
                    <ResponsiveContainer width="100%" height={250}>
                      <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e1e3e5" vertical={false} />
                        <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#6d7175' }} interval={6} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: '#6d7175' }} tickFormatter={(v: number) => "$" + v} axisLine={false} tickLine={false} />
                        <Tooltip
                          labelFormatter={(label) => String(label)}
                          contentStyle={{ fontSize: 12, borderRadius: '8px', border: 'none', boxShadow: '0 0 5px rgba(0,0,0,0.1)' }}
                        />
                        <Line type="monotone" dataKey="profit" stroke="#008060" strokeWidth={3} dot={false} activeDot={{ r: 6 }} />
                        <Line type="monotone" dataKey="revenue" stroke="#aee9d1" strokeWidth={2} dot={false} strokeDasharray="4 4" />
                      </LineChart>
                    </ResponsiveContainer>
                    <InlineStack gap="400" align="center">
                      <InlineStack gap="100" blockAlign="center">
                        <Box width="12px" minHeight="3px" background="bg-fill-success" borderRadius="100" />
                        <Text variant="bodySm" as="span" tone="subdued">Net Profit</Text>
                      </InlineStack>
                      <InlineStack gap="100" blockAlign="center">
                        <Box width="12px" minHeight="3px" background="bg-surface-success" borderRadius="100" />
                        <Text variant="bodySm" as="span" tone="subdued">Revenue</Text>
                      </InlineStack>
                    </InlineStack>
                  </Box>
                ) : (
                  <Box minHeight="250px" />
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Row 4: Grid Layout for Widgets */}
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, lg: 2 }} gap="400">
            
            {/* Column A: Recent Orders */}
            {isVisible("recent_orders") && (
              <BlockStack gap="400">
                <Card padding="0">
                  <Box padding="400" borderBlockEndWidth="025" borderColor="border">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text variant="headingMd" as="h2">Recent Orders</Text>
                      <Button variant="plain" url="/app/orders">View all</Button>
                    </InlineStack>
                  </Box>
                  {recentOrders.length === 0 ? (
                    <Box padding="400"><Text as="p" tone="subdued">No orders in the last 30 days.</Text></Box>
                  ) : (
                    <DataTable
                      columnContentTypes={["text", "numeric", "text"]}
                      headings={["Order", "Net Profit", "Margin"]}
                      rows={recentOrders.map((o) => [
                        <Text variant="bodyMd" fontWeight="semibold" as="span" key={o.id}>{o.shopifyOrderName}</Text>,
                        <Text as="span" tone={o.netProfit < 0 ? "critical" : undefined} fontWeight="semibold" key={o.id + "-profit"}>
                          {fmt(o.netProfit, o.currency)}
                        </Text>,
                        <MarginBadge key={o.id + "-margin"} margin={o.marginPercent} cogsComplete={o.cogsComplete} />,
                      ])}
                    />
                  )}
                </Card>
              </BlockStack>
            )}

            {/* Column B: Held Orders & Alerts stacked vertically */}
            <BlockStack gap="400">
              {isVisible("held_orders") && (
                <Card padding="0">
                  <Box padding="400" borderBlockEndWidth="025" borderColor="border">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text variant="headingMd" as="h2">Held Orders</Text>
                      {heldOrders.length > 0 && <Badge tone="warning">{String(heldOrders.length)}</Badge>}
                    </InlineStack>
                  </Box>
                  {heldOrders.length === 0 ? (
                    <Box padding="400">
                      <EmptyState heading="All clear" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                        <p>No orders are currently on hold.</p>
                      </EmptyState>
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
                            <InlineStack gap="400" blockAlign="center">
                              <Badge tone={order.marginPercent < 0 ? "critical" : "warning"}>{order.marginPercent.toFixed(1) + "%"}</Badge>
                              <Button variant="primary" size="slim" loading={isSubmitting} onClick={() => handleReleaseHold(order.id)}>
                                Release
                              </Button>
                            </InlineStack>
                          </InlineStack>
                        </ResourceItem>
                      )}
                    />
                  )}
                </Card>
              )}

              {isVisible("alerts") && alerts.length > 0 && (
                <Card padding="0">
                  <Box padding="400" borderBlockEndWidth="025" borderColor="border">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text variant="headingMd" as="h2">Alerts</Text>
                      <Badge tone="critical">{String(alerts.length)}</Badge>
                    </InlineStack>
                  </Box>
                  <ResourceList
                    resourceName={{ singular: "alert", plural: "alerts" }}
                    items={alerts}
                    renderItem={(alert: AlertItem) => (
                      <ResourceItem id={alert.id} onClick={() => {}} accessibilityLabel={alert.message}>
                        <InlineStack align="space-between" blockAlign="center">
                          <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center">
                              <Badge tone={alert.type === "negative_profit" ? "critical" : "warning"}>
                                {alert.type === "negative_profit" ? "Loss" : "Low margin"}
                              </Badge>
                              <Text variant="bodyMd" as="p">{alert.message}</Text>
                            </InlineStack>
                            <Text variant="bodySm" as="p" tone="subdued">
                              {new Date(alert.createdAt).toLocaleString("en-GB")}
                            </Text>
                          </BlockStack>
                          <Button variant="plain" onClick={() => handleDismissAlert(alert.id)}>Dismiss</Button>
                        </InlineStack>
                      </ResourceItem>
                    )}
                  />
                </Card>
              )}
            </BlockStack>

          </InlineGrid>
        </Layout.Section>
      </Layout>

      {/* Customize modal */}
      <Modal
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        title="Customize dashboard"
        primaryAction={{ content: "Save", onAction: handleSaveConfig }}
        secondaryActions={[{ content: "Cancel", onAction: () => setCustomizeOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" tone="subdued">Choose which cards to show on your dashboard.</Text>
            {ALL_CARDS.map((card) => (
              <Checkbox
                key={card.id}
                label={card.label}
                checked={draftCards.includes(card.id)}
                onChange={(checked) => handleToggleCard(card.id, checked)}
              />
            ))}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
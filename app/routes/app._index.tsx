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
  netProfit: number;
  marginPercent: number;
  isHeld: boolean;
  cogsComplete: boolean;
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
  shop: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [orders30d, heldOrders, unresolvedAlerts, missingCogs, settings, expenses] =
    await Promise.all([
      db.order.findMany({
        where: { shop, shopifyCreatedAt: { gte: thirtyDaysAgo } },
        orderBy: { shopifyCreatedAt: "desc" },
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
      (db as any).expense?.findMany({
  where: { shop, isActive: true },
}).catch(() => []),
    ]);

  const totalRevenue = orders30d.reduce((s, o) => s + o.totalPrice, 0);
  const ordersNetProfit = orders30d.reduce((s, o) => s + o.netProfit, 0);
  const monthlyExpenses = (expenses ?? []).reduce(
  (s: number, e: { amount: number; interval: string }) =>
    s + toMonthly(e.amount, e.interval),
  0
);
  const totalNetProfit = ordersNetProfit - monthlyExpenses;
  const avgMargin =
    orders30d.length > 0
      ? orders30d.reduce((s, o) => s + o.marginPercent, 0) / orders30d.length
      : 0;

  // Chart data
  const chartData: ChartPoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];
    const dayOrders = orders30d.filter(
      (o) => o.shopifyCreatedAt.toISOString().split("T")[0] === dateStr
    );
    chartData.push({
      date: new Date(dateStr).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
      }),
      profit: parseFloat(
        dayOrders.reduce((s, o) => s + o.netProfit, 0).toFixed(2)
      ),
      revenue: parseFloat(
        dayOrders.reduce((s, o) => s + o.totalPrice, 0).toFixed(2)
      ),
    });
  }

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
      orderCount: orders30d.length,
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
    recentOrders: orders30d.slice(0, 5).map((o) => ({
      id: o.id,
      shopifyOrderName: o.shopifyOrderName,
      totalPrice: o.totalPrice,
      netProfit: o.netProfit,
      marginPercent: o.marginPercent,
      isHeld: o.isHeld,
      cogsComplete: o.cogsComplete,
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
      await admin.graphql(
        `#graphql
        mutation releaseHold($id: ID!) {
          fulfillmentOrderReleaseHold(id: $id) {
            fulfillmentOrder { id status }
          }
        }`,
        { variables: { id: fo.id } }
      );
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

function MarginBadge({
  margin,
  cogsComplete,
}: {
  margin: number;
  cogsComplete: boolean;
}) {
  if (!cogsComplete) return <Badge tone="attention">Incomplete</Badge>;
  if (margin < 0) return <Badge tone="critical">{margin.toFixed(1) + "%"}</Badge>;
  if (margin < 10) return <Badge tone="warning">{margin.toFixed(1) + "%"}</Badge>;
  return <Badge tone="success">{margin.toFixed(1) + "%"}</Badge>;
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
    shop,
  } = useLoaderData() as LoaderData;

  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [visibleCards, setVisibleCards] = useState<CardId[]>(initialVisibleCards);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [draftCards, setDraftCards] = useState<CardId[]>(initialVisibleCards);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

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
        {/* Missing COGS */}
        {isVisible("missing_cogs") && missingCogsCount > 0 && (
          <Layout.Section>
            <Banner
              title={`${missingCogsCount} variant${missingCogsCount > 1 ? "s" : ""} missing cost data`}
              tone="warning"
              action={{ content: "Fix now", url: "/app/products" }}
            >
              <p>
                Orders with these products show incomplete margins and may not
                trigger holds correctly.
              </p>
            </Banner>
          </Layout.Section>
        )}

        {/* Summary */}
        {isVisible("summary") && (
          <Layout.Section>
            <Card>
              <InlineStack gap="800" wrap={true}>
                {[
                  {
                    label: "Revenue (30d)",
                    value: fmt(summary.totalRevenue),
                    critical: false,
                  },
                  {
                    label: "Net Profit (30d)",
                    value: fmt(summary.totalNetProfit),
                    critical: summary.totalNetProfit < 0,
                  },
                  {
                    label: "Avg Margin",
                    value: summary.avgMargin.toFixed(1) + "%",
                    critical: summary.avgMargin < 0,
                  },
                  {
                    label: "Orders",
                    value: String(summary.orderCount),
                    critical: false,
                  },
                  {
                    label: "On Hold",
                    value: String(summary.heldCount),
                    critical: summary.heldCount > 0,
                  },
                  {
                    label: "Monthly expenses",
                    value: fmt(summary.monthlyExpenses),
                    critical: false,
                  },
                ].map((m) => (
                  <BlockStack key={m.label} gap="100">
                    <Text variant="bodySm" as="p" tone="subdued">
                      {m.label}
                    </Text>
                    <Text
                      variant="headingLg"
                      as="p"
                      tone={m.critical ? "critical" : undefined}
                    >
                      {m.value}
                    </Text>
                  </BlockStack>
                ))}
              </InlineStack>
            </Card>
          </Layout.Section>
        )}

        {/* Chart */}
        {isVisible("chart") && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">
                  Profit trend — last 30 days
                </Text>
                {mounted ? (
                  <Box minHeight="250px">
                    <ResponsiveContainer width="100%" height={250}>
                      <LineChart
                        data={chartData}
                        margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis
                          dataKey="date"
                          tick={{ fontSize: 11 }}
                          interval={6}
                        />
                        <YAxis
                          tick={{ fontSize: 11 }}
                          tickFormatter={(v: number) => "$" + v}
                        />
                        <Tooltip
                          labelFormatter={(label) => String(label)}
                          contentStyle={{ fontSize: 12 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="profit"
                          stroke="#008060"
                          strokeWidth={2}
                          dot={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="revenue"
                          stroke="#b2d8cd"
                          strokeWidth={1.5}
                          dot={false}
                          strokeDasharray="4 4"
                        />
                      </LineChart>
                    </ResponsiveContainer>
                    <InlineStack gap="400" align="center">
                      <InlineStack gap="100" blockAlign="center">
                        <Box
                          width="12px"
                          minHeight="3px"
                          background="bg-fill-success"
                          borderRadius="100"
                        />
                        <Text variant="bodySm" as="span" tone="subdued">
                          Net Profit
                        </Text>
                      </InlineStack>
                      <InlineStack gap="100" blockAlign="center">
                        <Box
                          width="12px"
                          minHeight="3px"
                          background="bg-fill-magic-secondary"
                          borderRadius="100"
                        />
                        <Text variant="bodySm" as="span" tone="subdued">
                          Revenue
                        </Text>
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

        {/* Held orders */}
        {isVisible("held_orders") && (
          <Layout.Section>
            <Card padding="0">
              <Box
                padding="400"
                borderBlockEndWidth="025"
                borderColor="border"
              >
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingMd" as="h2">
                    Held Orders
                  </Text>
                  {heldOrders.length > 0 && (
                    <Badge tone="warning">{String(heldOrders.length)}</Badge>
                  )}
                </InlineStack>
              </Box>
              {heldOrders.length === 0 ? (
                <Box padding="400">
                  <EmptyState
                    heading="All clear"
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <p>No orders are currently on hold.</p>
                  </EmptyState>
                </Box>
              ) : (
                <ResourceList
                  resourceName={{
                    singular: "held order",
                    plural: "held orders",
                  }}
                  items={heldOrders}
                  renderItem={(order: HeldOrder) => (
                    <ResourceItem
                      id={order.id}
                      onClick={() => {}}
                      accessibilityLabel={order.shopifyOrderName}
                    >
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <Text variant="bodyMd" fontWeight="semibold" as="p">
                            {order.shopifyOrderName}
                          </Text>
                          <Text variant="bodySm" as="p" tone="subdued">
                            {order.heldReason ?? "Held for review"}
                          </Text>
                        </BlockStack>
                        <InlineStack gap="400" blockAlign="center">
                          <Badge
                            tone={
                              order.marginPercent < 0 ? "critical" : "warning"
                            }
                          >
                            {order.marginPercent.toFixed(1) + "%"}
                          </Badge>
                          <Text variant="bodyMd" as="p">
                            {fmt(order.totalPrice, order.currency)}
                          </Text>
                          <Button
                            variant="primary"
                            size="slim"
                            loading={isSubmitting}
                            onClick={() => handleReleaseHold(order.id)}
                          >
                            Release
                          </Button>
                        </InlineStack>
                      </InlineStack>
                    </ResourceItem>
                  )}
                />
              )}
            </Card>
          </Layout.Section>
        )}

        {/* Recent orders */}
        {isVisible("recent_orders") && (
          <Layout.Section>
            <Card padding="0">
              <Box
                padding="400"
                borderBlockEndWidth="025"
                borderColor="border"
              >
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingMd" as="h2">
                    Recent Orders
                  </Text>
                  <Button variant="plain" url="/app/orders">
                    View all
                  </Button>
                </InlineStack>
              </Box>
              {recentOrders.length === 0 ? (
                <Box padding="400">
                  <Text as="p" tone="subdued">
                    No orders yet. Orders will appear here as they come in.
                  </Text>
                </Box>
              ) : (
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "numeric",
                    "numeric",
                    "text",
                    "text",
                  ]}
                  headings={[
                    "Order",
                    "Date",
                    "Revenue",
                    "Net Profit",
                    "Margin",
                    "Status",
                  ]}
                  rows={recentOrders.map((o) => [
                    <Text
                      variant="bodyMd"
                      fontWeight="semibold"
                      as="span"
                      key={o.id}
                    >
                      {o.shopifyOrderName}
                    </Text>,
                    new Date(o.shopifyCreatedAt).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                    }),
                    fmt(o.totalPrice, o.currency),
                    <Text
                      as="span"
                      tone={o.netProfit < 0 ? "critical" : undefined}
                      fontWeight="semibold"
                      key={o.id + "-profit"}
                    >
                      {fmt(o.netProfit, o.currency)}
                    </Text>,
                    <MarginBadge
                      key={o.id + "-margin"}
                      margin={o.marginPercent}
                      cogsComplete={o.cogsComplete}
                    />,
                    o.isHeld ? (
                      <Badge tone="warning" key={o.id + "-status"}>
                        On Hold
                      </Badge>
                    ) : (
                      <Badge tone="success" key={o.id + "-status"}>
                        Clear
                      </Badge>
                    ),
                  ])}
                />
              )}
            </Card>
          </Layout.Section>
        )}

        {/* Alerts */}
        {isVisible("alerts") && alerts.length > 0 && (
          <Layout.Section>
            <Card padding="0">
              <Box
                padding="400"
                borderBlockEndWidth="025"
                borderColor="border"
              >
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingMd" as="h2">
                    Alerts
                  </Text>
                  <Badge tone="critical">{String(alerts.length)}</Badge>
                </InlineStack>
              </Box>
              <ResourceList
                resourceName={{ singular: "alert", plural: "alerts" }}
                items={alerts}
                renderItem={(alert: AlertItem) => (
                  <ResourceItem
                    id={alert.id}
                    onClick={() => {}}
                    accessibilityLabel={alert.message}
                  >
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Badge
                            tone={
                              alert.type === "negative_profit"
                                ? "critical"
                                : "warning"
                            }
                          >
                            {alert.type === "negative_profit"
                              ? "Loss"
                              : "Low margin"}
                          </Badge>
                          <Text variant="bodyMd" as="p">
                            {alert.message}
                          </Text>
                        </InlineStack>
                        <Text variant="bodySm" as="p" tone="subdued">
                          {new Date(alert.createdAt).toLocaleString("en-GB")}
                        </Text>
                      </BlockStack>
                      <Button
                        variant="plain"
                        onClick={() => handleDismissAlert(alert.id)}
                      >
                        Dismiss
                      </Button>
                    </InlineStack>
                  </ResourceItem>
                )}
              />
            </Card>
          </Layout.Section>
        )}
      </Layout>

      {/* Customize modal */}
      <Modal
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        title="Customize dashboard"
        primaryAction={{
          content: "Save",
          onAction: handleSaveConfig,
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setCustomizeOpen(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" tone="subdued">
              Choose which cards to show on your dashboard.
            </Text>
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
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigation, useSearchParams } from "react-router";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Text,
  Badge,
  Box,
  InlineStack,
  BlockStack,
  Tooltip,
  EmptyState,
  SkeletonPage,
  SkeletonBodyText,
  SkeletonDisplayText,
  Button,
  InlineGrid,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PAGE_SIZE = 25;

interface OrderRow {
  id: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  shopifyCreatedAt: string;
  currency: string;
  totalPrice: number;
  totalDiscounts: number;
  cogs: number;
  transactionFee: number;
  shippingCost: number;
  adSpendAllocated: number;
  grossProfit: number;
  netProfit: number;
  marginPercent: number;
  isHeld: boolean;
  cogsComplete: boolean;
  financialStatus: string | null;
}

interface Summary {
  totalRevenue: number;
  totalNetProfit: number;
  totalDiscounts: number;
  avgMargin: number;
  orderCount: number;
  heldCount: number;
  missingCogsCount: number;
  refundedCount: number;
  partialRefundCount: number;
}

interface LoaderData {
  orders: OrderRow[];
  summary: Summary;
  dateFrom: string;
  dateTo: string;
  status: string;
  profitability: string;
  page: number;
  totalPages: number;
  totalCount: number;
  shop: string;
}

function toDateString(date: Date) {
  return date.toISOString().split("T")[0];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const url = new URL(request.url);

  // Default: last 30 days
  const defaultTo = toDateString(new Date());
  const defaultFrom = toDateString(new Date(Date.now() - 30 * 86400000));

  const dateFrom = url.searchParams.get("from") || defaultFrom;
  const dateTo = url.searchParams.get("to") || defaultTo;
  const status = url.searchParams.get("status") || "all";
  const profitability = url.searchParams.get("profitability") || "all";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

  const since = new Date(dateFrom + "T00:00:00.000Z");
  const until = new Date(dateTo + "T23:59:59.999Z");

  const where: any = {
    shop,
    shopifyCreatedAt: { gte: since, lte: until },
  };

  if (status === "held") {
    where.isHeld = true;
  } else if (status === "refunded") {
    where.financialStatus = "refunded";
  } else if (status === "partially_refunded") {
    where.financialStatus = "partially_refunded";
  } else if (status === "paid") {
    where.financialStatus = "paid";
  } else if (status === "pending") {
    where.financialStatus = "pending";
  } else if (status === "cancelled") {
    where.financialStatus = { in: ["voided", "cancelled"] };
  } else if (status === "clear") {
    where.isHeld = false;
    where.financialStatus = { notIn: ["refunded", "partially_refunded"] };
  }

  if (profitability === "profitable") {
    where.netProfit = { gte: 0 };
  } else if (profitability === "loss") {
    where.netProfit = { lt: 0 };
  }

  const totalCount = await db.order.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);

  const orders = await db.order.findMany({
    where,
    orderBy: { shopifyCreatedAt: "desc" },
    skip: (currentPage - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  // Summary over full date range (no filter)
  const allOrders = await db.order.findMany({
    where: { shop, shopifyCreatedAt: { gte: since, lte: until } },
    select: {
      totalPrice: true,
      netProfit: true,
      marginPercent: true,
      totalDiscounts: true,
      isHeld: true,
      cogsComplete: true,
      financialStatus: true,
    },
  });

  const summary: Summary = {
    totalRevenue: allOrders.reduce((s, o) => s + o.totalPrice, 0),
    totalNetProfit: allOrders.reduce((s, o) => s + o.netProfit, 0),
    totalDiscounts: allOrders.reduce((s, o) => s + o.totalDiscounts, 0),
    avgMargin:
      allOrders.length > 0
        ? allOrders.reduce((s, o) => s + o.marginPercent, 0) / allOrders.length
        : 0,
    orderCount: allOrders.length,
    heldCount: allOrders.filter((o) => o.isHeld).length,
    missingCogsCount: allOrders.filter((o) => !o.cogsComplete).length,
    refundedCount: allOrders.filter((o) => o.financialStatus === "refunded").length,
    partialRefundCount: allOrders.filter((o) => o.financialStatus === "partially_refunded").length,
  };

  return json({
    orders: orders.map((o) => ({
      id: o.id,
      shopifyOrderId: o.shopifyOrderId,
      shopifyOrderName: o.shopifyOrderName,
      shopifyCreatedAt: o.shopifyCreatedAt.toISOString(),
      currency: o.currency,
      totalPrice: o.totalPrice,
      totalDiscounts: o.totalDiscounts,
      cogs: o.cogs,
      transactionFee: o.transactionFee,
      shippingCost: o.shippingCost,
      adSpendAllocated: o.adSpendAllocated,
      grossProfit: o.grossProfit,
      netProfit: o.netProfit,
      marginPercent: o.marginPercent,
      isHeld: o.isHeld,
      cogsComplete: o.cogsComplete,
      financialStatus: o.financialStatus,
    })),
    summary,
    dateFrom,
    dateTo,
    status,
    profitability,
    page: currentPage,
    totalPages,
    totalCount,
    shop,
  });
};

function formatCurrency(amount: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

function marginBadge(margin: number, cogsComplete: boolean) {
  if (!cogsComplete) return <Badge tone="attention">Incomplete COGS</Badge>;
  if (margin < 0) return <Badge tone="critical">{margin.toFixed(1) + "%"}</Badge>;
  if (margin < 10) return <Badge tone="warning">{margin.toFixed(1) + "%"}</Badge>;
  return <Badge tone="success">{margin.toFixed(1) + "%"}</Badge>;
}

function statusBadge(isHeld: boolean, financialStatus: string | null) {
  if (financialStatus === "refunded") return <Badge tone="critical">Refunded</Badge>;
  if (financialStatus === "partially_refunded") return <Badge tone="warning">Partial Refund</Badge>;
  if (financialStatus === "pending") return <Badge tone="attention">Pending</Badge>;
  if (financialStatus === "voided" || financialStatus === "cancelled") return <Badge>Cancelled</Badge>;
  if (isHeld) return <Badge tone="warning">On Hold</Badge>;
  return <Badge tone="success">Clear</Badge>;
}

function getShopifyOrderUrl(shop: string, shopifyOrderId: string) {
  const numericId = shopifyOrderId.replace("gid://shopify/Order/", "");
  return `https://${shop}/admin/orders/${numericId}`;
}

function OrdersSkeleton() {
  return (
    <SkeletonPage title="Orders">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <SkeletonDisplayText size="small" />
              <SkeletonBodyText lines={1} />
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <SkeletonBodyText lines={10} />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </SkeletonPage>
  );
}

function SummaryCard({ summary }: { summary: Summary }) {
  const metrics = [
    { label: "Revenue", value: formatCurrency(summary.totalRevenue), critical: false },
    { label: "Net Profit", value: formatCurrency(summary.totalNetProfit), critical: summary.totalNetProfit < 0 },
    { label: "Avg Margin", value: summary.avgMargin.toFixed(1) + "%", critical: summary.avgMargin < 0 },
    { label: "Discounts", value: formatCurrency(summary.totalDiscounts), critical: summary.totalDiscounts > 0 },
    { label: "Orders", value: String(summary.orderCount), critical: false },
    { label: "On Hold", value: String(summary.heldCount), critical: summary.heldCount > 0 },
    { label: "Refunded", value: String(summary.refundedCount), critical: summary.refundedCount > 0 },
    { label: "Partial Refund", value: String(summary.partialRefundCount), critical: summary.partialRefundCount > 0 },
    { label: "Missing COGS", value: String(summary.missingCogsCount), critical: summary.missingCogsCount > 0 },
  ];

  return (
    <Card>
      <InlineStack gap="600" wrap={true}>
        {metrics.map((m) => (
          <BlockStack key={m.label} gap="100">
            <Text variant="bodySm" as="p" tone="subdued">{m.label}</Text>
            <Text variant="headingMd" as="p" tone={m.critical ? "critical" : undefined}>
              {m.value}
            </Text>
          </BlockStack>
        ))}
      </InlineStack>
    </Card>
  );
}

export default function OrdersPage() {
  const {
    orders, summary, dateFrom, dateTo, status, profitability,
    page, totalPages, totalCount, shop,
  } = useLoaderData() as LoaderData;

  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  if (isLoading) return <OrdersSkeleton />;

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    if (key !== "page") next.set("page", "1");
    setSearchParams(next);
  };

  const updateDateRange = (from: string, to: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("from", from);
    next.set("to", to);
    next.set("page", "1");
    setSearchParams(next);
  };

  const rows = orders.map((order) => [
    <Button
      key={order.id + "-name"}
      variant="plain"
      url={getShopifyOrderUrl(shop, order.shopifyOrderId)}
      external
    >
      {order.shopifyOrderName}
    </Button>,

    <Text variant="bodySm" as="span" tone="subdued" key={order.id + "-date"}>
      {new Date(order.shopifyCreatedAt).toLocaleDateString("en-GB", {
        day: "numeric", month: "short", year: "numeric",
      })}
    </Text>,

    formatCurrency(order.totalPrice, order.currency),

    order.totalDiscounts > 0 ? (
      <Text as="span" tone="caution" key={order.id + "-disc"}>
        {"-" + formatCurrency(order.totalDiscounts, order.currency)}
      </Text>
    ) : (
      <Text as="span" tone="subdued" key={order.id + "-disc"}>—</Text>
    ),

    order.cogsComplete ? (
      formatCurrency(order.cogs, order.currency)
    ) : (
      <Tooltip content="Some variants are missing cost data" key={order.id + "-cogs"}>
        <Text as="span" tone="caution">
          {formatCurrency(order.cogs, order.currency) + " ⚠"}
        </Text>
      </Tooltip>
    ),

    formatCurrency(order.transactionFee, order.currency),
    formatCurrency(order.shippingCost, order.currency),

    order.adSpendAllocated > 0
      ? formatCurrency(order.adSpendAllocated, order.currency)
      : <Text as="span" tone="subdued" key={order.id + "-ads"}>—</Text>,

    <Text
      as="span"
      tone={order.netProfit < 0 ? "critical" : undefined}
      fontWeight="semibold"
      key={order.id + "-profit"}
    >
      {formatCurrency(order.netProfit, order.currency)}
    </Text>,

    marginBadge(order.marginPercent, order.cogsComplete),
    statusBadge(order.isHeld, order.financialStatus),
  ]);

  return (
    <Page title="Orders">
      <Layout>
        {/* Filters */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                <TextField
                  label="From"
                  type="date"
                  value={dateFrom}
                  onChange={(v) => updateDateRange(v, dateTo)}
                  autoComplete="off"
                />
                <TextField
                  label="To"
                  type="date"
                  value={dateTo}
                  onChange={(v) => updateDateRange(dateFrom, v)}
                  autoComplete="off"
                />
              </InlineGrid>
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                <div>
                  <Text as="p" variant="bodySm" tone="subdued">Status</Text>
                  <select
                    value={status}
                    onChange={(e) => updateParam("status", e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      borderRadius: "8px",
                      border: "1px solid #c9cccf",
                      fontSize: "14px",
                      marginTop: "4px",
                      background: "#fff",
                      color: "#202223",
                    }}
                  >
                    <option value="all">All statuses</option>
                    <option value="clear">Clear</option>
                    <option value="held">On Hold</option>
                    <option value="paid">Paid</option>
                    <option value="pending">Pending</option>
                    <option value="refunded">Refunded</option>
                    <option value="partially_refunded">Partially Refunded</option>
                    <option value="cancelled">Cancelled / Voided</option>
                  </select>
                </div>
                <div>
                  <Text as="p" variant="bodySm" tone="subdued">Profitability</Text>
                  <select
                    value={profitability}
                    onChange={(e) => updateParam("profitability", e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      borderRadius: "8px",
                      border: "1px solid #c9cccf",
                      fontSize: "14px",
                      marginTop: "4px",
                      background: "#fff",
                      color: "#202223",
                    }}
                  >
                    <option value="all">All orders</option>
                    <option value="profitable">Profitable only</option>
                    <option value="loss">Losses only</option>
                  </select>
                </div>
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Summary */}
        <Layout.Section>
          <SummaryCard summary={summary} />
        </Layout.Section>

        {/* Table */}
        <Layout.Section>
          <Card padding="0">
            {orders.length === 0 ? (
              <EmptyState
                heading="No orders match your filters"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Try adjusting the date range or filters above.</p>
              </EmptyState>
            ) : (
              <BlockStack gap="0">
                <DataTable
                  columnContentTypes={[
                    "text", "text", "numeric", "numeric", "numeric",
                    "numeric", "numeric", "numeric", "numeric", "text", "text",
                  ]}
                  headings={[
                    "Order", "Date", "Revenue", "Discounts", "COGS",
                    "Fees", "Shipping", "Ad Spend", "Net Profit", "Margin", "Status",
                  ]}
                  rows={rows}
                />
                <Box padding="400" borderBlockStartWidth="025" borderColor="border">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="bodySm" as="p" tone="subdued">
                      {`Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, totalCount)} of ${totalCount} orders`}
                      {summary.missingCogsCount > 0 ? " · ⚠ = incomplete COGS" : ""}
                    </Text>
                    <InlineStack gap="200" blockAlign="center">
                      <Text variant="bodySm" as="span" tone="subdued">
                        {`Page ${page} of ${totalPages}`}
                      </Text>
                      <Button
                        disabled={page <= 1}
                        onClick={() => updateParam("page", String(page - 1))}
                        size="slim"
                      >
                        Previous
                      </Button>
                      <Button
                        disabled={page >= totalPages}
                        onClick={() => updateParam("page", String(page + 1))}
                        size="slim"
                      >
                        Next
                      </Button>
                    </InlineStack>
                  </InlineStack>
                </Box>
              </BlockStack>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
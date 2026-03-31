import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "react-router";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Text,
  Badge,
  Select,
  Box,
  InlineStack,
  BlockStack,
  Tooltip,
  EmptyState,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

interface OrderRow {
  id: string;
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
}

interface LoaderData {
  orders: OrderRow[];
  summary: Summary;
  range: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const url = new URL(request.url);
  const range = url.searchParams.get("range") || "30";
  const days = parseInt(range, 10);

  const since = new Date();
  since.setDate(since.getDate() - days);

  const orders = await db.order.findMany({
    where: { shop, shopifyCreatedAt: { gte: since } },
    orderBy: { shopifyCreatedAt: "desc" },
    take: 100,
  });

  const summary: Summary = {
    totalRevenue: orders.reduce((s, o) => s + o.totalPrice, 0),
    totalNetProfit: orders.reduce((s, o) => s + o.netProfit, 0),
    totalDiscounts: orders.reduce((s, o) => s + o.totalDiscounts, 0),
    avgMargin:
      orders.length > 0
        ? orders.reduce((s, o) => s + o.marginPercent, 0) / orders.length
        : 0,
    orderCount: orders.length,
    heldCount: orders.filter((o) => o.isHeld).length,
    missingCogsCount: orders.filter((o) => !o.cogsComplete).length,
  };

  return json({ orders, summary, range });
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

function SummaryCard({ summary }: { summary: Summary }) {
  const metrics = [
    { label: "Revenue", value: formatCurrency(summary.totalRevenue), critical: false },
    { label: "Net Profit", value: formatCurrency(summary.totalNetProfit), critical: summary.totalNetProfit < 0 },
    { label: "Avg Margin", value: summary.avgMargin.toFixed(1) + "%", critical: summary.avgMargin < 0 },
    { label: "Total Discounts", value: formatCurrency(summary.totalDiscounts), critical: summary.totalDiscounts > 0 },
    { label: "Orders", value: String(summary.orderCount), critical: false },
    { label: "On Hold", value: String(summary.heldCount), critical: summary.heldCount > 0 },
    { label: "Missing COGS", value: String(summary.missingCogsCount), critical: summary.missingCogsCount > 0 },
  ];

  return (
    <Card>
      <InlineStack gap="800" wrap={true}>
        {metrics.map((m) => (
          <BlockStack key={m.label} gap="100">
            <Text variant="bodySm" as="p" tone="subdued">
              {m.label}
            </Text>
            <Text
              variant="headingMd"
              as="p"
              tone={m.critical ? "critical" : undefined}
            >
              {m.value}
            </Text>
          </BlockStack>
        ))}
      </InlineStack>
    </Card>
  );
}

export default function OrdersPage() {
  const { orders, summary, range } = useLoaderData() as LoaderData;
  const [searchParams, setSearchParams] = useSearchParams();

  const handleRangeChange = (value: string) => {
    setSearchParams({ range: value });
  };

  const rows = orders.map((order) => [
    <Text variant="bodyMd" fontWeight="semibold" as="span" key={order.id}>
      {order.shopifyOrderName}
    </Text>,

    <Text variant="bodySm" as="span" tone="subdued" key={order.id + "-date"}>
      {new Date(order.shopifyCreatedAt).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
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

    order.isHeld ? (
      <Badge tone="warning" key={order.id + "-status"}>On Hold</Badge>
    ) : (
      <Badge tone="success" key={order.id + "-status"}>Clear</Badge>
    ),
  ]);

  return (
    <Page title="Orders">
      <Layout>
        <Layout.Section>
          <InlineStack align="end">
            <Box width="160px">
              <Select
                label="Period"
                labelInline
                options={[
                  { label: "Last 7 days", value: "7" },
                  { label: "Last 30 days", value: "30" },
                  { label: "Last 90 days", value: "90" },
                ]}
                value={range}
                onChange={handleRangeChange}
              />
            </Box>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <SummaryCard summary={summary} />
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            {orders.length === 0 ? (
              <EmptyState
                heading="No orders in this period"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Orders will appear here as they come in.</p>
              </EmptyState>
            ) : (
              <BlockStack gap="200">
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                    "text",
                    "text",
                  ]}
                  headings={[
                    "Order",
                    "Date",
                    "Revenue",
                    "Discounts",
                    "COGS",
                    "Fees",
                    "Shipping",
                    "Ad Spend",
                    "Net Profit",
                    "Margin",
                    "Status",
                  ]}
                  rows={rows}
                />
                <Box padding="400">
                  <Text variant="bodySm" as="p" tone="subdued">
                    {"Showing up to 100 orders. Margins marked ⚠ have incomplete COGS — go to Products to fix."}
                  </Text>
                </Box>
              </BlockStack>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
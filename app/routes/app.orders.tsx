// app/routes/app.orders.tsx

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigation, useSearchParams, useNavigate, useLocation, useFetcher } from "react-router";
import { useState, useEffect } from "react";
import {
  Page, Layout, Card, DataTable, Text, Badge, Box, InlineStack,
  BlockStack, Tooltip, EmptyState, Button, InlineGrid, TextField,
  Select, SkeletonBodyText, SkeletonDisplayText, Divider,
} from "@shopify/polaris";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import { DateRangePicker, loadFromStorage } from "../components/DateRangePicker";
import db from "../db.server";

const PAGE_SIZE = 25;

// ── Types ─────────────────────────────────────────────────────────────────────
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
  // New: dominant cost driver per order
  topCostReason: string;
  // New: how many loss orders in the period share this reason
  repeatLossCount: number;
}

interface LossSummary {
  count: number;
  totalLoss: number;
}

interface ActionEntry {
  id: string;
  message: string;
  tone: "critical" | "caution" | "info";
  buttonLabel: string;
  filterKey: string;
  filterValue: string;
  priorityScore: number;
  group: "leakage" | "data" | "operations";
  recoverable: number | null;
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
  lossSummary: LossSummary;
}

interface LoaderData {
  orders: OrderRow[];
  summary: Summary;
  worstOrders: { name: string; netProfit: number; currency: string }[];
  dateFrom: string;
  dateTo: string;
  status: string;
  profitability: string;
  cogsFilter: string;
  reason: string; // new: reason filter
  page: number;
  totalPages: number;
  totalCount: number;
  shop: string;
}

// ── Helpers (server-side) ─────────────────────────────────────────────────────
function toDateString(date: Date) {
  return date.toISOString().split("T")[0];
}

// New: compute dominant cost driver for an order
function getTopCostReason(o: {
  adSpendAllocated: number;
  cogs: number;
  shippingCost: number;
  transactionFee: number;
}): string {
  return [
    { label: "Ads", value: o.adSpendAllocated ?? 0 },
    { label: "COGS", value: o.cogs ?? 0 },
    { label: "Shipping", value: o.shippingCost ?? 0 },
    { label: "Fees", value: o.transactionFee ?? 0 },
  ].reduce((max, c) => c.value > max.value ? c : max).label;
}

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const url = new URL(request.url);
  const defaultTo = toDateString(new Date());
  const defaultFrom = toDateString(new Date(Date.now() - 30 * 86400000));

  const dateFrom = url.searchParams.get("from") || defaultFrom;
  const dateTo = url.searchParams.get("to") || defaultTo;
  const status = url.searchParams.get("status") || "all";
  const profitability = url.searchParams.get("profitability") || "all";
  const cogsFilter = url.searchParams.get("cogs") || "all";
  const reason = url.searchParams.get("reason") || "all"; // new
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

  const since = new Date(dateFrom + "T00:00:00.000Z");
  const until = new Date(dateTo + "T23:59:59.999Z");

  const where: Prisma.OrderWhereInput = {
    shop,
    shopifyCreatedAt: { gte: since, lte: until },
  };

  if (status === "held") where.isHeld = true;
  else if (status === "refunded") where.financialStatus = "refunded";
  else if (status === "partially_refunded") where.financialStatus = "partially_refunded";
  else if (status === "paid") where.financialStatus = "paid";
  else if (status === "pending") where.financialStatus = "pending";
  else if (status === "cancelled") where.financialStatus = { in: ["voided", "cancelled"] };
  else if (status === "clear") {
    where.isHeld = false;
    where.financialStatus = { notIn: ["refunded", "partially_refunded"] };
  }

  if (profitability === "profitable") where.netProfit = { gte: 0 };
  else if (profitability === "loss") where.netProfit = { lt: 0 };
  if (cogsFilter === "missing") where.cogsComplete = false;

  const baseSummaryWhere: Prisma.OrderWhereInput = {
    shop,
    shopifyCreatedAt: { gte: since, lte: until },
  };

  const [
    totalCount, orders, aggregations,
    heldCount, missingCogsCount, refundedCount, partialRefundCount, orderCount,
    lossAgg, worstOrdersRaw,
    // New: fetch all loss orders to compute reason frequency counts
    allLossOrders,
  ] = await Promise.all([
    db.order.count({ where }),
    db.order.findMany({
      where,
      orderBy: { shopifyCreatedAt: "desc" },
      skip: (Math.max(1, page) - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.order.aggregate({
      where: baseSummaryWhere,
      _sum: { totalPrice: true, netProfit: true, totalDiscounts: true },
      _avg: { marginPercent: true },
    }),
    db.order.count({ where: { ...baseSummaryWhere, isHeld: true } }),
    db.order.count({ where: { ...baseSummaryWhere, cogsComplete: false } }),
    db.order.count({ where: { ...baseSummaryWhere, financialStatus: "refunded" } }),
    db.order.count({ where: { ...baseSummaryWhere, financialStatus: "partially_refunded" } }),
    db.order.count({ where: baseSummaryWhere }),
    db.order.aggregate({
      where: { ...baseSummaryWhere, netProfit: { lt: 0 } },
      _sum: { netProfit: true },
      _count: { id: true },
    }),
    db.order.findMany({
      where: { ...baseSummaryWhere, netProfit: { lt: 0 } },
      orderBy: { netProfit: "asc" },
      take: 3,
      select: { shopifyOrderName: true, netProfit: true, currency: true },
    }),
    // New: fetch to compute reason repeat counts for ×2 / ×3 badges
    db.order.findMany({
      where: { ...baseSummaryWhere, netProfit: { lt: 0 } },
      select: {
        adSpendAllocated: true,
        cogs: true,
        shippingCost: true,
        transactionFee: true,
      },
    }),
  ]);

  // Build reason → count map for repeat loss badges
  const reasonCounts = new Map<string, number>();
  for (const o of allLossOrders) {
    const r = getTopCostReason(o);
    reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  }

  // New: apply reason filter in-memory (topCostReason is not a DB field)
  const reasonLabel =
    reason === "ads" ? "Ads"
    : reason === "cogs" ? "COGS"
    : reason === "shipping" ? "Shipping"
    : reason === "fees" ? "Fees"
    : null;

  const filteredOrders = reasonLabel
    ? orders.filter((o) => getTopCostReason(o) === reasonLabel)
    : orders;

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);

  const summary: Summary = {
    totalRevenue: aggregations._sum.totalPrice || 0,
    totalNetProfit: aggregations._sum.netProfit || 0,
    totalDiscounts: aggregations._sum.totalDiscounts || 0,
    avgMargin: aggregations._avg.marginPercent || 0,
    orderCount,
    heldCount,
    missingCogsCount,
    refundedCount,
    partialRefundCount,
    lossSummary: {
      count: lossAgg._count.id || 0,
      totalLoss: lossAgg._sum.netProfit || 0,
    },
  };

  return json({
    orders: filteredOrders.map((o) => ({
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
      // New fields
      topCostReason: getTopCostReason(o),
      repeatLossCount: o.netProfit < 0
        ? (reasonCounts.get(getTopCostReason(o)) ?? 0)
        : 0,
    })),
    summary,
    worstOrders: worstOrdersRaw.map((o) => ({
      name: o.shopifyOrderName,
      netProfit: o.netProfit,
      currency: o.currency,
    })),
    dateFrom,
    dateTo,
    status,
    profitability,
    cogsFilter,
    reason, // new
    page: currentPage,
    totalPages,
    totalCount,
    shop,
  });
};

// ── Action — inline hold release (new) ────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "releaseHold") {
    const orderId = formData.get("orderId") as string;
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) return json({ error: "Order not found" }, { status: 404 });

    const foResponse: any = await admin.graphql(
      `#graphql
       query getFulfillmentOrders($id: ID!) {
         order(id: $id) {
           fulfillmentOrders(first: 1) { nodes { id status } }
         }
       }`,
      { variables: { id: order.shopifyOrderId } }
    );
    const fo = (await foResponse.json()).data?.order?.fulfillmentOrders?.nodes?.[0];

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
      const errors = (await mutRes.json()).data?.fulfillmentOrderReleaseHold?.userErrors;
      if (errors?.length > 0) return json({ error: errors[0].message }, { status: 400 });
    }

    await db.order.update({
      where: { id: orderId },
      data: { isHeld: false, heldReason: null },
    });
    return json({ success: true });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

// ── Helpers (client-side) ─────────────────────────────────────────────────────
function formatCurrency(amount: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency, minimumFractionDigits: 2,
  }).format(amount);
}

function marginBadge(margin: number, cogsComplete: boolean) {
  if (!cogsComplete) return <Badge tone="attention">Incomplete COGS</Badge>;
  if (margin < 0) return <Badge tone="critical">{margin.toFixed(1) + "%"}</Badge>;
  if (margin < 10) return <Badge tone="warning">{margin.toFixed(1) + "%"}</Badge>;
  return <Badge tone="success">{margin.toFixed(1) + "%"}</Badge>;
}

// New: shows dominant cost driver + repeat badge for loss orders
function topCostBadge(reason: string, repeatCount: number, isLoss: boolean) {
  if (!isLoss) return <Text as="span" tone="subdued">—</Text>;

  const icons: Record<string, string> = {
    Ads: "📢",
    COGS: "📦",
    Shipping: "🚚",
    Fees: "💳",
  };

  return (
    <InlineStack gap="100" blockAlign="center">
      <Text as="span" variant="bodySm">{icons[reason] ?? "•"} {reason}</Text>
      {repeatCount >= 3 && (
        <Badge tone="critical">{`×${repeatCount}`}</Badge>
      )}
      {repeatCount >= 2 && repeatCount < 3 && (
        <Badge tone="warning">{`×${repeatCount}`}</Badge>
      )}
    </InlineStack>
  );
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
  return `https://${shop}/admin/orders/${shopifyOrderId.replace("gid://shopify/Order/", "")}`;
}

// ── Inline hold release button (new) ─────────────────────────────────────────
function ReleaseHoldButton({ orderId }: { orderId: string }) {
  const fetcher = useFetcher();
  const isReleasing = fetcher.state === "submitting";
  const released = (fetcher.data as any)?.success;

  if (released) {
    return <Badge tone="success">Released</Badge>;
  }

  return (
    <Button
      size="slim"
      variant="primary"
      loading={isReleasing}
      onClick={() =>
        fetcher.submit(
          { intent: "releaseHold", orderId },
          { method: "POST" }
        )
      }
    >
      Release
    </Button>
  );
}

// ── Date presets (new) ────────────────────────────────────────────────────────

// ── Summary card ──────────────────────────────────────────────────────────────
function SummaryCard({ summary }: { summary: Summary }) {
  const metrics = [
    {
      label: "Revenue",
      value: formatCurrency(summary.totalRevenue),
      critical: false,
      subtitle: null,
    },
    {
      label: "Net Profit",
      value: formatCurrency(summary.totalNetProfit),
      critical: summary.totalNetProfit < 0,
      subtitle:
        summary.totalNetProfit < 0
          ? "Losing money"
          : summary.totalNetProfit === 0
          ? "Break even"
          : "Profitable",
    },
    {
      label: "Avg Margin",
      value: summary.avgMargin.toFixed(1) + "%",
      critical: summary.avgMargin < 0,
      subtitle:
        summary.avgMargin < 0
          ? "Negative margin"
          : summary.avgMargin < 10
          ? "Below target"
          : "Healthy",
    },
    {
      label: "Discounts",
      value: formatCurrency(summary.totalDiscounts),
      critical: false,
      subtitle: summary.totalDiscounts > 0 ? "Revenue reduction" : null,
    },
    { label: "Orders", value: String(summary.orderCount), critical: false, subtitle: null },
    {
      label: "On Hold",
      value: String(summary.heldCount),
      critical: summary.heldCount > 0,
      subtitle: summary.heldCount > 0 ? "Cashflow blocked" : null,
    },
    {
      label: "Refunded",
      value: String(summary.refundedCount),
      critical: summary.refundedCount > 0,
      subtitle: summary.refundedCount > 0 ? "Investigate why" : null,
    },
    {
      label: "Partial Refund",
      value: String(summary.partialRefundCount),
      critical: summary.partialRefundCount > 0,
      subtitle: null,
    },
    {
      label: "Missing COGS",
      value: String(summary.missingCogsCount),
      critical: summary.missingCogsCount > 0,
      subtitle: summary.missingCogsCount > 0 ? "Margins inaccurate" : null,
    },
  ];

  return (
    <Card>
      <InlineStack gap="600" wrap>
        {metrics.map((m) => (
          <BlockStack key={m.label} gap="050">
            <Text variant="bodySm" as="p" tone="subdued">{m.label}</Text>
            <Text variant="headingMd" as="p" tone={m.critical ? "critical" : undefined}>
              {m.value}
            </Text>
            {m.subtitle && (
              <Text
                variant="bodySm"
                as="p"
                tone={m.critical ? "critical" : "subdued"}
              >
                {m.subtitle}
              </Text>
            )}
          </BlockStack>
        ))}
      </InlineStack>
    </Card>
  );
}

// ── Aha hook ──────────────────────────────────────────────────────────────────
function AhaHook({
  summary,
  worstOrders,
}: {
  summary: Summary;
  worstOrders: { name: string; netProfit: number; currency: string }[];
}) {
  const { lossSummary, orderCount, totalRevenue } = summary;
  if (lossSummary.count === 0) return null;

  const lossPercent = orderCount > 0
    ? Math.round((lossSummary.count / orderCount) * 100) : 0;

  const lossVsRevenue = totalRevenue > 0
    ? ((Math.abs(lossSummary.totalLoss) / totalRevenue) * 100).toFixed(1)
    : null;

  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="050">
          <Text variant="headingLg" as="h2" tone="critical">
            {`You lost ${formatCurrency(Math.abs(lossSummary.totalLoss))} in this period`}
          </Text>
          <InlineStack gap="400" wrap>
            <Text variant="bodySm" as="p" tone="subdued">
              {`${lossPercent}% of orders (${lossSummary.count}) are unprofitable`}
            </Text>
            {lossVsRevenue && (
              <Text variant="bodySm" as="p" tone="critical">
                {`${lossVsRevenue}% of your revenue is leaking`}
              </Text>
            )}
          </InlineStack>
        </BlockStack>
        {worstOrders.length > 0 && (
          <>
            <Divider />
            <BlockStack gap="100">
              <Text variant="bodySm" as="p" tone="subdued" fontWeight="semibold">
                Top loss orders
              </Text>
              {worstOrders.map((o, i) => (
                <InlineStack key={o.name} align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="bodySm" as="span" tone="subdued">{`#${i + 1}`}</Text>
                    <Text variant="bodySm" as="span">{o.name}</Text>
                  </InlineStack>
                  <Text variant="bodySm" as="span" tone="critical" fontWeight="semibold">
                    {formatCurrency(o.netProfit, o.currency)}
                  </Text>
                </InlineStack>
              ))}
            </BlockStack>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

// ── Action Center ─────────────────────────────────────────────────────────────
function ActionCenter({
  summary,
  currentSearch,
  navigate,
}: {
  summary: Summary;
  currentSearch: string;
  navigate: (url: string) => void;
}) {
  const buildUrl = (key: string, value: string) => {
    const params = new URLSearchParams(currentSearch);
    // Clear all filter params before setting new one — prevents hidden state bugs
    params.delete("status");
    params.delete("profitability");
    params.delete("cogs");
    params.delete("reason");
    params.set(key, value);
    params.set("page", "1");
    return `/app/orders?${params.toString()}`;
  };

  const actions: ActionEntry[] = [];

  if (summary.lossSummary.count > 0) {
    const impact = Math.abs(summary.lossSummary.totalLoss);
    const recoverable = impact * 0.6;
    actions.push({
      id: "loss",
      group: "leakage",
      message: `${summary.lossSummary.count} orders losing ${formatCurrency(impact)} — losing money, fix pricing or costs`,
      tone: "critical",
      buttonLabel: "Recover lost margin",
      filterKey: "profitability",
      filterValue: "loss",
      priorityScore:
        Math.pow(impact, 1.2) * 0.6 +
        summary.lossSummary.count * 30 * 0.3 +
        100 * 0.1,
      recoverable,
    });
  }

  if (summary.refundedCount > 0) {
    actions.push({
      id: "refunds",
      group: "leakage",
      message: `${summary.refundedCount} customers refunded — investigate why`,
      tone: "critical",
      buttonLabel: "Review refunds",
      filterKey: "status",
      filterValue: "refunded",
      priorityScore:
        summary.refundedCount * 50 * 0.6 +
        summary.refundedCount * 30 * 0.3 +
        50 * 0.1,
      recoverable: null,
    });
  }

  if (summary.totalDiscounts > 0 && summary.totalNetProfit < 0) {
    actions.push({
      id: "discounts",
      group: "leakage",
      message: `${formatCurrency(summary.totalDiscounts)} in discounts — hurting margin`,
      tone: "caution",
      buttonLabel: "Review discount impact",
      filterKey: "profitability",
      filterValue: "loss",
      priorityScore: summary.totalDiscounts * 0.3,
      recoverable: null,
    });
  }

  if (summary.missingCogsCount > 0) {
    actions.push({
      id: "cogs",
      group: "data",
      message: `${summary.missingCogsCount} orders missing product costs — margins are wrong`,
      tone: "caution",
      buttonLabel: "Complete product costs",
      filterKey: "cogs",
      filterValue: "missing",
      priorityScore:
        summary.missingCogsCount * 20 * 0.6 +
        summary.missingCogsCount * 10 * 0.3,
      recoverable: null,
    });
  }

  if (summary.heldCount > 0) {
    actions.push({
      id: "held",
      group: "operations",
      message: `${summary.heldCount} orders on hold — cashflow blocked`,
      tone: "caution",
      buttonLabel: "Unblock cashflow",
      filterKey: "status",
      filterValue: "held",
      priorityScore:
        summary.heldCount * 40 * 0.6 +
        summary.heldCount * 10 * 0.3,
      recoverable: null,
    });
  }

  // Done state — gives closure instead of empty space
  if (actions.length === 0) {
    return (
      <Card>
        <BlockStack gap="100">
          <Text variant="headingSm" as="h3">✅ All good</Text>
          <Text variant="bodySm" as="p" tone="subdued">
            No major issues detected in this period.
          </Text>
        </BlockStack>
      </Card>
    );
  }

  // Tone-weighted sort — critical always beats caution at same score
  const toneWeight: Record<ActionEntry["tone"], number> = {
    critical: 1.3,
    caution: 1.1,
    info: 1.0,
  };
  actions.sort((a, b) =>
    b.priorityScore * toneWeight[b.tone] - a.priorityScore * toneWeight[a.tone]
  );

  const topAction = actions[0];

  const groups: { key: ActionEntry["group"]; label: string; icon: string }[] = [
    { key: "leakage", label: "Revenue Leakage", icon: "🔥" },
    { key: "data", label: "Data Issues", icon: "⚠️" },
    { key: "operations", label: "Operations", icon: "⚙️" },
  ];

  const grouped = groups
    .map((g) => ({ ...g, items: actions.filter((a) => a.group === g.key) }))
    .filter((g) => g.items.length > 0);

  return (
    <Card>
      <BlockStack gap="400">
        <Text variant="headingMd" as="h2">Action Center</Text>

        {/* Recommended next step */}
        <div style={{
          padding: "16px",
          borderRadius: "10px",
          background: topAction.tone === "critical" ? "#fff1f0" : "#fffbe6",
          border: `1px solid ${topAction.tone === "critical" ? "#ffa39e" : "#ffe58f"}`,
        }}>
          <BlockStack gap="200">
            <BlockStack gap="050">
              <Text variant="headingSm" as="h3">Recommended next step</Text>
              <Text variant="bodySm" as="p" tone="critical">
                This is your biggest profit leak right now
              </Text>
            </BlockStack>
            <Text as="p" tone={topAction.tone === "critical" ? "critical" : "caution"}>
              {topAction.message}
            </Text>
            {topAction.recoverable != null && topAction.recoverable > 0 && (
              <BlockStack gap="0">
                <Text variant="bodySm" as="p" tone="success">
                  {`Potential recovery: ~${formatCurrency(topAction.recoverable)}`}
                </Text>
                <Text variant="bodySm" as="p" tone="subdued">
                  Estimated recoverable margin
                </Text>
              </BlockStack>
            )}
            <Box>
              <Button
                variant="primary"
                onClick={() =>
                  navigate(buildUrl(topAction.filterKey, topAction.filterValue))
                }
              >
                {topAction.buttonLabel}
              </Button>
            </Box>
          </BlockStack>
        </div>

        {/* Grouped remaining actions */}
        {grouped.map((g, gi) => (
          <BlockStack key={g.key} gap="200">
            <InlineStack gap="100" blockAlign="center">
              <span style={{ fontSize: "14px" }}>{g.icon}</span>
              <Text variant="bodySm" as="p" fontWeight="semibold" tone="subdued">
                {g.label}
              </Text>
            </InlineStack>
            {g.items.map((a) => (
              <div
                key={a.id}
                style={{
                  padding: "12px 16px",
                  borderRadius: "8px",
                  background:
                    a.tone === "critical"
                      ? "#fff1f0"
                      : a.tone === "caution"
                      ? "#fffbe6"
                      : "#f0f9ff",
                  border: `1px solid ${
                    a.tone === "critical"
                      ? "#ffa39e"
                      : a.tone === "caution"
                      ? "#ffe58f"
                      : "#bae6fd"
                  }`,
                }}
              >
                <InlineStack align="space-between" blockAlign="center" gap="400">
                  <BlockStack gap="050">
                    <Text
                      as="p"
                      tone={
                        a.tone === "critical"
                          ? "critical"
                          : a.tone === "caution"
                          ? "caution"
                          : undefined
                      }
                    >
                      {a.message}
                    </Text>
                    {a.recoverable != null && a.recoverable > 0 && (
                      <Text variant="bodySm" as="p" tone="success">
                        {`Potential recovery: ~${formatCurrency(a.recoverable)}`}
                      </Text>
                    )}
                  </BlockStack>
                  <Button
                    size="slim"
                    onClick={() =>
                      navigate(buildUrl(a.filterKey, a.filterValue))
                    }
                  >
                    {a.buttonLabel}
                  </Button>
                </InlineStack>
              </div>
            ))}
            {gi < grouped.length - 1 && <Divider />}
          </BlockStack>
        ))}
      </BlockStack>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function OrdersPage() {
  const {
    orders, summary, worstOrders, dateFrom, dateTo, status, profitability,
    cogsFilter, reason, page, totalPages, totalCount, shop,
  } = useLoaderData() as LoaderData;

  const [searchParams, setSearchParams] = useSearchParams();

  // Sync from localStorage on first load if no URL date params
  useEffect(() => {
    const hasDateParam = searchParams.has("from") || searchParams.has("to");
    if (!hasDateParam) {
      const saved = loadFromStorage();
      if (saved) {
        const next = new URLSearchParams(searchParams);
        next.set("from", saved.from);
        next.set("to", saved.to);
        setSearchParams(next, { replace: true });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const navigation = useNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const isNavigating = navigation.state === "loading";

  const [sortMode, setSortMode] = useState<"default" | "loss">("default");

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

  const displayOrders = sortMode === "loss"
    ? [...orders].sort((a, b) => a.netProfit - b.netProfit)
    : orders;

  const reasonLabels: Record<string, string> = {
    ads: "📢 Ads",
    cogs: "📦 COGS",
    shipping: "🚚 Shipping",
    fees: "💳 Fees",
  };

  const rows = displayOrders.map((order) => [
    <Button
      key={order.id + "-name"}
      variant="plain"
      url={getShopifyOrderUrl(shop, order.shopifyOrderId)}
      target="_blank"
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
        {"−" + formatCurrency(order.totalDiscounts, order.currency)}
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
      fontWeight="bold"
      key={order.id + "-profit"}
    >
      {formatCurrency(order.netProfit, order.currency)}
    </Text>,

    <InlineStack key={order.id + "-margin"} gap="100" blockAlign="center">
      {marginBadge(order.marginPercent, order.cogsComplete)}
    </InlineStack>,

    // New: top cost driver with repeat loss badge
    <Box key={order.id + "-reason"}>
      {topCostBadge(order.topCostReason, order.repeatLossCount, order.netProfit < 0)}
    </Box>,

    // New: action column — Release for held orders, View for others
    <Box key={order.id + "-action"}>
      {order.isHeld ? (
        <ReleaseHoldButton orderId={order.id} />
      ) : (
        <Button
          variant="plain"
          size="slim"
          url={getShopifyOrderUrl(shop, order.shopifyOrderId)}
          target="_blank"
        >
          View ↗
        </Button>
      )}
    </Box>,
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
                  disabled={isNavigating}
                />
                <TextField
                  label="To"
                  type="date"
                  value={dateTo}
                  onChange={(v) => updateDateRange(dateFrom, v)}
                  autoComplete="off"
                  disabled={isNavigating}
                />
              </InlineGrid>

              {/* New: date presets */}
              <DateRangePicker dateFrom={dateFrom} dateTo={dateTo} onUpdate={updateDateRange} />

              <InlineGrid columns={{ xs: 1, sm: 4 }} gap="400">
                <Select
                  label="Status"
                  options={[
                    { label: "All statuses", value: "all" },
                    { label: "Clear", value: "clear" },
                    { label: "On Hold", value: "held" },
                    { label: "Paid", value: "paid" },
                    { label: "Pending", value: "pending" },
                    { label: "Refunded", value: "refunded" },
                    { label: "Partially Refunded", value: "partially_refunded" },
                    { label: "Cancelled / Voided", value: "cancelled" },
                  ]}
                  value={status}
                  onChange={(v) => updateParam("status", v)}
                  disabled={isNavigating}
                />
                <Select
                  label="Profitability"
                  options={[
                    { label: "All orders", value: "all" },
                    { label: "Profitable only", value: "profitable" },
                    { label: "Losses only", value: "loss" },
                  ]}
                  value={profitability}
                  onChange={(v) => updateParam("profitability", v)}
                  disabled={isNavigating}
                />
                <Select
                  label="COGS"
                  options={[
                    { label: "All", value: "all" },
                    { label: "Missing only", value: "missing" },
                  ]}
                  value={cogsFilter}
                  onChange={(v) => updateParam("cogs", v)}
                  disabled={isNavigating}
                />
                {/* New: reason filter — used by dashboard Action Center links */}
                <Select
                  label="Top cost"
                  options={[
                    { label: "All reasons", value: "all" },
                    { label: "📢 Ads", value: "ads" },
                    { label: "📦 COGS", value: "cogs" },
                    { label: "🚚 Shipping", value: "shipping" },
                    { label: "💳 Fees", value: "fees" },
                  ]}
                  value={reason}
                  onChange={(v) => updateParam("reason", v)}
                  disabled={isNavigating}
                />
              </InlineGrid>

              {/* Active reason filter context label */}
              {reason !== "all" && (
                <InlineStack gap="200" blockAlign="center">
                  <Text variant="bodySm" as="p" tone="caution" fontWeight="semibold">
                    {`Showing: orders where ${reasonLabels[reason] ?? reason} is top cost driver`}
                  </Text>
                  <Button
                    size="slim"
                    variant="plain"
                    onClick={() => updateParam("reason", "all")}
                  >
                    Clear
                  </Button>
                </InlineStack>
              )}

              {isNavigating && (
                <Text variant="bodySm" as="p" tone="subdued">Updating data…</Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Aha hook — loss headline */}
        {summary.lossSummary.count > 0 && (
          <Layout.Section>
            <div style={{ opacity: isNavigating ? 0.6 : 1, transition: "opacity 0.2s" }}>
              <AhaHook summary={summary} worstOrders={worstOrders} />
            </div>
          </Layout.Section>
        )}

        {/* Action Center */}
        <Layout.Section>
          <div style={{ opacity: isNavigating ? 0.6 : 1, transition: "opacity 0.2s" }}>
            <ActionCenter
              summary={summary}
              currentSearch={location.search}
              navigate={navigate}
            />
          </div>
        </Layout.Section>

        {/* Summary */}
        <Layout.Section>
          <div style={{ opacity: isNavigating ? 0.6 : 1, transition: "opacity 0.2s" }}>
            {isNavigating ? (
              <Card>
                <BlockStack gap="300">
                  <SkeletonDisplayText size="small" />
                  <SkeletonBodyText lines={1} />
                </BlockStack>
              </Card>
            ) : (
              <SummaryCard summary={summary} />
            )}
          </div>
        </Layout.Section>

        {/* Table */}
        <Layout.Section>
          <div style={{ opacity: isNavigating ? 0.6 : 1, transition: "opacity 0.2s" }}>
            {isNavigating ? (
              <Card>
                <BlockStack gap="300">
                  <SkeletonDisplayText size="small" />
                  <SkeletonBodyText lines={8} />
                </BlockStack>
              </Card>
            ) : (
              <Card padding="0">
                {orders.length === 0 ? (
                  <EmptyState
                    heading={
                      reason !== "all"
                        ? `No orders where ${reasonLabels[reason] ?? reason} is top cost`
                        : "No orders match your filters"
                    }
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <p>Try adjusting the date range or filters above.</p>
                  </EmptyState>
                ) : (
                  <BlockStack gap="0">
                    {/* Sort toggle */}
                    <Box padding="300" borderBlockEndWidth="025" borderColor="border">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text variant="bodySm" as="p" tone="subdued">
                          {sortMode === "loss"
                            ? "Sorted by worst first"
                            : "Sorted by date (newest first)"}
                        </Text>
                        <Button
                          size="slim"
                          variant={sortMode === "loss" ? "primary" : "plain"}
                          onClick={() =>
                            setSortMode((s) => s === "loss" ? "default" : "loss")
                          }
                        >
                          {sortMode === "loss" ? "Reset order" : "Show worst first"}
                        </Button>
                      </InlineStack>
                    </Box>

                    {/* Row highlighting via injected CSS */}
                    <style>{`
                      ${displayOrders.map((o, i) =>
                        !o.cogsComplete
                          ? `.Polaris-DataTable__TableRow:nth-child(${i + 1}) { background-color: #fffbeb; }`
                          : o.netProfit < 0
                          ? `.Polaris-DataTable__TableRow:nth-child(${i + 1}) { background-color: #fff5f5; }`
                          : ""
                      ).join("\n")}
                    `}</style>

                    <DataTable
                      columnContentTypes={[
                        "text", "text", "numeric", "numeric", "numeric",
                        "numeric", "numeric", "numeric", "numeric",
                        "text", "text", "text", // margin, top cost, action
                      ]}
                      headings={[
                        "Order", "Date", "Revenue", "Discounts", "COGS",
                        "Fees", "Shipping", "Ad Spend", "Net Profit",
                        "Margin", "Top Cost", "Action",
                      ]}
                      rows={rows}
                    />

                    <Box
                      padding="400"
                      borderBlockStartWidth="025"
                      borderColor="border"
                    >
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="0">
                          <Text variant="bodySm" as="p" tone="subdued">
                            {`Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, totalCount)} of ${totalCount} orders`}
                            {summary.missingCogsCount > 0 ? " · ⚠ = incomplete COGS" : ""}
                          </Text>
                          {summary.lossSummary.count > 0 && (
                            <Text variant="bodySm" as="p" tone="critical">
                              {`${summary.lossSummary.count} loss orders · ${formatCurrency(Math.abs(summary.lossSummary.totalLoss))} lost in this period`}
                            </Text>
                          )}
                        </BlockStack>
                        <InlineStack gap="200" blockAlign="center">
                          <Text variant="bodySm" as="span" tone="subdued">
                            {`Page ${page} of ${totalPages}`}
                          </Text>
                          <Button
                            disabled={page <= 1 || isNavigating}
                            onClick={() => updateParam("page", String(page - 1))}
                            size="slim"
                          >
                            Previous
                          </Button>
                          <Button
                            disabled={page >= totalPages || isNavigating}
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
            )}
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
// app/routes/app.products.tsx

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigation, useSearchParams, useNavigate } from "react-router";
import { useState } from "react";
import {
  Page, Layout, Card, Text, Badge, Box, BlockStack, InlineStack,
  Button, TextField, DataTable, EmptyState, Banner,
  SkeletonPage, SkeletonBodyText, InlineGrid, Select,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────
interface ProductAnalytic {
  id: string; // product key (productTitle used as stable ID)
  title: string;
  unitsSold: number;
  revenue: number;
  grossProfit: number;
  grossMargin: number;
  ordersCount: number;
  avgOrderValue: number;
  cogsComplete: boolean;
  missingVariantsCount: number;
  totalVariantsCount: number;
  // vs previous period
  revenuePrev: number;
  grossProfitPrev: number;
}

interface LoaderData {
  products: ProductAnalytic[];
  summary: {
    totalProducts: number;
    totalUnitsSold: number;
    totalRevenue: number;
    totalGrossProfit: number;
    avgMargin: number;
    missingCogsProducts: number;
    missingCogsVariants: number;
  };
  dateFrom: string;
  dateTo: string;
  search: string;
  sortBy: string;
  shop: string;
}

function toDateStr(d: Date) { return d.toISOString().split("T")[0]; }

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const url = new URL(request.url);
  const now = new Date();
  const defaultTo = toDateStr(now);
  const defaultFrom = toDateStr(new Date(now.getTime() - 30 * 86400000));

  const dateFrom = url.searchParams.get("from") || defaultFrom;
  const dateTo = url.searchParams.get("to") || defaultTo;
  const search = url.searchParams.get("search") || "";
  const sortBy = url.searchParams.get("sort") || "grossProfit";

  const since = new Date(dateFrom + "T00:00:00.000Z");
  const until = new Date(dateTo + "T23:59:59.999Z");

  // Previous period (same length, immediately before)
  const periodMs = until.getTime() - since.getTime();
  const prevSince = new Date(since.getTime() - periodMs);
  const prevUntil = new Date(since.getTime() - 1);

  // Fetch line items for current and previous period + variant COGS status
  const [lineItemsCurrent, lineItemsPrev, allVariants] = await Promise.all([
    db.orderLineItem.findMany({
      where: {
        order: { shop, shopifyCreatedAt: { gte: since, lte: until } },
      },
      select: {
        productTitle: true,
        price: true,
        quantity: true,
        cogs: true,
        orderId: true,
      },
    }),
    db.orderLineItem.findMany({
      where: {
        order: { shop, shopifyCreatedAt: { gte: prevSince, lte: prevUntil } },
      },
      select: {
        productTitle: true,
        price: true,
        quantity: true,
        cogs: true,
      },
    }),
    db.productVariant.findMany({
      where: { product: { shop } },
      select: {
        effectiveCost: true,
        product: { select: { title: true } },
      },
    }),
  ]);

  // Build variant COGS coverage map: shopifyProductId → { total, missing }
  const variantCoverageMap = new Map<string, { total: number; missing: number }>();
  for (const v of allVariants) {
    const pid = v.product?.title ?? "";
    const existing = variantCoverageMap.get(pid) ?? { total: 0, missing: 0 };
    variantCoverageMap.set(pid, {
      total: existing.total + 1,
      missing: existing.missing + (v.effectiveCost === null ? 1 : 0),
    });
  }

  // Aggregate current period by product
  const productMap = new Map<string, {
    title: string;
    unitsSold: number;
    revenue: number;
    grossProfit: number;
    orderIds: Set<string>;
  }>();

  for (const item of lineItemsCurrent) {
    const pid = item.productTitle || "Unknown product";
    const existing = productMap.get(pid) ?? {
      title: item.productTitle || "Unknown product",
      unitsSold: 0, revenue: 0, grossProfit: 0,
      orderIds: new Set<string>(),
    };
    const lineRevenue = item.price * item.quantity;
    const lineProfit = lineRevenue - item.cogs;
    existing.unitsSold += item.quantity;
    existing.revenue += lineRevenue;
    existing.grossProfit += lineProfit;
    existing.orderIds.add(item.orderId);
    productMap.set(pid, existing);
  }

  // Aggregate previous period by product
  const productPrevMap = new Map<string, { revenue: number; grossProfit: number }>();
  for (const item of lineItemsPrev) {
    const pid = item.productTitle || "Unknown product";
    const existing = productPrevMap.get(pid) ?? { revenue: 0, grossProfit: 0 };
    productPrevMap.set(pid, {
      revenue: existing.revenue + item.price * item.quantity,
      grossProfit: existing.grossProfit + (item.price * item.quantity - item.cogs),
    });
  }

  // Build analytics objects
  let products: ProductAnalytic[] = [...productMap.entries()].map(([pid, data]) => {
    const coverage = variantCoverageMap.get(pid) ?? { total: 0, missing: 0 };
    const prev = productPrevMap.get(pid) ?? { revenue: 0, grossProfit: 0 };
    const grossMargin = data.revenue > 0 ? (data.grossProfit / data.revenue) * 100 : 0;
    return {
      id: pid,
      title: data.title,
      unitsSold: data.unitsSold,
      revenue: data.revenue,
      grossProfit: data.grossProfit,
      grossMargin,
      ordersCount: data.orderIds.size,
      avgOrderValue: data.orderIds.size > 0 ? data.revenue / data.orderIds.size : 0,
      cogsComplete: coverage.missing === 0,
      missingVariantsCount: coverage.missing,
      totalVariantsCount: coverage.total,
      revenuePrev: prev.revenue,
      grossProfitPrev: prev.grossProfit,
    };
  });

  // Apply search filter
  if (search) {
    const q = search.toLowerCase();
    products = products.filter((p) => p.title.toLowerCase().includes(q));
  }

  // Apply sort
  const sortFns: Record<string, (a: ProductAnalytic, b: ProductAnalytic) => number> = {
    grossProfit: (a, b) => b.grossProfit - a.grossProfit,
    grossProfitAsc: (a, b) => a.grossProfit - b.grossProfit,
    revenue: (a, b) => b.revenue - a.revenue,
    units: (a, b) => b.unitsSold - a.unitsSold,
    margin: (a, b) => b.grossMargin - a.grossMargin,
  };
  products.sort(sortFns[sortBy] ?? sortFns.grossProfit);

  // Summary
  const totalRevenue = products.reduce((s, p) => s + p.revenue, 0);
  const totalGrossProfit = products.reduce((s, p) => s + p.grossProfit, 0);
  const totalUnitsSold = products.reduce((s, p) => s + p.unitsSold, 0);
  const avgMargin = products.length > 0
    ? products.reduce((s, p) => s + p.grossMargin, 0) / products.length : 0;
  const missingCogsProducts = products.filter((p) => !p.cogsComplete).length;
  const missingCogsVariants = allVariants.filter((v) => v.effectiveCost === null).length;

  return json({
    products,
    summary: {
      totalProducts: products.length,
      totalUnitsSold,
      totalRevenue,
      totalGrossProfit,
      avgMargin,
      missingCogsProducts,
      missingCogsVariants,
    },
    dateFrom,
    dateTo,
    search,
    sortBy,
    shop,
  });
};

// ── Client helpers ────────────────────────────────────────────────────────────
function fmtCurrency(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2,
  }).format(n);
}

function trendArrow(curr: number, prev: number) {
  if (prev === 0) return null;
  const pct = ((curr - prev) / Math.abs(prev)) * 100;
  const positive = pct >= 0;
  return (
    <InlineStack gap="100" blockAlign="center">
      <span style={{ color: positive ? "#008060" : "#d92d20", fontSize: "12px" }}>
        {positive ? "↑" : "↓"}
      </span>
      <Text variant="bodySm" as="span" tone={positive ? "success" : "critical"}>
        {`${Math.abs(pct).toFixed(1)}%`}
      </Text>
    </InlineStack>
  );
}

// ── Date presets ──────────────────────────────────────────────────────────────
function DatePresets({ dateFrom, dateTo, onUpdate }: {
  dateFrom: string;
  dateTo: string;
  onUpdate: (from: string, to: string) => void;
}) {
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const presets = [
    { label: "7 days", from: fmt(new Date(today.getTime() - 7 * 86400000)), to: fmt(today) },
    { label: "30 days", from: fmt(new Date(today.getTime() - 30 * 86400000)), to: fmt(today) },
    { label: "This month", from: fmt(new Date(today.getFullYear(), today.getMonth(), 1)), to: fmt(today) },
    { label: "Last month", from: fmt(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: fmt(new Date(today.getFullYear(), today.getMonth(), 0)) },
    { label: "90 days", from: fmt(new Date(today.getTime() - 90 * 86400000)), to: fmt(today) },
  ];
  return (
    <Card>
      <InlineStack gap="200" wrap align="space-between">
        <InlineStack gap="200" wrap>
          {presets.map((p) => {
            const active = dateFrom === p.from && dateTo === p.to;
            return (
              <Button
                key={p.label}
                size="slim"
                variant={active ? "primary" : "plain"}
                onClick={() => onUpdate(p.from, p.to)}
              >
                {p.label}
              </Button>
            );
          })}
        </InlineStack>
        <Text variant="bodySm" as="p" tone="subdued">
          {`${dateFrom} → ${dateTo}`}
        </Text>
      </InlineStack>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ProductsPage() {
  const { products, summary, dateFrom, dateTo, search, sortBy, shop } =
    useLoaderData() as LoaderData;

  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const isLoading = navigation.state === "loading";

  const [searchValue, setSearchValue] = useState(search);
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "page") next.set("page", "1");
    setSearchParams(next);
  };

  const updateDateRange = (from: string, to: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("from", from);
    next.set("to", to);
    setSearchParams(next);
  };

  const handleSearch = (value: string) => {
    setSearchValue(value);
    if (searchTimeout) clearTimeout(searchTimeout);
    setSearchTimeout(setTimeout(() => updateParam("search", value), 400));
  };

  if (isLoading && products.length === 0) {
    return (
      <SkeletonPage title="Product Analytics">
        <Layout>
          <Layout.Section><Card><SkeletonBodyText lines={3} /></Card></Layout.Section>
          <Layout.Section><Card><SkeletonBodyText lines={10} /></Card></Layout.Section>
        </Layout>
      </SkeletonPage>
    );
  }

  const topProduct = products[0] ?? null;
  const worstProduct = [...products].filter((p) => p.grossProfit < 0).sort((a, b) => a.grossProfit - b.grossProfit)[0] ?? null;

  // Table rows
  const rows = products.map((p) => [
    // Product name
    <BlockStack gap="0" key={p.id + "-name"}>
      <Text variant="bodyMd" as="p" fontWeight="semibold">
        {p.title}
      </Text>
      <InlineStack gap="200" blockAlign="center">
        {!p.cogsComplete && (
          <Tooltip content={`${p.missingVariantsCount} of ${p.totalVariantsCount} variants missing cost data — profit understated`}>
            <Badge tone="attention">⚠ Incomplete COGS</Badge>
          </Tooltip>
        )}
        <Text variant="bodySm" as="span" tone="subdued">
          {`${p.ordersCount} order${p.ordersCount !== 1 ? "s" : ""}`}
        </Text>
      </InlineStack>
    </BlockStack>,

    // Units sold
    <Text key={p.id + "-units"} variant="bodyMd" as="p" alignment="end">
      {String(p.unitsSold)}
    </Text>,

    // Revenue + trend
    <BlockStack key={p.id + "-rev"} gap="0">
      <Text variant="bodyMd" as="p" alignment="end">{fmtCurrency(p.revenue)}</Text>
      <div style={{ textAlign: "right" }}>{trendArrow(p.revenue, p.revenuePrev)}</div>
    </BlockStack>,

    // Gross profit + trend
    <BlockStack key={p.id + "-profit"} gap="0">
      <Text
        variant="bodyMd"
        as="p"
        alignment="end"
        tone={p.grossProfit < 0 ? "critical" : undefined}
        fontWeight="semibold"
      >
        {fmtCurrency(p.grossProfit)}
      </Text>
      <div style={{ textAlign: "right" }}>{trendArrow(p.grossProfit, p.grossProfitPrev)}</div>
    </BlockStack>,

    // Gross margin
    <InlineStack key={p.id + "-margin"} align="end">
      <Badge
        tone={
          p.grossMargin < 0 ? "critical"
          : p.grossMargin < 15 ? "warning"
          : "success"
        }
      >
        {p.grossMargin.toFixed(1) + "%"}
      </Badge>
    </InlineStack>,

    // Avg order value
    <Text key={p.id + "-aov"} variant="bodyMd" as="p" alignment="end">
      {fmtCurrency(p.avgOrderValue)}
    </Text>,

    // Action
    <Button
      key={p.id + "-action"}
      size="slim"
      variant="plain"
      onClick={() => navigate(`/app/orders?profitability=all&search=${encodeURIComponent(p.title)}`)}
    >
      Orders →
    </Button>,
  ]);

  return (
    <Page title="Product Analytics">
      <Layout>
        {/* COGS warning — stays, but links out to future config page */}
        {summary.missingCogsVariants > 0 && (
          <Layout.Section>
            <Banner
              tone="warning"
              title={`${summary.missingCogsVariants} product variant${summary.missingCogsVariants !== 1 ? "s" : ""} missing cost data — margins may be overstated`}
              action={{ content: "Set up product costs", url: "/app/cogs" }}
            >
              <p>Gross profit figures for products with incomplete COGS are understated. Set cost prices to get accurate margins.</p>
            </Banner>
          </Layout.Section>
        )}

        {/* Date presets */}
        <Layout.Section>
          <DatePresets dateFrom={dateFrom} dateTo={dateTo} onUpdate={updateDateRange} />
        </Layout.Section>

        {/* Summary KPIs */}
        <Layout.Section>
          <Card>
            <div style={{ display: "flex", overflowX: "auto" }}>
              {[
                { label: "Products", value: String(summary.totalProducts), sub: "with sales" },
                { label: "Units Sold", value: String(summary.totalUnitsSold), sub: "in period" },
                { label: "Revenue", value: fmtCurrency(summary.totalRevenue), sub: "gross" },
                {
                  label: "Gross Profit",
                  value: fmtCurrency(summary.totalGrossProfit),
                  sub: "after COGS",
                  critical: summary.totalGrossProfit < 0,
                },
                {
                  label: "Avg Margin",
                  value: summary.avgMargin.toFixed(1) + "%",
                  sub: "gross",
                  critical: summary.avgMargin < 15,
                },
                {
                  label: "COGS Gaps",
                  value: String(summary.missingCogsProducts),
                  sub: "products incomplete",
                  critical: summary.missingCogsProducts > 0,
                },
              ].map((m, i, arr) => (
                <div
                  key={m.label}
                  style={{
                    flex: "1 1 0", minWidth: "130px", padding: "16px 20px",
                    borderRight: i < arr.length - 1 ? "1px solid #e5e7eb" : undefined,
                    background: (m as any).critical ? "#fff7ed" : undefined,
                  }}
                >
                  <BlockStack gap="050">
                    <Text variant="bodySm" as="p" tone="subdued">{m.label}</Text>
                    <Text
                      variant="headingLg"
                      as="p"
                      tone={(m as any).critical ? "critical" : undefined}
                    >
                      {m.value}
                    </Text>
                    <Text variant="bodySm" as="p" tone="subdued">{m.sub}</Text>
                  </BlockStack>
                </div>
              ))}
            </div>
          </Card>
        </Layout.Section>

        {/* Top/bottom leaderboard */}
        {(topProduct || worstProduct) && (
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
              {topProduct && (
                <div style={{ padding: "16px 20px", borderRadius: "12px", background: "#f6ffed", border: "1px solid #b7eb8f" }}>
                  <BlockStack gap="100">
                    <Text variant="bodySm" as="p" tone="subdued" fontWeight="semibold">🏆 TOP PERFORMER</Text>
                    <Text variant="headingSm" as="p">{topProduct.title}</Text>
                    <InlineStack gap="400">
                      <BlockStack gap="0">
                        <Text variant="bodySm" as="p" tone="subdued">Gross profit</Text>
                        <Text variant="headingMd" as="p" tone="success">{fmtCurrency(topProduct.grossProfit)}</Text>
                      </BlockStack>
                      <BlockStack gap="0">
                        <Text variant="bodySm" as="p" tone="subdued">Units</Text>
                        <Text variant="headingMd" as="p">{String(topProduct.unitsSold)}</Text>
                      </BlockStack>
                      <BlockStack gap="0">
                        <Text variant="bodySm" as="p" tone="subdued">Margin</Text>
                        <Text variant="headingMd" as="p">{topProduct.grossMargin.toFixed(1)}%</Text>
                      </BlockStack>
                    </InlineStack>
                  </BlockStack>
                </div>
              )}
              {worstProduct && (
                <div style={{ padding: "16px 20px", borderRadius: "12px", background: "#fff1f0", border: "1px solid #ffa39e" }}>
                  <BlockStack gap="100">
                    <Text variant="bodySm" as="p" tone="subdued" fontWeight="semibold">⚠️ BIGGEST LEAK</Text>
                    <Text variant="headingSm" as="p">{worstProduct.title}</Text>
                    <InlineStack gap="400">
                      <BlockStack gap="0">
                        <Text variant="bodySm" as="p" tone="subdued">Gross loss</Text>
                        <Text variant="headingMd" as="p" tone="critical">{fmtCurrency(worstProduct.grossProfit)}</Text>
                      </BlockStack>
                      <BlockStack gap="0">
                        <Text variant="bodySm" as="p" tone="subdued">Units</Text>
                        <Text variant="headingMd" as="p">{String(worstProduct.unitsSold)}</Text>
                      </BlockStack>
                      <BlockStack gap="0">
                        <Text variant="bodySm" as="p" tone="subdued">Margin</Text>
                        <Text variant="headingMd" as="p" tone="critical">{worstProduct.grossMargin.toFixed(1)}%</Text>
                      </BlockStack>
                    </InlineStack>
                    <Button
                      size="slim"
                      variant="primary"
                      onClick={() => navigate(`/app/orders?profitability=loss&search=${encodeURIComponent(worstProduct.title)}`)}
                    >
                      View loss orders →
                    </Button>
                  </BlockStack>
                </div>
              )}
            </InlineGrid>
          </Layout.Section>
        )}

        {/* Table */}
        <Layout.Section>
          <Card padding="0">
            <Box padding="400" borderBlockEndWidth="025" borderColor="border">
              <InlineStack align="space-between" blockAlign="center" gap="400" wrap>
                <div style={{ flex: 1, minWidth: "220px" }}>
                  <TextField
                    label="Search products"
                    labelHidden
                    placeholder="Search by product name…"
                    value={searchValue}
                    onChange={handleSearch}
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => handleSearch("")}
                  />
                </div>
                <Select
                  label="Sort by"
                  labelInline
                  options={[
                    { label: "Gross profit (high → low)", value: "grossProfit" },
                    { label: "Gross profit (low → high)", value: "grossProfitAsc" },
                    { label: "Revenue", value: "revenue" },
                    { label: "Units sold", value: "units" },
                    { label: "Margin %", value: "margin" },
                  ]}
                  value={sortBy}
                  onChange={(v) => updateParam("sort", v)}
                />
              </InlineStack>
            </Box>

            {products.length === 0 ? (
              <EmptyState
                heading={search ? "No products match your search" : "No product sales in this period"}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>{search ? "Try a different search term." : "Try a different date range."}</p>
              </EmptyState>
            ) : (
              <>
                <div style={{ opacity: isLoading ? 0.6 : 1, transition: "opacity 0.2s" }}>
                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric", "numeric", "text", "numeric", "text"]}
                    headings={["Product", "Units", "Revenue", "Gross Profit", "Margin", "Avg Order", "Action"]}
                    rows={rows}
                    truncate
                  />
                </div>
                <Box padding="400" borderBlockStartWidth="025" borderColor="border">
                  <Text variant="bodySm" as="p" tone="subdued">
                    {`${products.length} product${products.length !== 1 ? "s" : ""} · Gross profit = revenue − COGS (excludes allocated ad spend, shipping, fees)`}
                  </Text>
                </Box>
              </>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// Tooltip shim (Polaris Tooltip used directly)
function Tooltip({ children, content }: { children: React.ReactNode; content: string }) {
  return (
    <span title={content} style={{ cursor: "help" }}>
      {children}
    </span>
  );
}
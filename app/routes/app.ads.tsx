// app/routes/app.ads.tsx

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigation, useSearchParams } from "react-router";
import { useState, useEffect } from "react";
import {
  Page, Layout, Card, Text, Badge, Box, BlockStack, InlineStack,
  Button, Banner, EmptyState, SkeletonPage, SkeletonBodyText, DataTable,
} from "@shopify/polaris";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { authenticate } from "../shopify.server";
import { DateRangePicker, loadFromStorage } from "../DateRangePicker";
import db from "../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────
interface PlatformStat {
  platform: string;
  spend: number;
  impressions: number;
  clicks: number;
  cpm: number;   // cost per 1000 impressions
  cpc: number;   // cost per click
  // Attributed from order profit (proportional to spend share of that day)
  attributedRevenue: number;
  attributedProfit: number;
  poas: number;  // profit on ad spend = attributedProfit / spend
  days: number;  // days with data
}

interface DailyPoint {
  date: string;
  dateKey: string;
  totalSpend: number;
  metaSpend: number;
  googleSpend: number;
  tiktokSpend: number;
  dailyProfit: number;
  dailyRevenue: number;
  poas: number; // daily total profit / total spend
}

interface CampaignStat {
  campaignId: string;
  campaignName: string;
  platform: string;
  spend: number;
  impressions: number;
  clicks: number;
  cpm: number;
  cpc: number;
  attributedRevenue: number;
  attributedProfit: number;
  poas: number;
}

interface LoaderData {
  platforms: PlatformStat[];
  campaigns: CampaignStat[];
  daily: DailyPoint[];
  summary: {
    totalSpend: number;
    totalAttributedRevenue: number;
    totalAttributedProfit: number;
    overallPoas: number;
    totalImpressions: number;
    totalClicks: number;
    avgCpm: number;
    avgCpc: number;
    daysWithData: number;
    spendPerDay: number;
  };
  connectedPlatforms: string[];
  dateFrom: string;
  dateTo: string;
  hasData: boolean;
  hasCampaignData: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toDateStr(d: Date) { return d.toISOString().split("T")[0]; }

// ── Platform logos (inline SVG) ───────────────────────────────────────────────
function MetaLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 2.04C6.48 2.04 2 6.53 2 12.06C2 17.06 5.66 21.21 10.44 21.96V14.96H7.9V12.06H10.44V9.85C10.44 7.34 11.93 5.96 14.22 5.96C15.31 5.96 16.45 6.15 16.45 6.15V8.62H15.19C13.95 8.62 13.56 9.39 13.56 10.18V12.06H16.34L15.89 14.96H13.56V21.96C18.34 21.21 22 17.06 22 12.06C22 6.53 17.52 2.04 12 2.04Z" fill="#1877F2"/>
    </svg>
  );
}
function GoogleAdsLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M3.06 16.875L8.625 7.125L11.4 8.7L5.835 18.45L3.06 16.875Z" fill="#FBBC04"/>
      <path d="M15.375 7.125L20.94 16.875L18.165 18.45L12.6 8.7L15.375 7.125Z" fill="#34A853"/>
      <circle cx="19.5" cy="18" r="2.5" fill="#EA4335"/>
      <circle cx="4.5" cy="18" r="2.5" fill="#4285F4"/>
      <circle cx="12" cy="5.5" r="2.5" fill="#FBBC04"/>
    </svg>
  );
}
function TikTokLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.93a8.19 8.19 0 004.79 1.54V7.04a4.85 4.85 0 01-1.02-.35z" fill="#000000"/>
    </svg>
  );
}

const PLATFORM_LOGOS: Record<string, React.ReactNode> = {
  meta:   <MetaLogo size={22} />,
  google: <GoogleAdsLogo size={22} />,
  tiktok: <TikTokLogo size={22} />,
};

function fmtCurrency(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2,
  }).format(n);
}
function fmtNumber(n: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}
function fmtK(n: number) {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return fmtCurrency(n);
}

const PLATFORM_CONFIG: Record<string, { label: string; icon: string; color: string }> = {
  meta:   { label: "Meta Ads",   icon: "📘", color: "#1877F2" },
  google: { label: "Google Ads", icon: "🔍", color: "#EA4335" },
  tiktok: { label: "TikTok Ads", icon: "🎵", color: "#000000" },
};

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const url = new URL(request.url);
  const now = new Date();
  const defaultTo = toDateStr(now);
  const defaultFrom = toDateStr(new Date(now.getTime() - 30 * 86400000));
  const dateFrom = url.searchParams.get("from") || defaultFrom;
  const dateTo   = url.searchParams.get("to")   || defaultTo;

  const since = new Date(dateFrom + "T00:00:00.000Z");
  const until = new Date(dateTo   + "T23:59:59.999Z");

  // Which platforms are connected
  const integrations = await (db as any).adIntegration.findMany({
    where: { shop, isActive: true },
    select: { platform: true },
  });
  const connectedPlatforms: string[] = integrations.map((i: any) => i.platform);

  // Ad spend rows in range
  const adSpendRows = await (db as any).adSpend.findMany({
    where: { shop, date: { gte: dateFrom, lte: dateTo } },
    select: { platform: true, date: true, spend: true, impressions: true, clicks: true },
  }) as { platform: string; date: string; spend: number; impressions: number; clicks: number }[];

  // Orders in range — need profit + revenue per day to attribute
  const orders = await db.order.findMany({
    where: { shop, shopifyCreatedAt: { gte: since, lte: until } },
    select: {
      shopifyCreatedAt: true,
      totalPrice: true,
      netProfit: true,
      adSpendAllocated: true,
    },
  });

  if (adSpendRows.length === 0) {
    return json({
      platforms: [], campaigns: [], daily: [],
      summary: {
        totalSpend: 0, totalAttributedRevenue: 0, totalAttributedProfit: 0,
        overallPoas: 0, totalImpressions: 0, totalClicks: 0,
        avgCpm: 0, avgCpc: 0, daysWithData: 0, spendPerDay: 0,
      },
      connectedPlatforms,
      dateFrom, dateTo,
      hasData: false, hasCampaignData: false,
    });
  }

  // ── Daily aggregation ─────────────────────────────────────────────────────
  // Build: date → { totalSpend by platform, revenue, profit }
  const dayMap = new Map<string, {
    meta: number; google: number; tiktok: number;
    revenue: number; profit: number;
  }>();

  // Fill spend from adSpend rows
  for (const row of adSpendRows) {
    const d = row.date.split("T")[0]; // normalize to YYYY-MM-DD
    const existing = dayMap.get(d) ?? { meta: 0, google: 0, tiktok: 0, revenue: 0, profit: 0 };
    const key = row.platform as "meta" | "google" | "tiktok";
    if (key === "meta" || key === "google" || key === "tiktok") {
      existing[key] += row.spend;
    }
    dayMap.set(d, existing);
  }

  // Fill revenue + profit from orders
  for (const o of orders) {
    const d = toDateStr(o.shopifyCreatedAt);
    const existing = dayMap.get(d);
    if (!existing) continue; // day with orders but no ad spend — skip
    existing.revenue += o.totalPrice;
    existing.profit  += o.netProfit;
  }

  // ── Per-platform stats ─────────────────────────────────────────────────────
  const platformMap = new Map<string, {
    spend: number; impressions: number; clicks: number;
    attributedRevenue: number; attributedProfit: number; days: number;
  }>();

  for (const row of adSpendRows) {
    const p = platformMap.get(row.platform) ?? {
      spend: 0, impressions: 0, clicks: 0,
      attributedRevenue: 0, attributedProfit: 0, days: 0,
    };
    p.spend       += row.spend;
    p.impressions += row.impressions;
    p.clicks      += row.clicks;
    platformMap.set(row.platform, p);
  }

  // Attribution: each platform gets a share of that day's profit/revenue
  // proportional to its spend vs. total spend that day
  for (const [date, day] of dayMap.entries()) {
    const totalDaySpend = day.meta + day.google + day.tiktok;
    if (totalDaySpend === 0) continue;

    for (const [plt, data] of platformMap.entries()) {
      // Find this platform's spend on this day
      const pltRows = adSpendRows.filter((r) => r.platform === plt && r.date.split("T")[0] === date);
      const pltSpend = pltRows.reduce((s, r) => s + r.spend, 0);
      if (pltSpend === 0) continue;

      const share = pltSpend / totalDaySpend;
      data.attributedRevenue += day.revenue * share;
      data.attributedProfit  += day.profit  * share;
    }
  }

  // Count distinct days per platform
  for (const [plt, data] of platformMap.entries()) {
    data.days = new Set(
      adSpendRows.filter((r) => r.platform === plt).map((r) => r.date.split("T")[0])
    ).size;
  }

  const platforms: PlatformStat[] = [...platformMap.entries()].map(([platform, data]) => ({
    platform,
    spend:       data.spend,
    impressions: data.impressions,
    clicks:      data.clicks,
    cpm:         data.impressions > 0 ? (data.spend / data.impressions) * 1000 : 0,
    cpc:         data.clicks > 0 ? data.spend / data.clicks : 0,
    attributedRevenue: data.attributedRevenue,
    attributedProfit:  data.attributedProfit,
    poas: data.spend > 0 ? data.attributedProfit / data.spend : 0,
    days: data.days,
  })).sort((a, b) => b.spend - a.spend);

  // ── Build daily chart points ───────────────────────────────────────────────
  // Fill all days in range (even without spend)
  const allDays: string[] = [];
  let cur = new Date(since);
  while (cur <= until) {
    allDays.push(toDateStr(cur));
    cur = new Date(cur.getTime() + 86400000);
  }

  const daily: DailyPoint[] = allDays.map((dateKey) => {
    const day = dayMap.get(dateKey);
    const totalSpend = (day?.meta ?? 0) + (day?.google ?? 0) + (day?.tiktok ?? 0);
    const dailyProfit  = day?.profit  ?? 0;
    const dailyRevenue = day?.revenue ?? 0;
    return {
      date: new Date(dateKey + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
      dateKey,
      totalSpend,
      metaSpend:   day?.meta   ?? 0,
      googleSpend: day?.google ?? 0,
      tiktokSpend: day?.tiktok ?? 0,
      dailyProfit,
      dailyRevenue,
      poas: totalSpend > 0 ? dailyProfit / totalSpend : 0,
    };
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalSpend              = platforms.reduce((s, p) => s + p.spend, 0);
  const totalAttributedRevenue  = platforms.reduce((s, p) => s + p.attributedRevenue, 0);
  const totalAttributedProfit   = platforms.reduce((s, p) => s + p.attributedProfit, 0);
  const totalImpressions        = platforms.reduce((s, p) => s + p.impressions, 0);
  const totalClicks             = platforms.reduce((s, p) => s + p.clicks, 0);
  const daysWithData            = new Set(adSpendRows.map((r) => r.date.split("T")[0])).size;

  // ── Campaign-level stats ──────────────────────────────────────────────────
  const campaignRows = await (db as any).adCampaign.findMany({
    where: { shop, date: { gte: dateFrom, lte: dateTo } },
    select: { campaignId: true, campaignName: true, platform: true, date: true, spend: true, impressions: true, clicks: true },
  }) as { campaignId: string; campaignName: string; platform: string; date: string; spend: number; impressions: number; clicks: number }[];

  // Aggregate campaigns across days
  const campaignMap = new Map<string, {
    campaignName: string; platform: string;
    spend: number; impressions: number; clicks: number;
    attributedRevenue: number; attributedProfit: number;
  }>();

  for (const row of campaignRows) {
    const key = `${row.platform}::${row.campaignId}`;
    const existing = campaignMap.get(key) ?? {
      campaignName: row.campaignName, platform: row.platform,
      spend: 0, impressions: 0, clicks: 0,
      attributedRevenue: 0, attributedProfit: 0,
    };
    existing.spend       += row.spend;
    existing.impressions += row.impressions;
    existing.clicks      += row.clicks;
    campaignMap.set(key, existing);
  }

  // Attribution per campaign: proportional share of each day's profit
  for (const [key, cdata] of campaignMap.entries()) {
    const [platform, campaignId] = key.split("::");
    for (const [date, day] of dayMap.entries()) {
      const totalDaySpend = day.meta + day.google + day.tiktok;
      if (totalDaySpend === 0) continue;
      // Find this campaign's spend on this day
      const cRow = campaignRows.find((r) => r.platform === platform && r.campaignId === campaignId && r.date.split("T")[0] === date);
      if (!cRow || cRow.spend === 0) continue;
      const share = cRow.spend / totalDaySpend;
      cdata.attributedRevenue += day.revenue * share;
      cdata.attributedProfit  += day.profit  * share;
    }
  }

  const campaigns: CampaignStat[] = [...campaignMap.entries()].map(([key, data]) => {
    const [, campaignId] = key.split("::");
    return {
      campaignId,
      campaignName: data.campaignName,
      platform: data.platform,
      spend: data.spend,
      impressions: data.impressions,
      clicks: data.clicks,
      cpm: data.impressions > 0 ? (data.spend / data.impressions) * 1000 : 0,
      cpc: data.clicks > 0 ? data.spend / data.clicks : 0,
      attributedRevenue: data.attributedRevenue,
      attributedProfit: data.attributedProfit,
      poas: data.spend > 0 ? data.attributedProfit / data.spend : 0,
    };
  }).sort((a, b) => b.spend - a.spend);

  return json({
    platforms,
    campaigns,
    daily,
    summary: {
      totalSpend,
      totalAttributedRevenue,
      totalAttributedProfit,
      overallPoas: totalSpend > 0 ? totalAttributedProfit / totalSpend : 0,
      totalImpressions,
      totalClicks,
      avgCpm: totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0,
      avgCpc: totalClicks > 0 ? totalSpend / totalClicks : 0,
      daysWithData,
      spendPerDay: daysWithData > 0 ? totalSpend / daysWithData : 0,
    },
    connectedPlatforms,
    dateFrom, dateTo,
    hasData: true,
    hasCampaignData: campaignRows.length > 0,
  });
};

// ── Chart tooltip ─────────────────────────────────────────────────────────────
function SpendTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s: number, p: any) => s + (p.value ?? 0), 0);
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "12px 16px", fontSize: "13px", boxShadow: "0 2px 8px rgba(0,0,0,0.1)" }}>
      <p style={{ fontWeight: 700, marginBottom: 6, color: "#111827" }}>{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.fill ?? p.stroke ?? "#6b7280", marginBottom: 2 }}>
          {p.name}: {fmtCurrency(p.value ?? 0)}
        </p>
      ))}
      {payload.length > 1 && (
        <p style={{ borderTop: "1px solid #e5e7eb", marginTop: 6, paddingTop: 6, fontWeight: 600 }}>
          Total: {fmtCurrency(total)}
        </p>
      )}
    </div>
  );
}

function ProfitTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const profit = payload.find((p: any) => p.name === "profit")?.value ?? 0;
  const spend  = payload.find((p: any) => p.name === "spend")?.value ?? 0;
  const poas   = spend > 0 ? profit / spend : 0;
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "12px 16px", fontSize: "13px", boxShadow: "0 2px 8px rgba(0,0,0,0.1)" }}>
      <p style={{ fontWeight: 700, marginBottom: 6, color: "#111827" }}>{label}</p>
      <p style={{ color: profit >= 0 ? "#008060" : "#d92d20", marginBottom: 2 }}>
        Profit: {fmtCurrency(profit)}
      </p>
      <p style={{ color: "#6b7280", marginBottom: 2 }}>Ad Spend: {fmtCurrency(spend)}</p>
      {spend > 0 && (
        <p style={{ color: poas >= 1 ? "#008060" : "#d92d20", fontWeight: 600, marginTop: 4 }}>
          POAS: {poas.toFixed(2)}x
        </p>
      )}
    </div>
  );
}

// ── Date presets ──────────────────────────────────────────────────────────────

// ── POAS badge ────────────────────────────────────────────────────────────────
function PoasBadge({ poas }: { poas: number }) {
  if (poas <= 0) return <Badge tone="critical">{`${poas.toFixed(2)}x`}</Badge>;
  if (poas < 1)  return <Badge tone="warning">{`${poas.toFixed(2)}x`}</Badge>;
  if (poas < 2)  return <Badge tone="attention">{`${poas.toFixed(2)}x`}</Badge>;
  return <Badge tone="success">{`${poas.toFixed(2)}x`}</Badge>;
}

// ── Platform card ─────────────────────────────────────────────────────────────
function PlatformCard({ stat }: { stat: PlatformStat }) {
  const cfg = PLATFORM_CONFIG[stat.platform] ?? { label: stat.platform, icon: "📊", color: "#6b7280" };
  const poasPositive = stat.poas >= 1;

  return (
    <div style={{
      padding: "20px", borderRadius: "12px", background: "#ffffff",
      border: `1px solid ${poasPositive ? "#b7eb8f" : "#ffa39e"}`,
    }}>
      <BlockStack gap="300">
        {/* Header */}
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <span style={{ display: "flex", alignItems: "center" }}>
              {PLATFORM_LOGOS[stat.platform] ?? <span style={{ fontSize: "20px" }}>{cfg.icon}</span>}
            </span>
            <Text variant="headingSm" as="h3">{cfg.label}</Text>
          </InlineStack>
          <PoasBadge poas={stat.poas} />
        </InlineStack>

        {/* Main metric */}
        <BlockStack gap="0">
          <Text variant="bodySm" as="p" tone="subdued">Net Profit from ads</Text>
          <Text
            variant="headingXl"
            as="p"
            tone={stat.attributedProfit >= 0 ? undefined : "critical"}
          >
            {stat.attributedProfit >= 0 ? "+" : ""}{fmtCurrency(stat.attributedProfit)}
          </Text>
          <Text variant="bodySm" as="p" tone="subdued">
            {`POAS = profit ÷ spend = ${stat.attributedProfit >= 0 ? "+" : ""}${fmtCurrency(stat.attributedProfit)} ÷ ${fmtCurrency(stat.spend)}`}
          </Text>
        </BlockStack>

        <div style={{ height: "1px", background: "#f0f0f0" }} />

        {/* Stats grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          {[
            { label: "Ad Spend",    value: fmtCurrency(stat.spend) },
            { label: "Revenue (attr.)", value: fmtCurrency(stat.attributedRevenue) },
            { label: "Impressions", value: fmtNumber(stat.impressions) },
            { label: "Clicks",      value: fmtNumber(stat.clicks) },
            { label: "CPM",         value: fmtCurrency(stat.cpm) },
            { label: "CPC",         value: fmtCurrency(stat.cpc) },
          ].map((m) => (
            <BlockStack key={m.label} gap="0">
              <Text variant="bodySm" as="p" tone="subdued">{m.label}</Text>
              <Text variant="bodyMd" as="p" fontWeight="semibold">{m.value}</Text>
            </BlockStack>
          ))}
        </div>

        <Text variant="bodySm" as="p" tone="subdued">
          {`${stat.days} day${stat.days !== 1 ? "s" : ""} with data`}
        </Text>
      </BlockStack>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function AdsPage() {
  const { platforms, campaigns, daily, summary, connectedPlatforms, dateFrom, dateTo, hasData, hasCampaignData } =
    useLoaderData() as LoaderData;

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
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isLoading = navigation.state === "loading";

  const updateDateRange = (from: string, to: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("from", from);
    next.set("to", to);
    setSearchParams(next);
  };

  const hasConnectedPlatforms = connectedPlatforms.length > 0;

  if (!hasConnectedPlatforms) {
    return (
      <Page title="Ads Analysis">
        <Layout>
          <Layout.Section>
            <Card>
              <EmptyState
                heading="No ad accounts connected"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                action={{ content: "Connect ad accounts", url: "/app/settings" }}
              >
                <p>Connect Meta Ads, Google Ads, or TikTok Ads in Settings to start tracking ad performance and POAS.</p>
              </EmptyState>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  // X-axis interval adapts to date range length
  const xInterval = Math.max(1, Math.floor(daily.length / 8));

  return (
    <Page title="Ads Analysis">
      <Layout>
        {/* Attribution disclaimer */}
        <Layout.Section>
          <Banner tone="info">
            <p>
              Revenue and profit are <strong>attributed proportionally</strong> by platform spend share per day.
              Without pixel-level tracking, exact per-platform attribution is estimated.
              POAS = Net Profit ÷ Ad Spend.
            </p>
          </Banner>
        </Layout.Section>

        {/* Date presets */}
        <Layout.Section>
          <DateRangePicker dateFrom={dateFrom} dateTo={dateTo} onUpdate={updateDateRange} />
        </Layout.Section>

        {/* No data state */}
        {!hasData ? (
          <Layout.Section>
            <Card>
              <EmptyState
                heading="No ad spend data in this period"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                action={{ content: "Sync ad data now", url: "/app/settings" }}
              >
                <p>Trigger a manual sync in Settings or wait for the automatic daily sync.</p>
              </EmptyState>
            </Card>
          </Layout.Section>
        ) : (
          <>
            {/* Summary KPI strip */}
            <Layout.Section>
              <Card>
                <div style={{ display: "flex", overflowX: "auto" }}>
                  {[
                    {
                      label: "Total Ad Spend",
                      value: fmtCurrency(summary.totalSpend),
                      sub: `${fmtCurrency(summary.spendPerDay)}/day avg`,
                      critical: false,
                    },
                    {
                      label: "Overall POAS",
                      value: `${summary.overallPoas.toFixed(2)}x`,
                      sub: "Profit on Ad Spend",
                      critical: summary.overallPoas < 1,
                    },
                    {
                      label: "Attributed Profit",
                      value: fmtCurrency(summary.totalAttributedProfit),
                      sub: "Net profit from ad days",
                      critical: summary.totalAttributedProfit < 0,
                    },
                    {
                      label: "Attributed Revenue",
                      value: fmtCurrency(summary.totalAttributedRevenue),
                      sub: "Revenue on ad days",
                      critical: false,
                    },
                    {
                      label: "Impressions",
                      value: fmtNumber(summary.totalImpressions),
                      sub: `CPM ${fmtCurrency(summary.avgCpm)}`,
                      critical: false,
                    },
                    {
                      label: "Clicks",
                      value: fmtNumber(summary.totalClicks),
                      sub: `CPC ${fmtCurrency(summary.avgCpc)}`,
                      critical: false,
                    },
                  ].map((m, i, arr) => (
                    <div
                      key={m.label}
                      style={{
                        flex: "1 1 0", minWidth: "140px", padding: "16px 20px",
                        borderRight: i < arr.length - 1 ? "1px solid #e5e7eb" : undefined,
                        background: m.critical ? "#fff7ed" : undefined,
                      }}
                    >
                      <BlockStack gap="050">
                        <Text variant="bodySm" as="p" tone="subdued">{m.label}</Text>
                        <Text variant="headingLg" as="p" tone={m.critical ? "critical" : undefined}>
                          {m.value}
                        </Text>
                        <Text variant="bodySm" as="p" tone="subdued">{m.sub}</Text>
                      </BlockStack>
                    </div>
                  ))}
                </div>
              </Card>
            </Layout.Section>

            {/* Platform cards */}
            <Layout.Section>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Performance by platform</Text>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(${Math.min(platforms.length, 3)}, 1fr)`,
                  gap: "16px",
                }}>
                  {platforms.map((stat) => (
                    <PlatformCard key={stat.platform} stat={stat} />
                  ))}
                </div>
              </BlockStack>
            </Layout.Section>

            {/* Charts */}
            {mounted && (
              <>
                {/* Daily spend breakdown */}
                <Layout.Section>
                  <Card>
                    <BlockStack gap="400">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="0">
                          <Text variant="headingMd" as="h2">Daily ad spend</Text>
                          <Text variant="bodySm" as="p" tone="subdued">Spend per platform per day</Text>
                        </BlockStack>
                      </InlineStack>
                      <Box minHeight="260px">
                        <ResponsiveContainer width="100%" height={260}>
                          <BarChart data={daily} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                            <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#6b7280" }} interval={xInterval} axisLine={false} tickLine={false} />
                            <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} tickFormatter={(v) => "$" + v} axisLine={false} tickLine={false} />
                            <Tooltip content={<SpendTooltip />} />
                            <Legend wrapperStyle={{ fontSize: "12px" }} />
                            {platforms.some((p) => p.platform === "meta") && (
                              <Bar dataKey="metaSpend" name="Meta" stackId="a" fill={PLATFORM_CONFIG.meta.color} radius={[0, 0, 0, 0]} />
                            )}
                            {platforms.some((p) => p.platform === "google") && (
                              <Bar dataKey="googleSpend" name="Google" stackId="a" fill={PLATFORM_CONFIG.google.color} radius={[0, 0, 0, 0]} />
                            )}
                            {platforms.some((p) => p.platform === "tiktok") && (
                              <Bar dataKey="tiktokSpend" name="TikTok" stackId="a" fill="#888888" radius={[2, 2, 0, 0]} />
                            )}
                          </BarChart>
                        </ResponsiveContainer>
                      </Box>
                    </BlockStack>
                  </Card>
                </Layout.Section>

                {/* Spend vs Profit line chart */}
                <Layout.Section>
                  <Card>
                    <BlockStack gap="400">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="0">
                          <Text variant="headingMd" as="h2">Spend vs. Profit</Text>
                          <Text variant="bodySm" as="p" tone="subdued">
                            Days below the line cost more in ads than they returned in profit
                          </Text>
                        </BlockStack>
                        {/* Count profitable vs unprofitable days */}
                        {(() => {
                          const adDays = daily.filter((d) => d.totalSpend > 0);
                          const profitable = adDays.filter((d) => d.dailyProfit >= d.totalSpend).length;
                          return adDays.length > 0 ? (
                            <InlineStack gap="200">
                              <Badge tone="success">{`${profitable} profitable`}</Badge>
                              <Badge tone="critical">{`${adDays.length - profitable} under target`}</Badge>
                            </InlineStack>
                          ) : null;
                        })()}
                      </InlineStack>
                      <Box minHeight="260px">
                        <ResponsiveContainer width="100%" height={260}>
                          <LineChart data={daily} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                            <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#6b7280" }} interval={xInterval} axisLine={false} tickLine={false} />
                            <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} tickFormatter={(v) => "$" + v} axisLine={false} tickLine={false} />
                            <Tooltip content={<ProfitTooltip />} />
                            <Legend wrapperStyle={{ fontSize: "12px" }} />
                            <Line type="monotone" dataKey="totalSpend" name="spend" stroke="#e5e7eb" strokeWidth={2} dot={false} strokeDasharray="4 4" />
                            <Line type="monotone" dataKey="dailyProfit" name="profit" stroke="#008060" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} />
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
                          <Text variant="bodySm" as="span" tone="subdued">Ad Spend</Text>
                        </InlineStack>
                      </InlineStack>
                    </BlockStack>
                  </Card>
                </Layout.Section>
              </>
            )}

            {/* Campaign breakdown table */}
            <Layout.Section>
              <Card padding="0">
                <Box padding="400" borderBlockEndWidth="025" borderColor="border">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="0">
                      <Text variant="headingMd" as="h2">Campaign breakdown</Text>
                      <Text variant="bodySm" as="p" tone="subdued">
                        {hasCampaignData
                          ? "Sorted by spend — POAS = net profit ÷ ad spend"
                          : "Trigger a sync to load campaign-level data"}
                      </Text>
                    </BlockStack>
                    {!hasCampaignData && (
                      <Button variant="plain" url="/app/settings">Sync now →</Button>
                    )}
                  </InlineStack>
                </Box>
                {hasCampaignData && campaigns.length > 0 ? (
                  <DataTable
                    columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "numeric", "numeric", "text"]}
                    headings={["Campaign", "Platform", "Spend", "Impressions", "Clicks", "CPM", "CPC", "POAS"]}
                    rows={campaigns.map((c) => [
                      // Campaign name — truncate if long
                      <Text key={c.campaignId + "-name"} variant="bodyMd" as="p" fontWeight="semibold">
                        {c.campaignName.length > 40 ? c.campaignName.slice(0, 40) + "…" : c.campaignName}
                      </Text>,

                      // Platform badge
                      <InlineStack key={c.campaignId + "-plt"} gap="100" blockAlign="center">
                        <span style={{ display: "flex", alignItems: "center" }}>
                        {PLATFORM_LOGOS[c.platform] ?? <span>{PLATFORM_CONFIG[c.platform]?.icon ?? "📊"}</span>}
                      </span>
                        <Text variant="bodySm" as="span" tone="subdued">
                          {PLATFORM_CONFIG[c.platform]?.label ?? c.platform}
                        </Text>
                      </InlineStack>,

                      fmtCurrency(c.spend),
                      fmtNumber(c.impressions),
                      fmtNumber(c.clicks),
                      fmtCurrency(c.cpm),
                      fmtCurrency(c.cpc),

                      // POAS badge
                      <PoasBadge key={c.campaignId + "-poas"} poas={c.poas} />,
                    ])}
                  />
                ) : (
                  <Box padding="400">
                    <Text as="p" tone="subdued">
                      {hasCampaignData
                        ? "No campaign data for this period."
                        : "Campaign-level data will appear here after the next sync."}
                    </Text>
                  </Box>
                )}
              </Card>
            </Layout.Section>

            {/* POAS explanation */}
            <Layout.Section>
              <div style={{ padding: "16px 20px", borderRadius: "12px", background: "#f9fafb", border: "1px solid #e5e7eb" }}>
                <BlockStack gap="100">
                  <Text variant="headingSm" as="h3">How POAS is calculated</Text>
                  <Text variant="bodySm" as="p" tone="subdued">
                    POAS (Profit on Ad Spend) = Net Profit ÷ Ad Spend. Unlike ROAS which uses revenue,
                    POAS uses your actual net profit — after COGS, shipping, fees, and ad spend itself.
                    A POAS above 1.0x means your ads are profitable. Below 1.0x means you're losing money on ads.
                  </Text>
                  <Text variant="bodySm" as="p" tone="subdued">
                    Revenue and profit are attributed proportionally per day based on each platform's share of total spend that day.
                    Campaign-level attribution requires pixel integration — not yet available.
                  </Text>
                </BlockStack>
              </div>
            </Layout.Section>
          </>
        )}
      </Layout>
    </Page>
  );
}

// let'gogogo
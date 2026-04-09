// app/routes/app.ads.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigation, useSearchParams } from "react-router";
import { useState, useEffect } from "react";
import { Page, Banner, EmptyState, Text, InlineStack } from "@shopify/polaris";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { authenticate } from "../shopify.server";
import { DateRangePicker, loadFromStorage } from "../DateRangePicker";
import db from "../db.server";

// ── Types (unchanged) ─────────────────────────────────────────────────────────
interface PlatformStat { platform: string; spend: number; impressions: number; clicks: number; cpm: number; cpc: number; attributedRevenue: number; attributedProfit: number; poas: number; days: number; }
interface DailyPoint { date: string; dateKey: string; totalSpend: number; metaSpend: number; googleSpend: number; tiktokSpend: number; dailyProfit: number; dailyRevenue: number; poas: number; }
interface CampaignStat { campaignId: string; campaignName: string; platform: string; spend: number; impressions: number; clicks: number; cpm: number; cpc: number; attributedRevenue: number; attributedProfit: number; poas: number; }
interface LoaderData { platforms: PlatformStat[]; campaigns: CampaignStat[]; daily: DailyPoint[]; summary: { totalSpend: number; totalAttributedRevenue: number; totalAttributedProfit: number; overallPoas: number; totalImpressions: number; totalClicks: number; avgCpm: number; avgCpc: number; daysWithData: number; spendPerDay: number; }; connectedPlatforms: string[]; dateFrom: string; dateTo: string; hasData: boolean; hasCampaignData: boolean; }

function toDateStr(d: Date) { return d.toISOString().split("T")[0]; }

// ── SVG Logos ─────────────────────────────────────────────────────────────────
function MetaLogo({ size = 20 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M12 2.04C6.48 2.04 2 6.53 2 12.06C2 17.06 5.66 21.21 10.44 21.96V14.96H7.9V12.06H10.44V9.85C10.44 7.34 11.93 5.96 14.22 5.96C15.31 5.96 16.45 6.15 16.45 6.15V8.62H15.19C13.95 8.62 13.56 9.39 13.56 10.18V12.06H16.34L15.89 14.96H13.56V21.96C18.34 21.21 22 17.06 22 12.06C22 6.53 17.52 2.04 12 2.04Z" fill="#1877F2"/></svg>; }
function GoogleAdsLogo({ size = 20 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M3.06 16.875L8.625 7.125L11.4 8.7L5.835 18.45L3.06 16.875Z" fill="#FBBC04"/><path d="M15.375 7.125L20.94 16.875L18.165 18.45L12.6 8.7L15.375 7.125Z" fill="#34A853"/><circle cx="19.5" cy="18" r="2.5" fill="#EA4335"/><circle cx="4.5" cy="18" r="2.5" fill="#4285F4"/><circle cx="12" cy="5.5" r="2.5" fill="#FBBC04"/></svg>; }
function TikTokLogo({ size = 20 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.93a8.19 8.19 0 004.79 1.54V7.04a4.85 4.85 0 01-1.02-.35z" fill="#000000"/></svg>; }

const PLATFORM_LOGOS: Record<string, React.ReactNode> = { meta: <MetaLogo size={20} />, google: <GoogleAdsLogo size={20} />, tiktok: <TikTokLogo size={20} /> };
const PLATFORM_CONFIG: Record<string, { label: string; color: string }> = { meta: { label: "Meta Ads", color: "#1877F2" }, google: { label: "Google Ads", color: "#EA4335" }, tiktok: { label: "TikTok Ads", color: "#000000" } };

function fmt(n: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n); }
function fmtN(n: number) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n); }

// ── Loader (unchanged) ────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;
  const url = new URL(request.url);
  const now = new Date();
  const defaultTo = toDateStr(now); const defaultFrom = toDateStr(new Date(now.getTime() - 30 * 86400000));
  const dateFrom = url.searchParams.get("from") || defaultFrom; const dateTo = url.searchParams.get("to") || defaultTo;
  const since = new Date(dateFrom + "T00:00:00.000Z"); const until = new Date(dateTo + "T23:59:59.999Z");
  const integrations = await (db as any).adIntegration.findMany({ where: { shop, isActive: true }, select: { platform: true } });
  const connectedPlatforms: string[] = integrations.map((i: any) => i.platform);
  const adSpendRows = await (db as any).adSpend.findMany({ where: { shop, date: { gte: dateFrom, lte: dateTo } }, select: { platform: true, date: true, spend: true, impressions: true, clicks: true } }) as { platform: string; date: string; spend: number; impressions: number; clicks: number }[];
  const orders = await db.order.findMany({ where: { shop, shopifyCreatedAt: { gte: since, lte: until } }, select: { shopifyCreatedAt: true, totalPrice: true, netProfit: true, adSpendAllocated: true } });
  if (adSpendRows.length === 0) return json({ platforms: [], campaigns: [], daily: [], summary: { totalSpend: 0, totalAttributedRevenue: 0, totalAttributedProfit: 0, overallPoas: 0, totalImpressions: 0, totalClicks: 0, avgCpm: 0, avgCpc: 0, daysWithData: 0, spendPerDay: 0 }, connectedPlatforms, dateFrom, dateTo, hasData: false, hasCampaignData: false });
  const dayMap = new Map<string, { meta: number; google: number; tiktok: number; revenue: number; profit: number }>();
  for (const row of adSpendRows) { const d = row.date.split("T")[0]; const existing = dayMap.get(d) ?? { meta: 0, google: 0, tiktok: 0, revenue: 0, profit: 0 }; const key = row.platform as "meta"|"google"|"tiktok"; if (key === "meta" || key === "google" || key === "tiktok") existing[key] += row.spend; dayMap.set(d, existing); }
  for (const o of orders) { const d = toDateStr(o.shopifyCreatedAt); const existing = dayMap.get(d); if (!existing) continue; existing.revenue += o.totalPrice; existing.profit += o.netProfit; }
  const platformMap = new Map<string, { spend: number; impressions: number; clicks: number; attributedRevenue: number; attributedProfit: number; days: number }>();
  for (const row of adSpendRows) { const p = platformMap.get(row.platform) ?? { spend: 0, impressions: 0, clicks: 0, attributedRevenue: 0, attributedProfit: 0, days: 0 }; p.spend += row.spend; p.impressions += row.impressions; p.clicks += row.clicks; platformMap.set(row.platform, p); }
  for (const [date, day] of dayMap.entries()) { const totalDaySpend = day.meta + day.google + day.tiktok; if (totalDaySpend === 0) continue; for (const [plt, data] of platformMap.entries()) { const pltRows = adSpendRows.filter((r) => r.platform === plt && r.date.split("T")[0] === date); const pltSpend = pltRows.reduce((s, r) => s + r.spend, 0); if (pltSpend === 0) continue; const share = pltSpend / totalDaySpend; data.attributedRevenue += day.revenue * share; data.attributedProfit += day.profit * share; } }
  for (const [plt, data] of platformMap.entries()) { data.days = new Set(adSpendRows.filter((r) => r.platform === plt).map((r) => r.date.split("T")[0])).size; }
  const platforms: PlatformStat[] = [...platformMap.entries()].map(([platform, data]) => ({ platform, spend: data.spend, impressions: data.impressions, clicks: data.clicks, cpm: data.impressions > 0 ? (data.spend / data.impressions) * 1000 : 0, cpc: data.clicks > 0 ? data.spend / data.clicks : 0, attributedRevenue: data.attributedRevenue, attributedProfit: data.attributedProfit, poas: data.spend > 0 ? data.attributedProfit / data.spend : 0, days: data.days })).sort((a, b) => b.spend - a.spend);
  const allDays: string[] = []; let cur = new Date(since); while (cur <= until) { allDays.push(toDateStr(cur)); cur = new Date(cur.getTime() + 86400000); }
  const daily: DailyPoint[] = allDays.map((dateKey) => { const day = dayMap.get(dateKey); const totalSpend = (day?.meta ?? 0) + (day?.google ?? 0) + (day?.tiktok ?? 0); return { date: new Date(dateKey + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" }), dateKey, totalSpend, metaSpend: day?.meta ?? 0, googleSpend: day?.google ?? 0, tiktokSpend: day?.tiktok ?? 0, dailyProfit: day?.profit ?? 0, dailyRevenue: day?.revenue ?? 0, poas: totalSpend > 0 ? (day?.profit ?? 0) / totalSpend : 0 }; });
  const totalSpend = platforms.reduce((s, p) => s + p.spend, 0); const totalAttributedRevenue = platforms.reduce((s, p) => s + p.attributedRevenue, 0); const totalAttributedProfit = platforms.reduce((s, p) => s + p.attributedProfit, 0); const totalImpressions = platforms.reduce((s, p) => s + p.impressions, 0); const totalClicks = platforms.reduce((s, p) => s + p.clicks, 0); const daysWithData = new Set(adSpendRows.map((r) => r.date.split("T")[0])).size;
  const campaignRows = await (db as any).adCampaign.findMany({ where: { shop, date: { gte: dateFrom, lte: dateTo } }, select: { campaignId: true, campaignName: true, platform: true, date: true, spend: true, impressions: true, clicks: true } }) as { campaignId: string; campaignName: string; platform: string; date: string; spend: number; impressions: number; clicks: number }[];
  const campaignMap = new Map<string, { campaignName: string; platform: string; spend: number; impressions: number; clicks: number; attributedRevenue: number; attributedProfit: number }>();
  for (const row of campaignRows) { const key = `${row.platform}::${row.campaignId}`; const existing = campaignMap.get(key) ?? { campaignName: row.campaignName, platform: row.platform, spend: 0, impressions: 0, clicks: 0, attributedRevenue: 0, attributedProfit: 0 }; existing.spend += row.spend; existing.impressions += row.impressions; existing.clicks += row.clicks; campaignMap.set(key, existing); }
  for (const [key, cdata] of campaignMap.entries()) { const [platform, campaignId] = key.split("::"); for (const [date, day] of dayMap.entries()) { const totalDaySpend = day.meta + day.google + day.tiktok; if (totalDaySpend === 0) continue; const cRow = campaignRows.find((r) => r.platform === platform && r.campaignId === campaignId && r.date.split("T")[0] === date); if (!cRow || cRow.spend === 0) continue; const share = cRow.spend / totalDaySpend; cdata.attributedRevenue += day.revenue * share; cdata.attributedProfit += day.profit * share; } }
  const campaigns: CampaignStat[] = [...campaignMap.entries()].map(([key, data]) => { const [, campaignId] = key.split("::"); return { campaignId, campaignName: data.campaignName, platform: data.platform, spend: data.spend, impressions: data.impressions, clicks: data.clicks, cpm: data.impressions > 0 ? (data.spend / data.impressions) * 1000 : 0, cpc: data.clicks > 0 ? data.spend / data.clicks : 0, attributedRevenue: data.attributedRevenue, attributedProfit: data.attributedProfit, poas: data.spend > 0 ? data.attributedProfit / data.spend : 0 }; }).sort((a, b) => b.spend - a.spend);
  return json({ platforms, campaigns, daily, summary: { totalSpend, totalAttributedRevenue, totalAttributedProfit, overallPoas: totalSpend > 0 ? totalAttributedProfit / totalSpend : 0, totalImpressions, totalClicks, avgCpm: totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0, avgCpc: totalClicks > 0 ? totalSpend / totalClicks : 0, daysWithData, spendPerDay: daysWithData > 0 ? totalSpend / daysWithData : 0 }, connectedPlatforms, dateFrom, dateTo, hasData: true, hasCampaignData: campaignRows.length > 0 });
};

// ── Design tokens ─────────────────────────────────────────────────────────────
const tokens = { profit: "#16a34a", profitBg: "#f0fdf4", profitBorder: "#bbf7d0", loss: "#dc2626", lossBg: "#fef2f2", lossBorder: "#fecaca", border: "#e2e8f0", cardBg: "#ffffff", text: "#0f172a", textMuted: "#64748b" };
function DCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) { return <div style={{ background: tokens.cardBg, border: `1px solid ${tokens.border}`, borderRadius: "12px", overflow: "hidden", ...style }}>{children}</div>; }
function DBadge({ children, variant = "default", size = "md" }: { children: React.ReactNode; variant?: "default"|"success"|"danger"|"warning"|"info"; size?: "sm"|"md" }) {
  const colors: Record<string, { bg: string; color: string; border: string }> = { default: { bg: "#f1f5f9", color: "#475569", border: "#e2e8f0" }, success: { bg: tokens.profitBg, color: tokens.profit, border: tokens.profitBorder }, danger: { bg: tokens.lossBg, color: tokens.loss, border: tokens.lossBorder }, warning: { bg: "#fffbeb", color: "#d97706", border: "#fde68a" }, info: { bg: "#eff6ff", color: "#2563eb", border: "#bfdbfe" } };
  const c = colors[variant];
  return <span style={{ display: "inline-flex", alignItems: "center", padding: size === "sm" ? "2px 8px" : "3px 10px", borderRadius: "100px", fontSize: size === "sm" ? "11px" : "12px", fontWeight: 600, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>{children}</span>;
}

// ── POAS badge ────────────────────────────────────────────────────────────────
function PoasBadge({ poas }: { poas: number }) {
  const variant = poas <= 0 ? "danger" : poas < 1 ? "warning" : poas < 2 ? "info" : "success";
  return <DBadge variant={variant} size="sm">{poas.toFixed(2)}x</DBadge>;
}

// ── Chart tooltips ────────────────────────────────────────────────────────────
function SpendTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s: number, p: any) => s + (p.value ?? 0), 0);
  return (
    <div style={{ background: "#fff", border: `1px solid ${tokens.border}`, borderRadius: "8px", padding: "12px 16px", fontSize: "13px", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
      <p style={{ fontWeight: 700, marginBottom: 6, color: tokens.text }}>{label}</p>
      {payload.map((p: any) => <p key={p.name} style={{ color: p.fill ?? "#6b7280", marginBottom: 2 }}>{p.name}: {fmt(p.value ?? 0)}</p>)}
      {payload.length > 1 && <p style={{ borderTop: `1px solid ${tokens.border}`, marginTop: 6, paddingTop: 6, fontWeight: 600 }}>Total: {fmt(total)}</p>}
    </div>
  );
}

function ProfitTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const profit = payload.find((p: any) => p.name === "profit")?.value ?? 0;
  const spend = payload.find((p: any) => p.name === "spend")?.value ?? 0;
  const poas = spend > 0 ? profit / spend : 0;
  return (
    <div style={{ background: "#fff", border: `1px solid ${tokens.border}`, borderRadius: "8px", padding: "12px 16px", fontSize: "13px", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
      <p style={{ fontWeight: 700, marginBottom: 6, color: tokens.text }}>{label}</p>
      <p style={{ color: profit >= 0 ? tokens.profit : tokens.loss, marginBottom: 2 }}>Profit: {fmt(profit)}</p>
      <p style={{ color: tokens.textMuted, marginBottom: 2 }}>Ad Spend: {fmt(spend)}</p>
      {spend > 0 && <p style={{ color: poas >= 1 ? tokens.profit : tokens.loss, fontWeight: 600, marginTop: 4 }}>POAS: {poas.toFixed(2)}x</p>}
    </div>
  );
}

// ── Platform card ─────────────────────────────────────────────────────────────
function PlatformCard({ stat }: { stat: PlatformStat }) {
  const cfg = PLATFORM_CONFIG[stat.platform] ?? { label: stat.platform, color: "#6b7280" };
  const profitable = stat.poas >= 1;
  return (
    <div style={{ padding: "20px", borderRadius: "12px", background: tokens.cardBg, border: `1px solid ${profitable ? tokens.profitBorder : tokens.lossBorder}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{ width: 32, height: 32, borderRadius: "8px", background: "#f8fafc", border: `1px solid ${tokens.border}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {PLATFORM_LOGOS[stat.platform] ?? <span>📊</span>}
          </div>
          <p style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: tokens.text }}>{cfg.label}</p>
        </div>
        <PoasBadge poas={stat.poas} />
      </div>
      <p style={{ margin: "0 0 2px", fontSize: "12px", color: tokens.textMuted }}>Net Profit from ads</p>
      <p style={{ margin: "0 0 4px", fontSize: "28px", fontWeight: 700, letterSpacing: "-0.02em", color: stat.attributedProfit >= 0 ? tokens.profit : tokens.loss }}>
        {stat.attributedProfit >= 0 ? "+" : ""}{fmt(stat.attributedProfit)}
      </p>
      <p style={{ margin: "0 0 14px", fontSize: "11px", color: tokens.textMuted }}>
        POAS = {fmt(stat.attributedProfit)} ÷ {fmt(stat.spend)}
      </p>
      <div style={{ height: "1px", background: tokens.border, marginBottom: "12px" }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        {[{ label: "Ad Spend", value: fmt(stat.spend) }, { label: "Revenue (attr.)", value: fmt(stat.attributedRevenue) }, { label: "Impressions", value: fmtN(stat.impressions) }, { label: "Clicks", value: fmtN(stat.clicks) }, { label: "CPM", value: fmt(stat.cpm) }, { label: "CPC", value: fmt(stat.cpc) }].map((m) => (
          <div key={m.label}>
            <p style={{ margin: "0 0 1px", fontSize: "11px", color: tokens.textMuted }}>{m.label}</p>
            <p style={{ margin: 0, fontSize: "13px", fontWeight: 600, color: tokens.text }}>{m.value}</p>
          </div>
        ))}
      </div>
      <p style={{ margin: "10px 0 0", fontSize: "11px", color: tokens.textMuted }}>{stat.days} day{stat.days !== 1 ? "s" : ""} with data</p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function AdsPage() {
  const { platforms, campaigns, daily, summary, connectedPlatforms, dateFrom, dateTo, hasData, hasCampaignData } = useLoaderData() as LoaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const hasDateParam = searchParams.has("from") || searchParams.has("to");
    if (!hasDateParam) { const saved = loadFromStorage(); if (saved) { const next = new URLSearchParams(searchParams); next.set("from", saved.from); next.set("to", saved.to); setSearchParams(next, { replace: true }); } }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const updateDateRange = (from: string, to: string) => { const next = new URLSearchParams(searchParams); next.set("from", from); next.set("to", to); setSearchParams(next); };
  const xInterval = Math.max(1, Math.floor(daily.length / 8));
  const CAMP_COL = "1fr 130px 100px 100px 80px 90px 90px 80px";
  const CAMP_HEADS = ["Campaign", "Platform", "Spend", "Impressions", "Clicks", "CPM", "CPC", "POAS"];

  if (!connectedPlatforms.length) {
    return (
      <Page title="Ads Analysis">
        <DCard>
          <div style={{ padding: "48px 20px", textAlign: "center" }}>
            <p style={{ margin: "0 0 8px", fontSize: "16px", fontWeight: 700, color: tokens.text }}>No ad accounts connected</p>
            <p style={{ margin: "0 0 20px", fontSize: "13px", color: tokens.textMuted }}>Connect Meta Ads, Google Ads, or TikTok Ads in Settings to start tracking POAS.</p>
            <a href="/app/settings" style={{ padding: "8px 20px", borderRadius: "8px", background: tokens.text, color: "#fff", textDecoration: "none", fontSize: "13px", fontWeight: 600 }}>Connect ad accounts →</a>
          </div>
        </DCard>
      </Page>
    );
  }

  return (
    <Page title="Ads Analysis">
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

        {/* Attribution disclaimer */}
        <Banner tone="info">
          <p>Revenue and profit are <strong>attributed proportionally</strong> by platform spend share per day. POAS = Net Profit ÷ Ad Spend.</p>
        </Banner>

        {/* Date picker */}
        <DateRangePicker dateFrom={dateFrom} dateTo={dateTo} onUpdate={updateDateRange} />

        {/* No data */}
        {!hasData ? (
          <DCard>
            <div style={{ padding: "48px 20px", textAlign: "center" }}>
              <p style={{ margin: "0 0 8px", fontSize: "15px", fontWeight: 600, color: tokens.text }}>No ad spend data in this period</p>
              <p style={{ margin: "0 0 16px", fontSize: "13px", color: tokens.textMuted }}>Trigger a manual sync in Settings or wait for the automatic daily sync.</p>
              <a href="/app/settings" style={{ fontSize: "13px", color: "#2563eb", fontWeight: 500 }}>Sync ad data now →</a>
            </div>
          </DCard>
        ) : (
          <>
            {/* Summary KPI strip */}
            <DCard>
              <div style={{ display: "flex", overflowX: "auto" }}>
                {[
                  { label: "Total Ad Spend", value: fmt(summary.totalSpend), sub: `${fmt(summary.spendPerDay)}/day avg`, critical: false },
                  { label: "Overall POAS", value: `${summary.overallPoas.toFixed(2)}x`, sub: "Profit on Ad Spend", critical: summary.overallPoas < 1 },
                  { label: "Attributed Profit", value: fmt(summary.totalAttributedProfit), sub: "Net profit from ad days", critical: summary.totalAttributedProfit < 0 },
                  { label: "Attributed Revenue", value: fmt(summary.totalAttributedRevenue), sub: "Revenue on ad days", critical: false },
                  { label: "Impressions", value: fmtN(summary.totalImpressions), sub: `CPM ${fmt(summary.avgCpm)}`, critical: false },
                  { label: "Clicks", value: fmtN(summary.totalClicks), sub: `CPC ${fmt(summary.avgCpc)}`, critical: false },
                ].map((m, i, arr) => (
                  <div key={m.label} style={{ flex: "1 1 0", minWidth: "140px", padding: "16px 18px", borderRight: i < arr.length - 1 ? `1px solid ${tokens.border}` : undefined, background: m.critical ? "#fffbeb" : tokens.cardBg }}>
                    <p style={{ margin: "0 0 4px", fontSize: "11px", fontWeight: 600, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{m.label}</p>
                    <p style={{ margin: "0 0 2px", fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", color: m.critical ? tokens.loss : tokens.text }}>{m.value}</p>
                    <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>{m.sub}</p>
                  </div>
                ))}
              </div>
            </DCard>

            {/* Platform cards */}
            <div>
              <p style={{ margin: "0 0 12px", fontSize: "15px", fontWeight: 700, color: tokens.text }}>Performance by platform</p>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(platforms.length, 3)}, 1fr)`, gap: "14px" }}>
                {platforms.map((stat) => <PlatformCard key={stat.platform} stat={stat} />)}
              </div>
            </div>

            {/* Charts */}
            {mounted && (
              <>
                <DCard>
                  <div style={{ padding: "16px 20px", borderBottom: `1px solid ${tokens.border}` }}>
                    <p style={{ margin: "0 0 2px", fontSize: "15px", fontWeight: 700, color: tokens.text }}>Daily ad spend</p>
                    <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>Spend per platform per day</p>
                  </div>
                  <div style={{ padding: "16px 20px" }}>
                    <ResponsiveContainer width="100%" height={240}>
                      <BarChart data={daily} margin={{ top: 8, right: 20, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                        <XAxis dataKey="date" tick={{ fontSize: 11, fill: tokens.textMuted }} interval={xInterval} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: tokens.textMuted }} tickFormatter={(v) => "$" + v} axisLine={false} tickLine={false} />
                        <Tooltip content={<SpendTooltip />} />
                        <Legend wrapperStyle={{ fontSize: "12px" }} />
                        {platforms.some((p) => p.platform === "meta") && <Bar dataKey="metaSpend" name="Meta" stackId="a" fill={PLATFORM_CONFIG.meta.color} />}
                        {platforms.some((p) => p.platform === "google") && <Bar dataKey="googleSpend" name="Google" stackId="a" fill={PLATFORM_CONFIG.google.color} />}
                        {platforms.some((p) => p.platform === "tiktok") && <Bar dataKey="tiktokSpend" name="TikTok" stackId="a" fill="#888888" radius={[2, 2, 0, 0]} />}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </DCard>

                <DCard>
                  <div style={{ padding: "16px 20px", borderBottom: `1px solid ${tokens.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div>
                      <p style={{ margin: "0 0 2px", fontSize: "15px", fontWeight: 700, color: tokens.text }}>Spend vs. Profit</p>
                      <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>Days below the line cost more in ads than they returned</p>
                    </div>
                    {(() => {
                      const adDays = daily.filter((d) => d.totalSpend > 0);
                      const profitable = adDays.filter((d) => d.dailyProfit >= d.totalSpend).length;
                      return adDays.length > 0 ? (
                        <div style={{ display: "flex", gap: "8px" }}>
                          <DBadge variant="success" size="sm">{profitable} profitable</DBadge>
                          <DBadge variant="danger" size="sm">{adDays.length - profitable} under target</DBadge>
                        </div>
                      ) : null;
                    })()}
                  </div>
                  <div style={{ padding: "16px 20px" }}>
                    <ResponsiveContainer width="100%" height={240}>
                      <LineChart data={daily} margin={{ top: 8, right: 20, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                        <XAxis dataKey="date" tick={{ fontSize: 11, fill: tokens.textMuted }} interval={xInterval} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: tokens.textMuted }} tickFormatter={(v) => "$" + v} axisLine={false} tickLine={false} />
                        <Tooltip content={<ProfitTooltip />} />
                        <Legend wrapperStyle={{ fontSize: "12px" }} />
                        <Line type="monotone" dataKey="totalSpend" name="spend" stroke="#e2e8f0" strokeWidth={2} dot={false} strokeDasharray="4 4" />
                        <Line type="monotone" dataKey="dailyProfit" name="profit" stroke={tokens.profit} strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} />
                      </LineChart>
                    </ResponsiveContainer>
                    <div style={{ display: "flex", gap: "20px", justifyContent: "center", marginTop: "10px" }}>
                      {[{ color: tokens.profit, label: "Net Profit" }, { color: "#e2e8f0", label: "Ad Spend", dashed: true }].map((l) => (
                        <div key={l.label} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span style={{ width: 14, height: 2, background: l.color, display: "inline-block", borderRadius: 2 }} />
                          <span style={{ fontSize: "12px", color: tokens.textMuted }}>{l.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </DCard>
              </>
            )}

            {/* Campaign breakdown */}
            <DCard>
              <div style={{ padding: "14px 20px", borderBottom: `1px solid ${tokens.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <p style={{ margin: "0 0 2px", fontSize: "15px", fontWeight: 700, color: tokens.text }}>Campaign breakdown</p>
                  <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>{hasCampaignData ? "Sorted by spend — POAS = net profit ÷ ad spend" : "Trigger a sync to load campaign-level data"}</p>
                </div>
                {!hasCampaignData && <a href="/app/settings" style={{ fontSize: "13px", color: "#2563eb", fontWeight: 500 }}>Sync now →</a>}
              </div>

              {hasCampaignData && campaigns.length > 0 ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: CAMP_COL, padding: "8px 16px", borderBottom: `1px solid ${tokens.border}`, background: "#f8fafc" }}>
                    {CAMP_HEADS.map((h) => <span key={h} style={{ fontSize: "11px", fontWeight: 700, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.04em" }}>{h}</span>)}
                  </div>
                  {campaigns.map((c) => (
                    <div key={c.campaignId} style={{ display: "grid", gridTemplateColumns: CAMP_COL, padding: "11px 16px", borderBottom: `1px solid ${tokens.border}`, alignItems: "center" }}>
                      <p style={{ margin: 0, fontSize: "13px", fontWeight: 600, color: tokens.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.campaignName.length > 35 ? c.campaignName.slice(0, 35) + "…" : c.campaignName}
                      </p>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        {PLATFORM_LOGOS[c.platform]}
                        <span style={{ fontSize: "12px", color: tokens.textMuted }}>{PLATFORM_CONFIG[c.platform]?.label ?? c.platform}</span>
                      </div>
                      <span style={{ fontSize: "13px" }}>{fmt(c.spend)}</span>
                      <span style={{ fontSize: "13px", color: tokens.textMuted }}>{fmtN(c.impressions)}</span>
                      <span style={{ fontSize: "13px", color: tokens.textMuted }}>{fmtN(c.clicks)}</span>
                      <span style={{ fontSize: "13px", color: tokens.textMuted }}>{fmt(c.cpm)}</span>
                      <span style={{ fontSize: "13px", color: tokens.textMuted }}>{fmt(c.cpc)}</span>
                      <PoasBadge poas={c.poas} />
                    </div>
                  ))}
                </>
              ) : (
                <div style={{ padding: "20px 16px" }}>
                  <p style={{ margin: 0, fontSize: "13px", color: tokens.textMuted }}>{hasCampaignData ? "No campaign data for this period." : "Campaign-level data will appear here after the next sync."}</p>
                </div>
              )}
            </DCard>

            {/* POAS explanation */}
            <div style={{ padding: "14px 20px", borderRadius: "10px", background: "#f8fafc", border: `1px solid ${tokens.border}` }}>
              <p style={{ margin: "0 0 6px", fontSize: "13px", fontWeight: 700, color: tokens.text }}>How POAS is calculated</p>
              <p style={{ margin: "0 0 4px", fontSize: "13px", color: tokens.textMuted }}>POAS (Profit on Ad Spend) = Net Profit ÷ Ad Spend. Unlike ROAS which uses revenue, POAS uses actual net profit after COGS, shipping, fees, and ad spend. Above 1.0x = profitable. Below 1.0x = losing money on ads.</p>
              <p style={{ margin: 0, fontSize: "12px", color: "#94a3b8" }}>Revenue and profit are attributed proportionally per day based on each platform's share of total spend that day.</p>
            </div>
          </>
        )}
      </div>
    </Page>
  );
}
import { useState } from "react";
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigation, useSubmit, useFetcher, useNavigate } from "react-router";
import {
  Page, Text, BlockStack, InlineStack, Button, Banner,
  TextField, Box, Divider, Badge, Modal,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────
interface SettingsData {
  holdEnabled: boolean; holdMarginThreshold: number; alertMarginThreshold: number;
  transactionFeePercent: number; transactionFeeFixed: number; defaultShippingCost: number;
  alertEmail: string; metaConnected: boolean; metaAccountName: string | null;
  googleConnected: boolean; googleAccountName: string | null;
  tiktokConnected: boolean; tiktokAccountName: string | null;
  shop: string; metaAppId: string; appUrl: string;
}

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [settings, metaIntegration, googleIntegration, tiktokIntegration] = await Promise.all([
    db.shopSettings.findUnique({ where: { shop: session.shop } }),
    (db as any).adIntegration.findUnique({ where: { shop_platform: { shop: session.shop, platform: "meta" } } }),
    (db as any).adIntegration.findUnique({ where: { shop_platform: { shop: session.shop, platform: "google" } } }),
    (db as any).adIntegration.findUnique({ where: { shop_platform: { shop: session.shop, platform: "tiktok" } } }),
  ]);
  return json({
    holdEnabled: settings?.holdEnabled ?? false,
    holdMarginThreshold: settings?.holdMarginThreshold ?? 0,
    alertMarginThreshold: settings?.alertMarginThreshold ?? 0,
    transactionFeePercent: settings?.transactionFeePercent ?? 2.9,
    transactionFeeFixed: settings?.transactionFeeFixed ?? 0.3,
    defaultShippingCost: settings?.defaultShippingCost ?? 0,
    alertEmail: settings?.alertEmail ?? "",
    metaConnected: !!metaIntegration?.isActive,
    metaAccountName: metaIntegration?.accountName ?? null,
    googleConnected: !!googleIntegration?.isActive,
    googleAccountName: googleIntegration?.accountName ?? null,
    tiktokConnected: !!tiktokIntegration?.isActive,
    tiktokAccountName: tiktokIntegration?.accountName ?? null,
    shop: session.shop,
    metaAppId: process.env.META_APP_ID || "",
    appUrl: process.env.SHOPIFY_APP_URL || "https://profit-app-shopify-production.up.railway.app",
  });
};

// ── Sync products helper ──────────────────────────────────────────────────────
async function syncAllProducts(admin: any, shop: string): Promise<{ synced: number }> {
  let cursor: string | null = null;
  let synced = 0;

  do {
    const result: any = await admin.graphql(
      `#graphql
      query GetProducts($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id title
              variants(first: 100) {
                edges {
                  node {
                    id title sku price
                    inventoryItem {
                      id
                      unitCost { amount }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { cursor } }
    );

    const data: any = await result.json();
    const products = data.data?.products?.edges || [];

    for (const { node: product } of products) {
      const savedProduct = await db.product.upsert({
        where: { shop_shopifyProductId: { shop, shopifyProductId: product.id } },
        update: { title: product.title },
        create: { shop, shopifyProductId: product.id, title: product.title },
      });

      await Promise.all(
        product.variants.edges.map(async ({ node: variant }: any) => {
          const costPerItem = variant.inventoryItem?.unitCost?.amount
            ? parseFloat(variant.inventoryItem.unitCost.amount)
            : null;
          const price = variant.price ? parseFloat(variant.price) : null;

          // Preserve existing customCost
          const existing = await db.productVariant.findUnique({
            where: {
              productId_shopifyVariantId: {
                productId: savedProduct.id,
                shopifyVariantId: variant.id,
              },
            },
            select: { customCost: true },
          });

          const effectiveCost = existing?.customCost ?? costPerItem ?? null;

          return db.productVariant.upsert({
            where: {
              productId_shopifyVariantId: {
                productId: savedProduct.id,
                shopifyVariantId: variant.id,
              },
            },
            update: {
              title: variant.title,
              sku: variant.sku ?? null,
              shopifyInventoryItemId: variant.inventoryItem?.id ?? null,
              price,
              costPerItem,
              effectiveCost,
            },
            create: {
              productId: savedProduct.id,
              shopifyVariantId: variant.id,
              title: variant.title,
              sku: variant.sku ?? null,
              shopifyInventoryItemId: variant.inventoryItem?.id ?? null,
              price,
              costPerItem,
              effectiveCost: costPerItem,
            },
          });
        })
      );

      synced += product.variants.edges.length;
    }

    cursor = data.data?.products?.pageInfo?.hasNextPage
      ? data.data?.products?.pageInfo?.endCursor
      : null;

  } while (cursor);

  return { synced };
}

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "saveSettings") {
    const holdMarginThreshold = parseFloat(formData.get("holdMarginThreshold") as string) || 0;
    await db.shopSettings.upsert({
      where: { shop: session.shop },
      update: { holdMarginThreshold, holdEnabled: holdMarginThreshold > 0, alertMarginThreshold: parseFloat(formData.get("alertMarginThreshold") as string) || 0, transactionFeePercent: parseFloat(formData.get("transactionFeePercent") as string) || 2.9, transactionFeeFixed: parseFloat(formData.get("transactionFeeFixed") as string) || 0.3, defaultShippingCost: parseFloat(formData.get("defaultShippingCost") as string) || 0, alertEmail: (formData.get("alertEmail") as string) || null },
      create: { shop: session.shop },
    });
    return json({ success: true });
  }

  if (intent === "syncProducts") {
    try {
      const { synced } = await syncAllProducts(admin, session.shop);
      console.log(`[Manual Sync] Complete for ${session.shop} — ${synced} variants`);
      return json({ success: true, synced, intent: "syncProducts" });
    } catch (err) {
      console.error("[Manual Sync] Failed:", err);
      return json({ error: "Sync failed", intent: "syncProducts" }, { status: 500 });
    }
  }

  if (intent === "disconnectMeta") { await (db as any).adIntegration.updateMany({ where: { shop: session.shop, platform: "meta" }, data: { isActive: false } }); return json({ success: true }); }
  if (intent === "disconnectGoogle") { await (db as any).adIntegration.updateMany({ where: { shop: session.shop, platform: "google" }, data: { isActive: false } }); return json({ success: true }); }
  if (intent === "disconnectTiktok") { await (db as any).adIntegration.updateMany({ where: { shop: session.shop, platform: "tiktok" }, data: { isActive: false } }); return json({ success: true }); }
  if (intent === "syncMeta") {
    const integration = await (db as any).adIntegration.findUnique({ where: { shop_platform: { shop: session.shop, platform: "meta" } } });
    if (!integration?.isActive) return json({ error: "Meta not connected" }, { status: 400 });
    try {
      const since = new Date(); since.setDate(since.getDate() - 30);
      const sinceStr = since.toISOString().split("T")[0]; const untilStr = new Date().toISOString().split("T")[0];
      const res = await fetch(`https://graph.facebook.com/v19.0/${integration.accountId}/insights?fields=spend,impressions,clicks,date_start&time_increment=1&time_range={"since":"${sinceStr}","until":"${untilStr}"}&access_token=${integration.accessToken}`);
      const data = (await res.json()) as any; let synced = 0;
      for (const day of data.data ?? []) { await (db as any).adSpend.upsert({ where: { shop_platform_date: { shop: session.shop, platform: "meta", date: day.date_start } }, update: { spend: parseFloat(day.spend ?? "0"), impressions: parseInt(day.impressions ?? "0"), clicks: parseInt(day.clicks ?? "0"), syncedAt: new Date() }, create: { shop: session.shop, platform: "meta", date: day.date_start, spend: parseFloat(day.spend ?? "0"), impressions: parseInt(day.impressions ?? "0"), clicks: parseInt(day.clicks ?? "0") } }); synced++; }
      const campaignRes = await fetch(`https://graph.facebook.com/v19.0/${integration.accountId}/insights?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks,date_start&time_increment=1&time_range={"since":"${sinceStr}","until":"${untilStr}"}&access_token=${integration.accessToken}`);
      const campaignData = (await campaignRes.json()) as any;
      for (const row of campaignData.data ?? []) { if (!row.campaign_id || !row.date_start) continue; await (db as any).adCampaign.upsert({ where: { shop_platform_campaignId_date: { shop: session.shop, platform: "meta", campaignId: row.campaign_id, date: row.date_start } }, update: { campaignName: row.campaign_name ?? row.campaign_id, spend: parseFloat(row.spend ?? "0"), impressions: parseInt(row.impressions ?? "0"), clicks: parseInt(row.clicks ?? "0"), syncedAt: new Date() }, create: { shop: session.shop, platform: "meta", campaignId: row.campaign_id, campaignName: row.campaign_name ?? row.campaign_id, date: row.date_start, spend: parseFloat(row.spend ?? "0"), impressions: parseInt(row.impressions ?? "0"), clicks: parseInt(row.clicks ?? "0") } }); }
      return json({ success: true, synced, platform: "meta" });
    } catch { return json({ error: "Sync failed" }, { status: 500 }); }
  }
  if (intent === "syncGoogle") {
    const integration = await (db as any).adIntegration.findUnique({ where: { shop_platform: { shop: session.shop, platform: "google" } } });
    if (!integration?.isActive) return json({ error: "Google not connected" }, { status: 400 });
    try {
      const tokens = JSON.parse(integration.accessToken); const since = new Date(); since.setDate(since.getDate() - 30);
      const sinceStr = since.toISOString().split("T")[0]; const untilStr = new Date().toISOString().split("T")[0];
      const query = `SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'`;
      const res = await fetch(`https://googleads.googleapis.com/v17/customers/${integration.accountId}/googleAds:search`, { method: "POST", headers: { Authorization: `Bearer ${tokens.accessToken}`, "developer-token": process.env.GOOGLE_DEVELOPER_TOKEN!, "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
      const data = (await res.json()) as any;
      const byDate = new Map<string, { spend: number; impressions: number; clicks: number }>();
      for (const row of data.results ?? []) { const date = row.segments?.date; if (!date) continue; const existing = byDate.get(date) ?? { spend: 0, impressions: 0, clicks: 0 }; byDate.set(date, { spend: existing.spend + (row.metrics?.costMicros ?? 0) / 1_000_000, impressions: existing.impressions + (row.metrics?.impressions ?? 0), clicks: existing.clicks + (row.metrics?.clicks ?? 0) }); }
      let synced = 0;
      for (const [date, metrics] of byDate) { await (db as any).adSpend.upsert({ where: { shop_platform_date: { shop: session.shop, platform: "google", date } }, update: { ...metrics, syncedAt: new Date() }, create: { shop: session.shop, platform: "google", date, ...metrics } }); synced++; }
      for (const row of data.results ?? []) { const date = row.segments?.date; const campaignId = String(row.campaign?.id ?? ""); if (!date || !campaignId) continue; await (db as any).adCampaign.upsert({ where: { shop_platform_campaignId_date: { shop: session.shop, platform: "google", campaignId, date } }, update: { campaignName: row.campaign?.name ?? campaignId, spend: (row.metrics?.costMicros ?? 0) / 1_000_000, impressions: row.metrics?.impressions ?? 0, clicks: row.metrics?.clicks ?? 0, syncedAt: new Date() }, create: { shop: session.shop, platform: "google", campaignId, campaignName: row.campaign?.name ?? campaignId, date, spend: (row.metrics?.costMicros ?? 0) / 1_000_000, impressions: row.metrics?.impressions ?? 0, clicks: row.metrics?.clicks ?? 0 } }); }
      return json({ success: true, synced, platform: "google" });
    } catch { return json({ error: "Sync failed" }, { status: 500 }); }
  }
  if (intent === "syncTiktok") {
    const integration = await (db as any).adIntegration.findUnique({ where: { shop_platform: { shop: session.shop, platform: "tiktok" } } });
    if (!integration?.isActive) return json({ error: "TikTok not connected" }, { status: 400 });
    try {
      const since = new Date(); since.setDate(since.getDate() - 30);
      const sinceStr = since.toISOString().split("T")[0]; const untilStr = new Date().toISOString().split("T")[0];
      const res = await fetch("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/", { method: "POST", headers: { "Access-Token": integration.accessToken, "Content-Type": "application/json" }, body: JSON.stringify({ advertiser_id: integration.accountId, report_type: "BASIC", dimensions: ["stat_time_day"], metrics: ["spend", "impressions", "clicks"], start_date: sinceStr, end_date: untilStr, page_size: 100 }) });
      const data = (await res.json()) as any; let synced = 0;
      for (const row of data.data?.list ?? []) { const date = row.dimensions?.stat_time_day?.split(" ")[0]; if (!date) continue; await (db as any).adSpend.upsert({ where: { shop_platform_date: { shop: session.shop, platform: "tiktok", date } }, update: { spend: parseFloat(row.metrics?.spend ?? "0"), impressions: parseInt(row.metrics?.impressions ?? "0"), clicks: parseInt(row.metrics?.clicks ?? "0"), syncedAt: new Date() }, create: { shop: session.shop, platform: "tiktok", date, spend: parseFloat(row.metrics?.spend ?? "0"), impressions: parseInt(row.metrics?.impressions ?? "0"), clicks: parseInt(row.metrics?.clicks ?? "0") } }); synced++; }
      const campaignRes = await fetch("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/", { method: "POST", headers: { "Access-Token": integration.accessToken, "Content-Type": "application/json" }, body: JSON.stringify({ advertiser_id: integration.accountId, report_type: "BASIC", dimensions: ["campaign_id", "stat_time_day"], metrics: ["campaign_name", "spend", "impressions", "clicks"], start_date: sinceStr, end_date: untilStr, page_size: 100 }) });
      const campaignData = (await campaignRes.json()) as any;
      for (const row of campaignData.data?.list ?? []) { const date = row.dimensions?.stat_time_day?.split(" ")[0]; const campaignId = String(row.dimensions?.campaign_id ?? ""); if (!date || !campaignId) continue; await (db as any).adCampaign.upsert({ where: { shop_platform_campaignId_date: { shop: session.shop, platform: "tiktok", campaignId, date } }, update: { campaignName: row.metrics?.campaign_name ?? campaignId, spend: parseFloat(row.metrics?.spend ?? "0"), impressions: parseInt(row.metrics?.impressions ?? "0"), clicks: parseInt(row.metrics?.clicks ?? "0"), syncedAt: new Date() }, create: { shop: session.shop, platform: "tiktok", campaignId, campaignName: row.metrics?.campaign_name ?? campaignId, date, spend: parseFloat(row.metrics?.spend ?? "0"), impressions: parseInt(row.metrics?.impressions ?? "0"), clicks: parseInt(row.metrics?.clicks ?? "0") } }); }
      return json({ success: true, synced, platform: "tiktok" });
    } catch { return json({ error: "Sync failed" }, { status: 500 }); }
  }
  return json({ error: "Unknown intent" }, { status: 400 });
};

// ── Design tokens ─────────────────────────────────────────────────────────────
const tokens = {
  profit: "#16a34a", profitBg: "#f0fdf4", profitBorder: "#bbf7d0",
  loss: "#dc2626", lossBg: "#fef2f2", lossBorder: "#fecaca",
  warning: "#d97706", warningBg: "#fffbeb", warningBorder: "#fde68a",
  border: "#e2e8f0", cardBg: "#ffffff", text: "#0f172a", textMuted: "#64748b",
};

function DCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: tokens.cardBg, border: `1px solid ${tokens.border}`, borderRadius: "12px", overflow: "hidden", ...style }}>{children}</div>;
}
function DCardHeader({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "16px 20px", borderBottom: `1px solid ${tokens.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>{children}</div>;
}
function DCardBody({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "20px" }}>{children}</div>;
}
function DBadge({ children, variant = "default", size = "md" }: {
  children: React.ReactNode; variant?: "default"|"success"|"danger"|"warning"|"neutral"; size?: "sm"|"md";
}) {
  const colors: Record<string, { bg: string; color: string; border: string }> = {
    default: { bg: "#f1f5f9", color: "#475569", border: "#e2e8f0" },
    success: { bg: tokens.profitBg, color: tokens.profit, border: tokens.profitBorder },
    danger:  { bg: tokens.lossBg,   color: tokens.loss,   border: tokens.lossBorder },
    warning: { bg: tokens.warningBg,color: tokens.warning, border: tokens.warningBorder },
    neutral: { bg: "#f8fafc", color: tokens.textMuted, border: tokens.border },
  };
  const c = colors[variant];
  return <span style={{ display: "inline-flex", alignItems: "center", padding: size === "sm" ? "2px 8px" : "3px 10px", borderRadius: "100px", fontSize: size === "sm" ? "11px" : "12px", fontWeight: 600, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>{children}</span>;
}

// ── Platform logos ────────────────────────────────────────────────────────────
function MetaLogo({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M12 2.04C6.48 2.04 2 6.53 2 12.06C2 17.06 5.66 21.21 10.44 21.96V14.96H7.9V12.06H10.44V9.85C10.44 7.34 11.93 5.96 14.22 5.96C15.31 5.96 16.45 6.15 16.45 6.15V8.62H15.19C13.95 8.62 13.56 9.39 13.56 10.18V12.06H16.34L15.89 14.96H13.56V21.96C18.34 21.21 22 17.06 22 12.06C22 6.53 17.52 2.04 12 2.04Z" fill="#1877F2"/></svg>;
}
function GoogleAdsLogo({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M3.06 16.875L8.625 7.125L11.4 8.7L5.835 18.45L3.06 16.875Z" fill="#FBBC04"/><path d="M15.375 7.125L20.94 16.875L18.165 18.45L12.6 8.7L15.375 7.125Z" fill="#34A853"/><circle cx="19.5" cy="18" r="2.5" fill="#EA4335"/><circle cx="4.5" cy="18" r="2.5" fill="#4285F4"/><circle cx="12" cy="5.5" r="2.5" fill="#FBBC04"/></svg>;
}
function TikTokLogo({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.93a8.19 8.19 0 004.79 1.54V7.04a4.85 4.85 0 01-1.02-.35z" fill="#000000"/></svg>;
}

// ── Ad platform row ───────────────────────────────────────────────────────────
function AdPlatformRow({ logo, label, connected, accountName, onConnect, onDisconnect, onSync, isSyncing, syncResult }: {
  logo: React.ReactNode; label: string; connected: boolean; accountName: string | null;
  onConnect: () => void; onDisconnect: () => void;
  onSync: () => void; isSyncing: boolean; syncResult: any;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1 }}>
          <div style={{ width: 36, height: 36, borderRadius: "8px", flexShrink: 0, background: "#f8fafc", border: `1px solid ${tokens.border}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {logo}
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "2px" }}>
              <span style={{ fontSize: "14px", fontWeight: 600, color: tokens.text }}>{label}</span>
              {connected && <DBadge variant="success" size="sm">Connected</DBadge>}
            </div>
            <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>{connected ? (accountName ?? "Ad account connected") : "Not connected — ad spend excluded from profit"}</p>
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
          {connected && (
            <button onClick={onSync} disabled={isSyncing} style={{ padding: "6px 14px", borderRadius: "8px", background: "transparent", color: tokens.text, border: `1px solid ${tokens.border}`, cursor: "pointer", fontSize: "12px", fontWeight: 600, opacity: isSyncing ? 0.6 : 1 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#f8fafc")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              {isSyncing ? "Syncing…" : "Sync now"}
            </button>
          )}
          {connected ? (
            <button onClick={onDisconnect} style={{ padding: "6px 14px", borderRadius: "8px", background: "transparent", color: tokens.loss, border: `1px solid ${tokens.lossBorder}`, cursor: "pointer", fontSize: "12px", fontWeight: 600 }}>
              Disconnect
            </button>
          ) : (
            <button onClick={onConnect} style={{ padding: "6px 16px", borderRadius: "8px", background: tokens.text, color: "#fff", border: "none", cursor: "pointer", fontSize: "12px", fontWeight: 600 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#1e293b")} onMouseLeave={(e) => (e.currentTarget.style.background = tokens.text)}>
              Connect →
            </button>
          )}
        </div>
      </div>
      {syncResult?.synced !== undefined && (
        <div style={{ marginTop: "8px", padding: "8px 12px", borderRadius: "6px", background: tokens.profitBg, border: `1px solid ${tokens.profitBorder}` }}>
          <p style={{ margin: 0, fontSize: "12px", color: tokens.profit, fontWeight: 500 }}>✓ Synced {syncResult.synced} days of ad spend</p>
        </div>
      )}
      {syncResult?.error && (
        <div style={{ marginTop: "8px", padding: "8px 12px", borderRadius: "6px", background: tokens.lossBg, border: `1px solid ${tokens.lossBorder}` }}>
          <p style={{ margin: 0, fontSize: "12px", color: tokens.loss, fontWeight: 500 }}>✗ Sync failed: {syncResult.error}</p>
        </div>
      )}
    </div>
  );
}

function Section({ title, badge, children, helpText }: {
  title: string; badge?: React.ReactNode; children: React.ReactNode; helpText?: string;
}) {
  return (
    <DCard>
      <DCardHeader>
        <div>
          <p style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: tokens.text }}>{title}</p>
          {helpText && <p style={{ margin: "2px 0 0", fontSize: "12px", color: tokens.textMuted }}>{helpText}</p>}
        </div>
        {badge}
      </DCardHeader>
      <DCardBody>{children}</DCardBody>
    </DCard>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const data = useLoaderData() as SettingsData;
  const navigate = useNavigate();

  const [holdThreshold, setHoldThreshold] = useState(String(data.holdMarginThreshold));
  const [alertThreshold, setAlertThreshold] = useState(String(data.alertMarginThreshold));
  const [feePercent, setFeePercent] = useState(String(data.transactionFeePercent));
  const [feeFixed, setFeeFixed] = useState(String(data.transactionFeeFixed));
  const [shippingCost, setShippingCost] = useState(String(data.defaultShippingCost));
  const [alertEmail, setAlertEmail] = useState(data.alertEmail);
  const [saved, setSaved] = useState(false);

  const submit = useSubmit();
  const metaSyncFetcher = useFetcher();
  const googleSyncFetcher = useFetcher();
  const tiktokSyncFetcher = useFetcher();
  const productSyncFetcher = useFetcher();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  const isProductSyncing = productSyncFetcher.state === "submitting";
  const productSyncResult = productSyncFetcher.data as any;

  const handleSave = () => {
    submit({ intent: "saveSettings", holdMarginThreshold: holdThreshold, alertMarginThreshold: alertThreshold, transactionFeePercent: feePercent, transactionFeeFixed: feeFixed, defaultShippingCost: shippingCost, alertEmail }, { method: "POST" });
    setSaved(true);
  };

  const handleConnectMeta = () => {
    const redirectUri = encodeURIComponent(`${data.appUrl}/connect/meta/callback`);
    const scopes = encodeURIComponent("ads_read,ads_management,business_management");
    const state = btoa(data.shop);
    window.open(`https://www.facebook.com/v19.0/dialog/oauth?client_id=${data.metaAppId}&redirect_uri=${redirectUri}&scope=${scopes}&state=${state}&response_type=code`, "_blank");
  };
  const handleConnectGoogle = () => window.open(`${data.appUrl}/connect/google?shop=${data.shop}`, "_blank");
  const handleConnectTiktok = () => window.open(`${data.appUrl}/connect/tiktok?shop=${data.shop}`, "_blank");

  const holdNum = parseFloat(holdThreshold) || 0;
  const holdsActive = holdNum > 0;
  const feePercentNum = parseFloat(feePercent) || 0;
  const feeFixedNum = parseFloat(feeFixed) || 0;
  const avgFee = (75 * feePercentNum / 100) + feeFixedNum;
  const hasAnyAd = data.metaConnected || data.googleConnected || data.tiktokConnected;
  const connectedCount = [data.metaConnected, data.googleConnected, data.tiktokConnected].filter(Boolean).length;

  const gaps = [
    !holdsActive && "Fulfillment holds off — unprofitable orders will ship automatically",
    !alertEmail && "No alert email — you won't be notified of loss orders",
    !hasAnyAd && "No ad accounts — ad spend missing from profit calculations",
  ].filter(Boolean) as string[];

  return (
    <Page title="Settings" backAction={{ content: "Dashboard", url: "/app" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

        {/* Save banner */}
        {saved && !isSaving && (
          <div style={{ padding: "12px 16px", borderRadius: "8px", background: tokens.profitBg, border: `1px solid ${tokens.profitBorder}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <p style={{ margin: 0, fontSize: "13px", fontWeight: 600, color: tokens.profit }}>✓ Settings saved</p>
            <button onClick={() => setSaved(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "16px", color: tokens.profit }}>×</button>
          </div>
        )}

        {/* Protection status */}
        {gaps.length === 0 ? (
          <div style={{ padding: "14px 20px", borderRadius: "10px", background: tokens.profitBg, border: `1px solid ${tokens.profitBorder}`, display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "18px" }}>✅</span>
            <div>
              <p style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: tokens.profit }}>Your store is fully protected</p>
              <p style={{ margin: "2px 0 0", fontSize: "12px", color: tokens.profit, opacity: 0.8 }}>Holds active · Alerts configured · Ad spend tracked</p>
            </div>
          </div>
        ) : (
          <div style={{ padding: "14px 20px", borderRadius: "10px", background: tokens.lossBg, border: `1px solid ${tokens.lossBorder}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
              <span style={{ fontSize: "18px" }}>⚠️</span>
              <p style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: tokens.loss }}>
                {gaps.length} protection gap{gaps.length > 1 ? "s" : ""} — review below
              </p>
            </div>
            {gaps.map((gap, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: "8px", marginBottom: i < gaps.length - 1 ? "6px" : 0 }}>
                <span style={{ fontSize: "12px", color: tokens.loss, marginTop: "1px", flexShrink: 0 }}>→</span>
                <p style={{ margin: 0, fontSize: "13px", color: tokens.loss }}>{gap}</p>
              </div>
            ))}
          </div>
        )}

        {/* Fulfillment Hold */}
        <Section title="Fulfillment Hold" helpText="Auto-hold unprofitable orders before they ship" badge={<DBadge variant={holdsActive ? "success" : "danger"}>{holdsActive ? `Active — ${holdNum}% threshold` : "Off"}</DBadge>}>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {!holdsActive ? (
              <div style={{ padding: "10px 14px", borderRadius: "8px", background: tokens.lossBg, border: `1px solid ${tokens.lossBorder}` }}>
                <p style={{ margin: 0, fontSize: "13px", color: tokens.loss }}>Holds are off. Unprofitable orders are shipping without review. Set a threshold to start protecting your margins.</p>
              </div>
            ) : (
              <div style={{ padding: "10px 14px", borderRadius: "8px", background: tokens.profitBg, border: `1px solid ${tokens.profitBorder}` }}>
                <p style={{ margin: 0, fontSize: "13px", color: tokens.profit }}>Orders below {holdNum}% margin will be held. You review and decide in the dashboard.</p>
              </div>
            )}
            <TextField label="Hold threshold (%)" type="number" value={holdThreshold} onChange={setHoldThreshold} suffix="%" autoComplete="off" helpText="Set to 0 to disable. Set to 10 to hold any order below 10% margin." />
          </div>
        </Section>

        {/* Margin Alerts */}
        <Section title="Margin Alerts" helpText="Email notifications when orders fall below threshold" badge={<DBadge variant={alertEmail ? "success" : "warning"}>{alertEmail ? "Active" : "No email set"}</DBadge>}>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <TextField label="Alert threshold (%)" type="number" value={alertThreshold} onChange={setAlertThreshold} suffix="%" autoComplete="off" helpText="Set to 0 to alert on loss orders only." />
            <TextField label="Alert email address(es)" type="text" value={alertEmail} onChange={setAlertEmail} placeholder="you@example.com, colleague@example.com" helpText="Separate multiple addresses with a comma. Also used for weekly P&L summaries (every Monday)." autoComplete="off" />
          </div>
        </Section>

        {/* Transaction Fees */}
        <Section title="Transaction Fees" helpText="Deducted from every order profit calculation" badge={<DBadge variant="neutral">{feePercentNum}% + ${feeFixedNum.toFixed(2)}</DBadge>}>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <TextField label="Percentage fee" type="number" value={feePercent} onChange={setFeePercent} suffix="%" autoComplete="off" />
              <TextField label="Fixed fee per order" type="number" value={feeFixed} onChange={setFeeFixed} prefix="$" autoComplete="off" />
            </div>
            <div style={{ padding: "10px 14px", borderRadius: "8px", background: "#f8fafc", border: `1px solid ${tokens.border}` }}>
              <p style={{ margin: 0, fontSize: "13px", color: tokens.textMuted }}>
                On a $75 order: <strong style={{ color: tokens.text }}>${avgFee.toFixed(2)}</strong> in fees
                <span style={{ marginLeft: "6px", fontSize: "11px" }}>· Est. ${Math.round(avgFee * 200)}/mo at 200 orders</span>
              </p>
            </div>
            <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>
              Or set up per-gateway fees in{" "}
              <button onClick={() => navigate("/app/payment")} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "#2563eb", textDecoration: "underline", fontSize: "12px" }}>
                Payment Gateways →
              </button>
            </p>
          </div>
        </Section>

        {/* Shipping Cost */}
        <Section title="Default Shipping Cost" helpText="Fallback when Shopify doesn't provide a shipping cost line">
          <TextField label="Default shipping cost" type="number" value={shippingCost} onChange={setShippingCost} prefix="$" autoComplete="off" helpText="Your average carrier cost per order. Used when no Shopify shipping line is present." />
        </Section>

        {/* Ad Integrations */}
        <Section title="Ad Integrations" helpText="Daily ad spend allocated proportionally across orders" badge={<DBadge variant={hasAnyAd ? "success" : "warning"}>{hasAnyAd ? `${connectedCount} connected` : "None connected"}</DBadge>}>
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            {!hasAnyAd && (
              <div style={{ padding: "10px 14px", borderRadius: "8px", background: tokens.warningBg, border: `1px solid ${tokens.warningBorder}` }}>
                <p style={{ margin: 0, fontSize: "13px", color: tokens.warning }}>Without ad accounts, profit calculations don't include ad spend — margins will appear higher than they really are.</p>
              </div>
            )}
            <AdPlatformRow logo={<MetaLogo />} label="Meta Ads" connected={data.metaConnected} accountName={data.metaAccountName} onConnect={handleConnectMeta} onDisconnect={() => submit({ intent: "disconnectMeta" }, { method: "POST" })} onSync={() => metaSyncFetcher.submit({ intent: "syncMeta" }, { method: "POST" })} isSyncing={metaSyncFetcher.state === "submitting"} syncResult={metaSyncFetcher.data} />
            <div style={{ height: "1px", background: tokens.border }} />
            <AdPlatformRow logo={<GoogleAdsLogo />} label="Google Ads" connected={data.googleConnected} accountName={data.googleAccountName} onConnect={handleConnectGoogle} onDisconnect={() => submit({ intent: "disconnectGoogle" }, { method: "POST" })} onSync={() => googleSyncFetcher.submit({ intent: "syncGoogle" }, { method: "POST" })} isSyncing={googleSyncFetcher.state === "submitting"} syncResult={googleSyncFetcher.data} />
            <div style={{ height: "1px", background: tokens.border }} />
            <AdPlatformRow logo={<TikTokLogo />} label="TikTok Ads" connected={data.tiktokConnected} accountName={data.tiktokAccountName} onConnect={handleConnectTiktok} onDisconnect={() => submit({ intent: "disconnectTiktok" }, { method: "POST" })} onSync={() => tiktokSyncFetcher.submit({ intent: "syncTiktok" }, { method: "POST" })} isSyncing={tiktokSyncFetcher.state === "submitting"} syncResult={tiktokSyncFetcher.data} />
          </div>
        </Section>

        {/* ── Data sync ─────────────────────────────────────────────────────── */}
        <Section title="Data Sync" helpText="Manual sync — use when product prices or costs aren't showing up correctly">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
            <div>
              <p style={{ margin: "0 0 2px", fontSize: "13px", fontWeight: 600, color: tokens.text }}>Sync product prices & costs</p>
              <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>
                Re-fetches all variants from Shopify — updates sell price and cost per item. Your custom costs are preserved.
              </p>
            </div>
            <button
              onClick={() => productSyncFetcher.submit({ intent: "syncProducts" }, { method: "POST" })}
              disabled={isProductSyncing}
              style={{ padding: "8px 18px", borderRadius: "8px", background: isProductSyncing ? "#f1f5f9" : tokens.text, color: isProductSyncing ? tokens.textMuted : "#fff", border: `1px solid ${tokens.border}`, cursor: isProductSyncing ? "default" : "pointer", fontSize: "13px", fontWeight: 600, flexShrink: 0, transition: "all 0.15s" }}
            >
              {isProductSyncing ? "Syncing…" : "Sync products"}
            </button>
          </div>

          {/* Result feedback */}
          {productSyncResult?.synced !== undefined && (
            <div style={{ marginTop: "12px", padding: "10px 14px", borderRadius: "8px", background: tokens.profitBg, border: `1px solid ${tokens.profitBorder}` }}>
              <p style={{ margin: 0, fontSize: "13px", color: tokens.profit, fontWeight: 500 }}>
                ✓ Synced {productSyncResult.synced} variants — prices and costs are up to date
              </p>
            </div>
          )}
          {productSyncResult?.error && (
            <div style={{ marginTop: "12px", padding: "10px 14px", borderRadius: "8px", background: tokens.lossBg, border: `1px solid ${tokens.lossBorder}` }}>
              <p style={{ margin: 0, fontSize: "13px", color: tokens.loss, fontWeight: 500 }}>
                ✗ Sync failed — check Railway logs for details
              </p>
            </div>
          )}
        </Section>

        {/* Save button */}
        <div>
          <button
            onClick={handleSave} disabled={isSaving}
            style={{ padding: "10px 24px", borderRadius: "8px", background: tokens.text, color: "#fff", border: "none", cursor: "pointer", fontSize: "14px", fontWeight: 600, opacity: isSaving ? 0.7 : 1 }}
            onMouseEnter={(e) => { if (!isSaving) (e.currentTarget.style.background = "#1e293b"); }}
            onMouseLeave={(e) => (e.currentTarget.style.background = tokens.text)}
          >
            {isSaving ? "Saving…" : "Save settings"}
          </button>
        </div>

      </div>
    </Page>
  );
}
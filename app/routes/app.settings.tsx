import { useState } from "react";
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigation, useSubmit, useFetcher } from "react-router";
import {
  Page, Layout, Card, Text, Box, BlockStack, Button, Banner,
  TextField, InlineStack, Divider, Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────
interface SettingsData {
  holdEnabled: boolean;
  holdMarginThreshold: number;
  alertMarginThreshold: number;
  transactionFeePercent: number;
  transactionFeeFixed: number;
  defaultShippingCost: number;
  alertEmail: string;
  metaConnected: boolean;
  metaAccountName: string | null;
  googleConnected: boolean;
  googleAccountName: string | null;
  tiktokConnected: boolean;
  tiktokAccountName: string | null;
  shop: string;
  metaAppId: string;
  appUrl: string;
}

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const [settings, metaIntegration, googleIntegration, tiktokIntegration] =
    await Promise.all([
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

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "saveSettings") {
    const holdMarginThreshold = parseFloat(formData.get("holdMarginThreshold") as string) || 0;
    await db.shopSettings.upsert({
      where: { shop: session.shop },
      update: {
        holdMarginThreshold,
        holdEnabled: holdMarginThreshold > 0,
        alertMarginThreshold: parseFloat(formData.get("alertMarginThreshold") as string) || 0,
        transactionFeePercent: parseFloat(formData.get("transactionFeePercent") as string) || 2.9,
        transactionFeeFixed: parseFloat(formData.get("transactionFeeFixed") as string) || 0.3,
        defaultShippingCost: parseFloat(formData.get("defaultShippingCost") as string) || 0,
        alertEmail: (formData.get("alertEmail") as string) || null,
      },
      create: { shop: session.shop },
    });
    return json({ success: true });
  }

  if (intent === "disconnectMeta") {
    await (db as any).adIntegration.updateMany({ where: { shop: session.shop, platform: "meta" }, data: { isActive: false } });
    return json({ success: true });
  }
  if (intent === "disconnectGoogle") {
    await (db as any).adIntegration.updateMany({ where: { shop: session.shop, platform: "google" }, data: { isActive: false } });
    return json({ success: true });
  }
  if (intent === "disconnectTiktok") {
    await (db as any).adIntegration.updateMany({ where: { shop: session.shop, platform: "tiktok" }, data: { isActive: false } });
    return json({ success: true });
  }

  if (intent === "syncMeta") {
    const integration = await (db as any).adIntegration.findUnique({ where: { shop_platform: { shop: session.shop, platform: "meta" } } });
    if (!integration?.isActive) return json({ error: "Meta not connected" }, { status: 400 });
    try {
      const since = new Date(); since.setDate(since.getDate() - 30);
      const sinceStr = since.toISOString().split("T")[0];
      const untilStr = new Date().toISOString().split("T")[0];

      // Fetch account-level daily totals (existing)
      const res = await fetch(
        `https://graph.facebook.com/v19.0/${integration.accountId}/insights?fields=spend,impressions,clicks,date_start&time_increment=1&time_range={"since":"${sinceStr}","until":"${untilStr}"}&access_token=${integration.accessToken}`
      );
      const data = (await res.json()) as any;
      let synced = 0;
      for (const day of data.data ?? []) {
        await (db as any).adSpend.upsert({
          where: { shop_platform_date: { shop: session.shop, platform: "meta", date: day.date_start } },
          update: { spend: parseFloat(day.spend ?? "0"), impressions: parseInt(day.impressions ?? "0"), clicks: parseInt(day.clicks ?? "0"), syncedAt: new Date() },
          create: { shop: session.shop, platform: "meta", date: day.date_start, spend: parseFloat(day.spend ?? "0"), impressions: parseInt(day.impressions ?? "0"), clicks: parseInt(day.clicks ?? "0") },
        });
        synced++;
      }

      // Fetch campaign-level breakdown (new)
      const campaignRes = await fetch(
        `https://graph.facebook.com/v19.0/${integration.accountId}/insights?` +
        `level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks,date_start&` +
        `time_increment=1&time_range={"since":"${sinceStr}","until":"${untilStr}"}&` +
        `access_token=${integration.accessToken}`
      );
      const campaignData = (await campaignRes.json()) as any;
      for (const row of campaignData.data ?? []) {
        if (!row.campaign_id || !row.date_start) continue;
        await (db as any).adCampaign.upsert({
          where: { shop_platform_campaignId_date: { shop: session.shop, platform: "meta", campaignId: row.campaign_id, date: row.date_start } },
          update: {
            campaignName: row.campaign_name ?? row.campaign_id,
            spend: parseFloat(row.spend ?? "0"),
            impressions: parseInt(row.impressions ?? "0"),
            clicks: parseInt(row.clicks ?? "0"),
            syncedAt: new Date(),
          },
          create: {
            shop: session.shop,
            platform: "meta",
            campaignId: row.campaign_id,
            campaignName: row.campaign_name ?? row.campaign_id,
            date: row.date_start,
            spend: parseFloat(row.spend ?? "0"),
            impressions: parseInt(row.impressions ?? "0"),
            clicks: parseInt(row.clicks ?? "0"),
          },
        });
      }

      return json({ success: true, synced, platform: "meta" });
    } catch (err) {
      console.error("[Meta Manual Sync]", err);
      return json({ error: "Sync failed" }, { status: 500 });
    }
  }

  if (intent === "syncGoogle") {
    const integration = await (db as any).adIntegration.findUnique({ where: { shop_platform: { shop: session.shop, platform: "google" } } });
    if (!integration?.isActive) return json({ error: "Google not connected" }, { status: 400 });
    try {
      const tokens = JSON.parse(integration.accessToken);
      const since = new Date(); since.setDate(since.getDate() - 30);
      const sinceStr = since.toISOString().split("T")[0];
      const untilStr = new Date().toISOString().split("T")[0];

      // Campaign-level query (includes campaign.id and campaign.name — no separate call needed)
      const query = `
        SELECT campaign.id, campaign.name, segments.date,
               metrics.cost_micros, metrics.impressions, metrics.clicks
        FROM campaign
        WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
      `;
      const res = await fetch(`https://googleads.googleapis.com/v17/customers/${integration.accountId}/googleAds:search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.accessToken}`, "developer-token": process.env.GOOGLE_DEVELOPER_TOKEN!, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = (await res.json()) as any;

      // Aggregate to daily totals for adSpend (existing behaviour)
      const byDate = new Map<string, { spend: number; impressions: number; clicks: number }>();
      for (const row of data.results ?? []) {
        const date = row.segments?.date;
        if (!date) continue;
        const existing = byDate.get(date) ?? { spend: 0, impressions: 0, clicks: 0 };
        byDate.set(date, {
          spend:       existing.spend + (row.metrics?.costMicros ?? 0) / 1_000_000,
          impressions: existing.impressions + (row.metrics?.impressions ?? 0),
          clicks:      existing.clicks + (row.metrics?.clicks ?? 0),
        });
      }
      let synced = 0;
      for (const [date, metrics] of byDate) {
        await (db as any).adSpend.upsert({
          where: { shop_platform_date: { shop: session.shop, platform: "google", date } },
          update: { ...metrics, syncedAt: new Date() },
          create: { shop: session.shop, platform: "google", date, ...metrics },
        });
        synced++;
      }

      // Upsert campaign-level rows (new)
      for (const row of data.results ?? []) {
        const date = row.segments?.date;
        const campaignId = String(row.campaign?.id ?? "");
        if (!date || !campaignId) continue;
        await (db as any).adCampaign.upsert({
          where: { shop_platform_campaignId_date: { shop: session.shop, platform: "google", campaignId, date } },
          update: {
            campaignName: row.campaign?.name ?? campaignId,
            spend:       (row.metrics?.costMicros ?? 0) / 1_000_000,
            impressions: row.metrics?.impressions ?? 0,
            clicks:      row.metrics?.clicks ?? 0,
            syncedAt:    new Date(),
          },
          create: {
            shop: session.shop,
            platform: "google",
            campaignId,
            campaignName: row.campaign?.name ?? campaignId,
            date,
            spend:       (row.metrics?.costMicros ?? 0) / 1_000_000,
            impressions: row.metrics?.impressions ?? 0,
            clicks:      row.metrics?.clicks ?? 0,
          },
        });
      }

      return json({ success: true, synced, platform: "google" });
    } catch (err) {
      console.error("[Google Manual Sync]", err);
      return json({ error: "Sync failed" }, { status: 500 });
    }
  }

  if (intent === "syncTiktok") {
    const integration = await (db as any).adIntegration.findUnique({ where: { shop_platform: { shop: session.shop, platform: "tiktok" } } });
    if (!integration?.isActive) return json({ error: "TikTok not connected" }, { status: 400 });
    try {
      const since = new Date(); since.setDate(since.getDate() - 30);
      const sinceStr = since.toISOString().split("T")[0];
      const untilStr = new Date().toISOString().split("T")[0];

      // Account-level daily totals (existing)
      const res = await fetch("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/", {
        method: "POST",
        headers: { "Access-Token": integration.accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          advertiser_id: integration.accountId,
          report_type: "BASIC",
          dimensions: ["stat_time_day"],
          metrics: ["spend", "impressions", "clicks"],
          start_date: sinceStr,
          end_date: untilStr,
          page_size: 100,
        }),
      });
      const data = (await res.json()) as any;
      let synced = 0;
      for (const row of data.data?.list ?? []) {
        const date = row.dimensions?.stat_time_day?.split(" ")[0];
        if (!date) continue;
        await (db as any).adSpend.upsert({
          where: { shop_platform_date: { shop: session.shop, platform: "tiktok", date } },
          update: { spend: parseFloat(row.metrics?.spend ?? "0"), impressions: parseInt(row.metrics?.impressions ?? "0"), clicks: parseInt(row.metrics?.clicks ?? "0"), syncedAt: new Date() },
          create: { shop: session.shop, platform: "tiktok", date, spend: parseFloat(row.metrics?.spend ?? "0"), impressions: parseInt(row.metrics?.impressions ?? "0"), clicks: parseInt(row.metrics?.clicks ?? "0") },
        });
        synced++;
      }

      // Campaign-level breakdown (new) — add campaign_id to dimensions
      const campaignRes = await fetch("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/", {
        method: "POST",
        headers: { "Access-Token": integration.accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          advertiser_id: integration.accountId,
          report_type: "BASIC",
          dimensions: ["campaign_id", "stat_time_day"],
          metrics: ["campaign_name", "spend", "impressions", "clicks"],
          start_date: sinceStr,
          end_date: untilStr,
          page_size: 100,
        }),
      });
      const campaignData = (await campaignRes.json()) as any;
      for (const row of campaignData.data?.list ?? []) {
        const date = row.dimensions?.stat_time_day?.split(" ")[0];
        const campaignId = String(row.dimensions?.campaign_id ?? "");
        if (!date || !campaignId) continue;
        await (db as any).adCampaign.upsert({
          where: { shop_platform_campaignId_date: { shop: session.shop, platform: "tiktok", campaignId, date } },
          update: {
            campaignName: row.metrics?.campaign_name ?? campaignId,
            spend:       parseFloat(row.metrics?.spend ?? "0"),
            impressions: parseInt(row.metrics?.impressions ?? "0"),
            clicks:      parseInt(row.metrics?.clicks ?? "0"),
            syncedAt:    new Date(),
          },
          create: {
            shop: session.shop,
            platform: "tiktok",
            campaignId,
            campaignName: row.metrics?.campaign_name ?? campaignId,
            date,
            spend:       parseFloat(row.metrics?.spend ?? "0"),
            impressions: parseInt(row.metrics?.impressions ?? "0"),
            clicks:      parseInt(row.metrics?.clicks ?? "0"),
          },
        });
      }

      return json({ success: true, synced, platform: "tiktok" });
    } catch (err) {
      console.error("[TikTok Manual Sync]", err);
      return json({ error: "Sync failed" }, { status: 500 });
    }
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

// ── Helper ────────────────────────────────────────────────────────────────────
function fmtCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n);
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const data = useLoaderData() as SettingsData;

  const [holdThreshold, setHoldThreshold] = useState(String(data.holdMarginThreshold));
  const [alertThreshold, setAlertThreshold] = useState(String(data.alertMarginThreshold));
  const [feePercent, setFeePercent] = useState(String(data.transactionFeePercent));
  const [feeFixed, setFeeFixed] = useState(String(data.transactionFeeFixed));
  const [shippingCost, setShippingCost] = useState(String(data.defaultShippingCost));
  const [alertEmail, setAlertEmail] = useState(data.alertEmail);
  const [showSavedBanner, setShowSavedBanner] = useState(false);

  const submit = useSubmit();
  const metaSyncFetcher = useFetcher();
  const googleSyncFetcher = useFetcher();
  const tiktokSyncFetcher = useFetcher();
  const navigation = useNavigation();

  const isSaving = navigation.state === "submitting";

  const handleSave = () => {
    submit(
      { intent: "saveSettings", holdMarginThreshold: holdThreshold, alertMarginThreshold: alertThreshold, transactionFeePercent: feePercent, transactionFeeFixed: feeFixed, defaultShippingCost: shippingCost, alertEmail },
      { method: "POST" }
    );
    setShowSavedBanner(true);
  };

  const handleConnectMeta = () => {
    const redirectUri = encodeURIComponent(`${data.appUrl}/connect/meta/callback`);
    const scopes = encodeURIComponent("ads_read,ads_management,business_management");
    const state = btoa(data.shop);
    window.open(`https://www.facebook.com/v19.0/dialog/oauth?client_id=${data.metaAppId}&redirect_uri=${redirectUri}&scope=${scopes}&state=${state}&response_type=code`, "_blank");
  };
  const handleConnectGoogle = () => window.open(`${data.appUrl}/connect/google?shop=${data.shop}`, "_blank");
  const handleConnectTiktok = () => window.open(`${data.appUrl}/connect/tiktok?shop=${data.shop}`, "_blank");

  // Derived state for live impact preview
  const feePercentNum = parseFloat(feePercent) || 0;
  const feeFixedNum = parseFloat(feeFixed) || 0;
  const avgOrderValue = 75;
  const avgFeePerOrder = (avgOrderValue * feePercentNum / 100) + feeFixedNum;
  const avgMonthlyFees = avgFeePerOrder * 200;

  const holdThresholdNum = parseFloat(holdThreshold) || 0;
  const holdsActive = holdThresholdNum > 0;

  const hasAnyAd = data.metaConnected || data.googleConnected || data.tiktokConnected;
  const adsNotConnected = !hasAnyAd;

  // Protection status for the Action Center
  const protectionIssues: string[] = [];
  if (!holdsActive) protectionIssues.push("Fulfillment holds are off — unprofitable orders will ship automatically");
  if (!alertEmail) protectionIssues.push("No alert email set — you won't be notified of loss orders");
  if (adsNotConnected) protectionIssues.push("No ad accounts connected — ad spend is missing from profit calculations");

  return (
    <Page title="Settings" backAction={{ content: "Dashboard", url: "/app" }}>
      <Layout>
        {/* Saved banner */}
        {showSavedBanner && !isSaving && (
          <Layout.Section>
            <Banner tone="success" title="Settings saved" onDismiss={() => setShowSavedBanner(false)} />
          </Layout.Section>
        )}

        {/* Protection status — Action Center for settings */}
        <Layout.Section>
          {protectionIssues.length === 0 ? (
            <div style={{ padding: "16px 20px", borderRadius: "12px", background: "#f6ffed", border: "1px solid #b7eb8f" }}>
              <InlineStack gap="200" blockAlign="center">
                <span style={{ fontSize: "18px" }}>✅</span>
                <BlockStack gap="0">
                  <Text variant="headingSm" as="h3">Your store is fully protected</Text>
                  <Text variant="bodySm" as="p" tone="subdued">
                    Holds active · Alerts configured · Ad spend tracked
                  </Text>
                </BlockStack>
              </InlineStack>
            </div>
          ) : (
            <div style={{ padding: "16px 20px", borderRadius: "12px", background: "#fff1f0", border: "1px solid #ffa39e" }}>
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center">
                  <span style={{ fontSize: "18px" }}>⚠️</span>
                  <Text variant="headingSm" as="h3">
                    {`${protectionIssues.length} protection gap${protectionIssues.length > 1 ? "s" : ""} — review below`}
                  </Text>
                </InlineStack>
                {protectionIssues.map((issue, i) => (
                  <InlineStack key={i} gap="200" blockAlign="center">
                    <span style={{ fontSize: "12px", color: "#d92d20", flexShrink: 0 }}>→</span>
                    <Text variant="bodySm" as="p" tone="critical">{issue}</Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </div>
          )}
        </Layout.Section>

        {/* Fulfillment Hold */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">Fulfillment Hold</Text>
                <Badge tone={holdsActive ? "success" : "critical"}>
                  {holdsActive ? "Active" : "Off"}
                </Badge>
              </InlineStack>

              {/* Context — makes it feel consequential */}
              {!holdsActive ? (
                <div style={{ padding: "12px 14px", borderRadius: "8px", background: "#fff1f0", border: "1px solid #ffa39e" }}>
                  <Text variant="bodySm" as="p" tone="critical">
                    Holds are off. Unprofitable orders are shipping without review. Set a threshold to start protecting your margins.
                  </Text>
                </div>
              ) : (
                <div style={{ padding: "12px 14px", borderRadius: "8px", background: "#f6ffed", border: "1px solid #b7eb8f" }}>
                  <Text variant="bodySm" as="p" tone="success">
                    {`Any order with a margin below ${holdThresholdNum}% will be held before shipping. You review and decide.`}
                  </Text>
                </div>
              )}

              <TextField
                label="Hold threshold (%)"
                type="number"
                value={holdThreshold}
                onChange={setHoldThreshold}
                suffix="%"
                autoComplete="off"
                helpText="Set to 0 to disable holds. Set to 10 to hold any order below 10% margin."
              />

              {holdsActive && (
                <Text variant="bodySm" as="p" tone="subdued">
                  You stay in control — held orders appear in your dashboard where you can release or cancel them.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Margin Alerts */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">Margin Alerts</Text>
                <Badge tone={alertEmail ? "success" : "attention"}>
                  {alertEmail ? "Active" : "No email set"}
                </Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                Get an email the moment an order falls below your threshold. You'll know before you've opened your dashboard.
              </Text>
              <TextField
                label="Alert threshold (%)"
                type="number"
                value={alertThreshold}
                onChange={setAlertThreshold}
                suffix="%"
                autoComplete="off"
                helpText="Set to 0 to alert on loss orders only. Set to 10 to alert on all orders below 10%."
              />
              <TextField
                label="Alert email address(es)"
                type="text"
                value={alertEmail}
                onChange={setAlertEmail}
                placeholder="you@example.com, colleague@example.com"
                helpText="Separate multiple addresses with a comma. Also used for weekly P&L summaries (every Monday)."
                autoComplete="off"
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Transaction Fees */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Transaction Fees</Text>
              <Text as="p" tone="subdued">
                Deducted from every order profit calculation. Adjust if you use a different gateway than Shopify Payments (2.9% + $0.30).
              </Text>
              <InlineStack gap="400">
                <Box width="50%">
                  <TextField
                    label="Percentage fee"
                    type="number"
                    value={feePercent}
                    onChange={setFeePercent}
                    suffix="%"
                    autoComplete="off"
                  />
                </Box>
                <Box width="50%">
                  <TextField
                    label="Fixed fee per order"
                    type="number"
                    value={feeFixed}
                    onChange={setFeeFixed}
                    prefix="$"
                    autoComplete="off"
                  />
                </Box>
              </InlineStack>
              {/* Live impact preview */}
              <div style={{ padding: "12px 14px", borderRadius: "8px", background: "#f9fafb", border: "1px solid #e5e7eb" }}>
                <BlockStack gap="050">
                  <Text variant="bodySm" as="p" fontWeight="semibold">With these settings:</Text>
                  <Text variant="bodySm" as="p" tone="subdued">
                    {`Avg fee per $${avgOrderValue} order: ~${fmtCurrency(avgFeePerOrder)}`}
                  </Text>
                  <Text variant="bodySm" as="p" tone="subdued">
                    {`Monthly impact (est. 200 orders): ~${fmtCurrency(avgMonthlyFees)}`}
                  </Text>
                  <Text variant="bodySm" as="p" tone="critical">
                    This is money leaving your business on every sale.
                  </Text>
                </BlockStack>
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Shipping Cost */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Shipping Cost</Text>
              <Text as="p" tone="subdued">
                Your average carrier cost per order. Used in profit calculations when Shopify doesn't provide a shipping cost line.
              </Text>
              <TextField
                label="Default shipping cost"
                type="number"
                value={shippingCost}
                onChange={setShippingCost}
                prefix="$"
                autoComplete="off"
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Ad Integrations */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">Ad Integrations</Text>
                <Badge tone={hasAnyAd ? "success" : "attention"}>
                  {hasAnyAd
                    ? `${[data.metaConnected, data.googleConnected, data.tiktokConnected].filter(Boolean).length} connected`
                    : "None connected"}
                </Badge>
              </InlineStack>

              {adsNotConnected && (
                <div style={{ padding: "12px 14px", borderRadius: "8px", background: "#fff7ed", border: "1px solid #ffd591" }}>
                  <Text variant="bodySm" as="p" tone="caution">
                    Without ad accounts connected, your profit calculations don't include ad spend — margins will appear higher than they really are.
                  </Text>
                </div>
              )}

              <Text as="p" tone="subdued">
                Daily ad spend is allocated proportionally across orders each day based on revenue share. Connect once — syncs automatically.
              </Text>

              <Divider />

              {/* Meta */}
              {renderAdPlatform({
                label: "📘 Meta Ads",
                connected: data.metaConnected,
                accountName: data.metaAccountName,
                onConnect: handleConnectMeta,
                onDisconnect: () => submit({ intent: "disconnectMeta" }, { method: "POST" }),
                onSync: () => metaSyncFetcher.submit({ intent: "syncMeta" }, { method: "POST" }),
                isSyncing: metaSyncFetcher.state === "submitting",
                syncResult: metaSyncFetcher.data as any,
                platform: "Meta",
                submit,
              })}

              <Divider />

              {/* Google */}
              {renderAdPlatform({
                label: "🔍 Google Ads",
                connected: data.googleConnected,
                accountName: data.googleAccountName,
                onConnect: handleConnectGoogle,
                onDisconnect: () => submit({ intent: "disconnectGoogle" }, { method: "POST" }),
                onSync: () => googleSyncFetcher.submit({ intent: "syncGoogle" }, { method: "POST" }),
                isSyncing: googleSyncFetcher.state === "submitting",
                syncResult: googleSyncFetcher.data as any,
                platform: "Google",
                submit,
              })}

              <Divider />

              {/* TikTok */}
              {renderAdPlatform({
                label: "🎵 TikTok Ads",
                connected: data.tiktokConnected,
                accountName: data.tiktokAccountName,
                onConnect: handleConnectTiktok,
                onDisconnect: () => submit({ intent: "disconnectTiktok" }, { method: "POST" }),
                onSync: () => tiktokSyncFetcher.submit({ intent: "syncTiktok" }, { method: "POST" }),
                isSyncing: tiktokSyncFetcher.state === "submitting",
                syncResult: tiktokSyncFetcher.data as any,
                platform: "TikTok",
                submit,
              })}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Button variant="primary" onClick={handleSave} loading={isSaving}>
            Save settings
          </Button>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// ── Ad platform row — extracted to avoid repetition ───────────────────────────
function renderAdPlatform({
  label, connected, accountName, onConnect, onDisconnect, onSync,
  isSyncing, syncResult, platform,
}: {
  label: string;
  connected: boolean;
  accountName: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onSync: () => void;
  isSyncing: boolean;
  syncResult: any;
  platform: string;
  submit: ReturnType<typeof useSubmit>;
}) {
  return (
    <BlockStack gap="200">
      <InlineStack align="space-between" blockAlign="center">
        <BlockStack gap="050">
          <InlineStack gap="200" blockAlign="center">
            <Text variant="bodyMd" as="p" fontWeight="semibold">{label}</Text>
            {connected && <Badge tone="success">Connected</Badge>}
          </InlineStack>
          <Text variant="bodySm" as="p" tone="subdued">
            {connected ? (accountName ?? "Ad account connected") : "Not connected — ad spend excluded from profit"}
          </Text>
        </BlockStack>
        <InlineStack gap="200">
          {connected && (
            <Button size="slim" onClick={onSync} loading={isSyncing}>Sync now</Button>
          )}
          {connected ? (
            <Button variant="plain" tone="critical" onClick={onDisconnect}>Disconnect</Button>
          ) : (
            <Button variant="primary" size="slim" onClick={onConnect}>Connect →</Button>
          )}
        </InlineStack>
      </InlineStack>
      {syncResult?.synced !== undefined && (
        <Banner tone="success">
          <p>{`Synced ${syncResult.synced} days of ${platform} ad spend. Profit calculations updated.`}</p>
        </Banner>
      )}
      {syncResult?.error && (
        <Banner tone="critical">
          <p>{`${platform} sync failed: ${syncResult.error}`}</p>
        </Banner>
      )}
    </BlockStack>
  );
}
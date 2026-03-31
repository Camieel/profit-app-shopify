import { useState } from "react";
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigation, useSubmit, useFetcher } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Box,
  BlockStack,
  Button,
  Banner,
  TextField,
  InlineStack,
  Divider,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

interface SettingsData {
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const [settings, metaIntegration, googleIntegration, tiktokIntegration] =
    await Promise.all([
      db.shopSettings.findUnique({ where: { shop: session.shop } }),
      (db as any).adIntegration.findUnique({
        where: { shop_platform: { shop: session.shop, platform: "meta" } },
      }),
      (db as any).adIntegration.findUnique({
        where: { shop_platform: { shop: session.shop, platform: "google" } },
      }),
      (db as any).adIntegration.findUnique({
        where: { shop_platform: { shop: session.shop, platform: "tiktok" } },
      }),
    ]);

  return json({
    holdMarginThreshold: settings?.holdMarginThreshold ?? 0,
    alertMarginThreshold: settings?.alertMarginThreshold ?? 0,
    transactionFeePercent: settings?.transactionFeePercent ?? 2.9,
    transactionFeeFixed: settings?.transactionFeeFixed ?? 0.3,
    defaultShippingCost: settings?.defaultShippingCost ?? 0,
    alertEmail: settings?.alertEmail ?? "",
    metaConnected: !!(metaIntegration?.isActive),
    metaAccountName: metaIntegration?.accountName ?? null,
    googleConnected: !!(googleIntegration?.isActive),
    googleAccountName: googleIntegration?.accountName ?? null,
    tiktokConnected: !!(tiktokIntegration?.isActive),
    tiktokAccountName: tiktokIntegration?.accountName ?? null,
    shop: session.shop,
    metaAppId: process.env.META_APP_ID || "",
    appUrl:
      process.env.SHOPIFY_APP_URL ||
      "https://profit-app-shopify-production.up.railway.app",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "saveSettings") {
    const holdMarginThreshold =
      parseFloat(formData.get("holdMarginThreshold") as string) || 0;
    await db.shopSettings.upsert({
      where: { shop: session.shop },
      update: {
        holdMarginThreshold,
        holdEnabled: holdMarginThreshold > 0,
        alertMarginThreshold:
          parseFloat(formData.get("alertMarginThreshold") as string) || 0,
        transactionFeePercent:
          parseFloat(formData.get("transactionFeePercent") as string) || 2.9,
        transactionFeeFixed:
          parseFloat(formData.get("transactionFeeFixed") as string) || 0.3,
        defaultShippingCost:
          parseFloat(formData.get("defaultShippingCost") as string) || 0,
        alertEmail: (formData.get("alertEmail") as string) || null,
      },
      create: { shop: session.shop },
    });
    return json({ success: true });
  }

  if (intent === "disconnectMeta") {
    await (db as any).adIntegration.updateMany({
      where: { shop: session.shop, platform: "meta" },
      data: { isActive: false },
    });
    return json({ success: true });
  }

  if (intent === "disconnectGoogle") {
    await (db as any).adIntegration.updateMany({
      where: { shop: session.shop, platform: "google" },
      data: { isActive: false },
    });
    return json({ success: true });
  }

  if (intent === "disconnectTiktok") {
    await (db as any).adIntegration.updateMany({
      where: { shop: session.shop, platform: "tiktok" },
      data: { isActive: false },
    });
    return json({ success: true });
  }

  if (intent === "syncMeta") {
    const integration = await (db as any).adIntegration.findUnique({
      where: { shop_platform: { shop: session.shop, platform: "meta" } },
    });
    if (!integration?.isActive) {
      return json({ error: "Meta not connected" }, { status: 400 });
    }
    try {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      const sinceStr = since.toISOString().split("T")[0];
      const untilStr = new Date().toISOString().split("T")[0];

      const res = await fetch(
        `https://graph.facebook.com/v19.0/${integration.accountId}/insights?` +
          `fields=spend,impressions,clicks,date_start&` +
          `time_increment=1&` +
          `time_range={"since":"${sinceStr}","until":"${untilStr}"}&` +
          `access_token=${integration.accessToken}`
      );
      const data = (await res.json()) as any;

      let synced = 0;
      for (const day of data.data ?? []) {
        await (db as any).adSpend.upsert({
          where: {
            shop_platform_date: {
              shop: session.shop,
              platform: "meta",
              date: day.date_start,
            },
          },
          update: {
            spend: parseFloat(day.spend ?? "0"),
            impressions: parseInt(day.impressions ?? "0"),
            clicks: parseInt(day.clicks ?? "0"),
            syncedAt: new Date(),
          },
          create: {
            shop: session.shop,
            platform: "meta",
            date: day.date_start,
            spend: parseFloat(day.spend ?? "0"),
            impressions: parseInt(day.impressions ?? "0"),
            clicks: parseInt(day.clicks ?? "0"),
          },
        });
        synced++;
      }
      return json({ success: true, synced, platform: "meta" });
    } catch (err) {
      console.error("[Meta Manual Sync] Error:", err);
      return json({ error: "Sync failed" }, { status: 500 });
    }
  }

  if (intent === "syncGoogle") {
    const integration = await (db as any).adIntegration.findUnique({
      where: { shop_platform: { shop: session.shop, platform: "google" } },
    });
    if (!integration?.isActive) {
      return json({ error: "Google not connected" }, { status: 400 });
    }
    try {
      const tokens = JSON.parse(integration.accessToken);
      const accessToken = tokens.accessToken;
      const customerId = integration.accountId;

      const since = new Date();
      since.setDate(since.getDate() - 30);
      const sinceStr = since.toISOString().split("T")[0];
      const untilStr = new Date().toISOString().split("T")[0];

      const query = `
        SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks
        FROM campaign
        WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
      `;

      const res = await fetch(
        `https://googleads.googleapis.com/v17/customers/${customerId}/googleAds:search`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "developer-token": process.env.GOOGLE_DEVELOPER_TOKEN!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query }),
        }
      );
      const data = (await res.json()) as any;

      const byDate = new Map<
        string,
        { spend: number; impressions: number; clicks: number }
      >();
      for (const row of data.results ?? []) {
        const date = row.segments?.date;
        const spend = (row.metrics?.costMicros ?? 0) / 1_000_000;
        const impressions = row.metrics?.impressions ?? 0;
        const clicks = row.metrics?.clicks ?? 0;
        if (!date) continue;
        const existing = byDate.get(date) ?? {
          spend: 0,
          impressions: 0,
          clicks: 0,
        };
        byDate.set(date, {
          spend: existing.spend + spend,
          impressions: existing.impressions + impressions,
          clicks: existing.clicks + clicks,
        });
      }

      let synced = 0;
      for (const [date, metrics] of byDate) {
        await (db as any).adSpend.upsert({
          where: {
            shop_platform_date: {
              shop: session.shop,
              platform: "google",
              date,
            },
          },
          update: { ...metrics, syncedAt: new Date() },
          create: { shop: session.shop, platform: "google", date, ...metrics },
        });
        synced++;
      }
      return json({ success: true, synced, platform: "google" });
    } catch (err) {
      console.error("[Google Manual Sync] Error:", err);
      return json({ error: "Sync failed" }, { status: 500 });
    }
  }

  if (intent === "syncTiktok") {
    const integration = await (db as any).adIntegration.findUnique({
      where: { shop_platform: { shop: session.shop, platform: "tiktok" } },
    });
    if (!integration?.isActive) {
      return json({ error: "TikTok not connected" }, { status: 400 });
    }
    try {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      const sinceStr = since.toISOString().split("T")[0];
      const untilStr = new Date().toISOString().split("T")[0];

      const res = await fetch(
        "https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/",
        {
          method: "POST",
          headers: {
            "Access-Token": integration.accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            advertiser_id: integration.accountId,
            report_type: "BASIC",
            dimensions: ["stat_time_day"],
            metrics: ["spend", "impressions", "clicks"],
            start_date: sinceStr,
            end_date: untilStr,
            page_size: 100,
          }),
        }
      );
      const data = (await res.json()) as any;

      let synced = 0;
      for (const row of data.data?.list ?? []) {
        const date = row.dimensions?.stat_time_day?.split(" ")[0];
        if (!date) continue;
        await (db as any).adSpend.upsert({
          where: {
            shop_platform_date: {
              shop: session.shop,
              platform: "tiktok",
              date,
            },
          },
          update: {
            spend: parseFloat(row.metrics?.spend ?? "0"),
            impressions: parseInt(row.metrics?.impressions ?? "0"),
            clicks: parseInt(row.metrics?.clicks ?? "0"),
            syncedAt: new Date(),
          },
          create: {
            shop: session.shop,
            platform: "tiktok",
            date,
            spend: parseFloat(row.metrics?.spend ?? "0"),
            impressions: parseInt(row.metrics?.impressions ?? "0"),
            clicks: parseInt(row.metrics?.clicks ?? "0"),
          },
        });
        synced++;
      }
      return json({ success: true, synced, platform: "tiktok" });
    } catch (err) {
      console.error("[TikTok Manual Sync] Error:", err);
      return json({ error: "Sync failed" }, { status: 500 });
    }
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

export default function SettingsPage() {
  const data = useLoaderData() as SettingsData;
  const [holdThreshold, setHoldThreshold] = useState(
    String(data.holdMarginThreshold)
  );
  const [alertThreshold, setAlertThreshold] = useState(
    String(data.alertMarginThreshold)
  );
  const [feePercent, setFeePercent] = useState(
    String(data.transactionFeePercent)
  );
  const [feeFixed, setFeeFixed] = useState(String(data.transactionFeeFixed));
  const [shippingCost, setShippingCost] = useState(
    String(data.defaultShippingCost)
  );
  const [alertEmail, setAlertEmail] = useState(data.alertEmail);
  const [showBanner, setShowBanner] = useState(false);

  const submit = useSubmit();
  const metaSyncFetcher = useFetcher();
  const googleSyncFetcher = useFetcher();
  const tiktokSyncFetcher = useFetcher();
  const navigation = useNavigation();

  const isSaving = navigation.state === "submitting";
  const isMetaSyncing = metaSyncFetcher.state === "submitting";
  const isGoogleSyncing = googleSyncFetcher.state === "submitting";
  const isTiktokSyncing = tiktokSyncFetcher.state === "submitting";

  const metaSyncResult = metaSyncFetcher.data as any;
  const googleSyncResult = googleSyncFetcher.data as any;
  const tiktokSyncResult = tiktokSyncFetcher.data as any;

  const handleSave = () => {
    submit(
      {
        intent: "saveSettings",
        holdMarginThreshold: holdThreshold,
        alertMarginThreshold: alertThreshold,
        transactionFeePercent: feePercent,
        transactionFeeFixed: feeFixed,
        defaultShippingCost: shippingCost,
        alertEmail,
      },
      { method: "POST" }
    );
    setShowBanner(true);
  };

  const handleConnectMeta = () => {
    const redirectUri = encodeURIComponent(
      `${data.appUrl}/connect/meta/callback`
    );
    const scopes = encodeURIComponent(
      "ads_read,ads_management,business_management"
    );
    const state = btoa(data.shop);
    window.top!.location.href =
      `https://www.facebook.com/v19.0/dialog/oauth?` +
      `client_id=${data.metaAppId}` +
      `&redirect_uri=${redirectUri}` +
      `&scope=${scopes}` +
      `&state=${state}` +
      `&response_type=code`;
  };

  const handleConnectGoogle = () => {
    window.top!.location.href = `${data.appUrl}/connect/google?shop=${data.shop}`;
  };

  const handleConnectTiktok = () => {
    window.top!.location.href = `${data.appUrl}/connect/tiktok?shop=${data.shop}`;
  };

  return (
    <Page title="Settings" backAction={{ content: "Dashboard", url: "/app" }}>
      <Layout>
        {showBanner && !isSaving && (
          <Layout.Section>
            <Banner
              title="Settings saved"
              tone="success"
              onDismiss={() => setShowBanner(false)}
            />
          </Layout.Section>
        )}

        {/* Fulfillment Hold */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                Fulfillment Hold
              </Text>
              <Text as="p" tone="subdued">
                Orders below this margin % are automatically held before
                shipping. Set to 0 to disable.
              </Text>
              <TextField
                label="Hold threshold (%)"
                type="number"
                value={holdThreshold}
                onChange={setHoldThreshold}
                suffix="%"
                autoComplete="off"
                helpText="Example: 10 means hold any order with less than 10% margin"
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Margin Alerts */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                Margin Alerts
              </Text>
              <Text as="p" tone="subdued">
                Get notified when an order falls below this margin. Set to 0 to
                disable.
              </Text>
              <TextField
                label="Alert threshold (%)"
                type="number"
                value={alertThreshold}
                onChange={setAlertThreshold}
                suffix="%"
                autoComplete="off"
              />
              <TextField
                label="Alert email address(es)"
                type="text"
                value={alertEmail}
                onChange={setAlertEmail}
                placeholder="you@example.com, colleague@example.com"
                helpText="Separate multiple addresses with a comma."
                autoComplete="off"
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Transaction Fees */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                Transaction Fees
              </Text>
              <Text as="p" tone="subdued">
                Default is Shopify Payments (2.9% + $0.30). Adjust if you use a
                different gateway.
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
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Shipping Cost */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                Shipping Cost
              </Text>
              <Text as="p" tone="subdued">
                What you pay the carrier per order on average.
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
              <Text variant="headingMd" as="h2">
                Ad Integrations
              </Text>
              <Text as="p" tone="subdued">
                Connect your ad accounts to include ad spend in profit
                calculations. Spend is allocated proportionally across orders
                each day.
              </Text>

              <Divider />

              {/* Meta */}
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="bodyMd" as="p" fontWeight="semibold">
                      Meta Ads
                    </Text>
                    {data.metaConnected && (
                      <Badge tone="success">Connected</Badge>
                    )}
                  </InlineStack>
                  <Text variant="bodySm" as="p" tone="subdued">
                    {data.metaConnected
                      ? (data.metaAccountName ?? "Ad Account connected")
                      : "Not connected"}
                  </Text>
                </BlockStack>
                <InlineStack gap="200">
                  {data.metaConnected && (
                    <Button
                      size="slim"
                      onClick={() =>
                        metaSyncFetcher.submit(
                          { intent: "syncMeta" },
                          { method: "POST" }
                        )
                      }
                      loading={isMetaSyncing}
                    >
                      Sync now
                    </Button>
                  )}
                  {data.metaConnected ? (
                    <Button
                      variant="plain"
                      tone="critical"
                      onClick={() =>
                        submit(
                          { intent: "disconnectMeta" },
                          { method: "POST" }
                        )
                      }
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="slim"
                      onClick={handleConnectMeta}
                    >
                      Connect Meta Ads
                    </Button>
                  )}
                </InlineStack>
              </InlineStack>
              {metaSyncResult?.synced !== undefined && (
                <Banner tone="success">
                  <p>{"Synced " + metaSyncResult.synced + " days of Meta ad spend."}</p>
                </Banner>
              )}
              {metaSyncResult?.error && (
                <Banner tone="critical">
                  <p>{"Meta sync failed: " + metaSyncResult.error}</p>
                </Banner>
              )}

              <Divider />

              {/* Google */}
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="bodyMd" as="p" fontWeight="semibold">
                      Google Ads
                    </Text>
                    {data.googleConnected && (
                      <Badge tone="success">Connected</Badge>
                    )}
                  </InlineStack>
                  <Text variant="bodySm" as="p" tone="subdued">
                    {data.googleConnected
                      ? (data.googleAccountName ?? "Ad Account connected")
                      : "Not connected"}
                  </Text>
                </BlockStack>
                <InlineStack gap="200">
                  {data.googleConnected && (
                    <Button
                      size="slim"
                      onClick={() =>
                        googleSyncFetcher.submit(
                          { intent: "syncGoogle" },
                          { method: "POST" }
                        )
                      }
                      loading={isGoogleSyncing}
                    >
                      Sync now
                    </Button>
                  )}
                  {data.googleConnected ? (
                    <Button
                      variant="plain"
                      tone="critical"
                      onClick={() =>
                        submit(
                          { intent: "disconnectGoogle" },
                          { method: "POST" }
                        )
                      }
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="slim"
                      onClick={handleConnectGoogle}
                    >
                      Connect Google Ads
                    </Button>
                  )}
                </InlineStack>
              </InlineStack>
              {googleSyncResult?.synced !== undefined && (
                <Banner tone="success">
                  <p>{"Synced " + googleSyncResult.synced + " days of Google ad spend."}</p>
                </Banner>
              )}
              {googleSyncResult?.error && (
                <Banner tone="critical">
                  <p>{"Google sync failed: " + googleSyncResult.error}</p>
                </Banner>
              )}

              <Divider />

              {/* TikTok */}
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="bodyMd" as="p" fontWeight="semibold">
                      TikTok Ads
                    </Text>
                    {data.tiktokConnected && (
                      <Badge tone="success">Connected</Badge>
                    )}
                  </InlineStack>
                  <Text variant="bodySm" as="p" tone="subdued">
                    {data.tiktokConnected
                      ? (data.tiktokAccountName ?? "Ad Account connected")
                      : "Not connected"}
                  </Text>
                </BlockStack>
                <InlineStack gap="200">
                  {data.tiktokConnected && (
                    <Button
                      size="slim"
                      onClick={() =>
                        tiktokSyncFetcher.submit(
                          { intent: "syncTiktok" },
                          { method: "POST" }
                        )
                      }
                      loading={isTiktokSyncing}
                    >
                      Sync now
                    </Button>
                  )}
                  {data.tiktokConnected ? (
                    <Button
                      variant="plain"
                      tone="critical"
                      onClick={() =>
                        submit(
                          { intent: "disconnectTiktok" },
                          { method: "POST" }
                        )
                      }
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="slim"
                      onClick={handleConnectTiktok}
                    >
                      Connect TikTok Ads
                    </Button>
                  )}
                </InlineStack>
              </InlineStack>
              {tiktokSyncResult?.synced !== undefined && (
                <Banner tone="success">
                  <p>{"Synced " + tiktokSyncResult.synced + " days of TikTok ad spend."}</p>
                </Banner>
              )}
              {tiktokSyncResult?.error && (
                <Banner tone="critical">
                  <p>{"TikTok sync failed: " + tiktokSyncResult.error}</p>
                </Banner>
              )}
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
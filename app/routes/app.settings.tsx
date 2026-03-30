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
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const [settings, metaIntegration] = await Promise.all([
    db.shopSettings.findUnique({ where: { shop: session.shop } }),
    (db as any).adIntegration.findUnique({
      where: { shop_platform: { shop: session.shop, platform: "meta" } },
    }),
  ]);

  return json({
    holdMarginThreshold: settings?.holdMarginThreshold ?? 0,
    alertMarginThreshold: settings?.alertMarginThreshold ?? 0,
    transactionFeePercent: settings?.transactionFeePercent ?? 2.9,
    transactionFeeFixed: settings?.transactionFeeFixed ?? 0.30,
    defaultShippingCost: settings?.defaultShippingCost ?? 0,
    alertEmail: settings?.alertEmail ?? "",
    metaConnected: !!(metaIntegration?.isActive),
    metaAccountName: metaIntegration?.accountName ?? null,
  });
};

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
        transactionFeeFixed: parseFloat(formData.get("transactionFeeFixed") as string) || 0.30,
        defaultShippingCost: parseFloat(formData.get("defaultShippingCost") as string) || 0,
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

  if (intent === "syncMeta") {
    const integration = await (db as any).adIntegration.findUnique({
      where: { shop_platform: { shop: session.shop, platform: "meta" } },
    });

    if (!integration?.isActive) {
      return json({ error: "Meta not connected" }, { status: 400 });
    }

    try {
      // Sync last 30 days
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
      const data = await res.json() as any;

      let synced = 0;
      for (const day of data.data ?? []) {
        await (db as any).adSpend.upsert({
          where: { shop_platform_date: { shop: session.shop, platform: "meta", date: day.date_start } },
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

      console.log(`[Meta Manual Sync] Synced ${synced} days for ${session.shop}`);
      return json({ success: true, synced });
    } catch (err) {
      console.error("[Meta Manual Sync] Error:", err);
      return json({ error: "Sync failed" }, { status: 500 });
    }
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

export default function SettingsPage() {
  const data = useLoaderData() as SettingsData;
  const [holdThreshold, setHoldThreshold] = useState(String(data.holdMarginThreshold));
  const [alertThreshold, setAlertThreshold] = useState(String(data.alertMarginThreshold));
  const [feePercent, setFeePercent] = useState(String(data.transactionFeePercent));
  const [feeFixed, setFeeFixed] = useState(String(data.transactionFeeFixed));
  const [shippingCost, setShippingCost] = useState(String(data.defaultShippingCost));
  const [alertEmail, setAlertEmail] = useState(data.alertEmail);
  const [showBanner, setShowBanner] = useState(false);
  const [syncBanner, setSyncBanner] = useState<string | null>(null);

  const submit = useSubmit();
  const syncFetcher = useFetcher();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";
  const isSyncing = syncFetcher.state === "submitting";

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

  const handleMetaSync = () => {
    syncFetcher.submit(
      { intent: "syncMeta" },
      { method: "POST" }
    );
    setSyncBanner(null);
  };

  // Show sync result
  const syncResult = syncFetcher.data as any;

  return (
    <Page title="Settings" backAction={{ content: "Dashboard", url: "/app" }}>
      <Layout>
        {showBanner && !isSaving && (
          <Layout.Section>
            <Banner title="Settings saved" tone="success" onDismiss={() => setShowBanner(false)} />
          </Layout.Section>
        )}

        {/* Fulfillment Hold */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Fulfillment Hold</Text>
              <Text as="p" tone="subdued">
                Orders below this margin % are automatically held. Set to 0 to disable.
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
              <Text variant="headingMd" as="h2">Margin Alerts</Text>
              <Text as="p" tone="subdued">
                Get an email when an order falls below this margin. Set to 0 to disable.
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
                label="Alert email"
                type="email"
                value={alertEmail}
                onChange={setAlertEmail}
                placeholder="you@example.com"
                autoComplete="email"
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
                Default is Shopify Payments (2.9% + $0.30). Adjust if you use a different gateway.
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
              <Text variant="headingMd" as="h2">Shipping Cost</Text>
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
              <Text variant="headingMd" as="h2">Ad Integrations</Text>
              <Text as="p" tone="subdued">
                Connect your ad accounts to include ad spend in profit calculations. Spend is allocated proportionally across orders.
              </Text>
              <Divider />

              {/* Meta */}
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="bodyMd" as="p" fontWeight="semibold">Meta Ads</Text>
                    {data.metaConnected && (
                      <Badge tone="success">Connected</Badge>
                    )}
                  </InlineStack>
                  {data.metaConnected ? (
                    <Text variant="bodySm" as="p" tone="subdued">
                      {data.metaAccountName ?? "Ad Account connected"}
                    </Text>
                  ) : (
                    <Text variant="bodySm" as="p" tone="subdued">
                      Not connected
                    </Text>
                  )}
                </BlockStack>
                <InlineStack gap="200">
                  {data.metaConnected && (
                    <Button
                      size="slim"
                      onClick={handleMetaSync}
                      loading={isSyncing}
                    >
                      Sync now
                    </Button>
                  )}
                  {data.metaConnected ? (
                    <Button
                      variant="plain"
                      tone="critical"
                      onClick={() => submit({ intent: "disconnectMeta" }, { method: "POST" })}
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <Button
  variant="primary"
  size="slim"
  onClick={() => {
    window.top!.location.href = `${window.location.origin}/auth/meta`;
  }}
>
  Connect Meta Ads
</Button>
                  )}
                </InlineStack>
              </InlineStack>

              {syncResult?.synced !== undefined && (
                <Banner tone="success">
                  <p>{"Synced " + syncResult.synced + " days of Meta ad spend."}</p>
                </Banner>
              )}
              {syncResult?.error && (
                <Banner tone="critical">
                  <p>{"Sync failed: " + syncResult.error}</p>
                </Banner>
              )}

              <Divider />

              {/* Google — coming soon */}
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="bodyMd" as="p" fontWeight="semibold">Google Ads</Text>
                    <Badge tone="attention">Coming soon</Badge>
                  </InlineStack>
                  <Text variant="bodySm" as="p" tone="subdued">
                    Google Ads integration coming in the next update.
                  </Text>
                </BlockStack>
              </InlineStack>
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
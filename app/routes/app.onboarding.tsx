import { useState, useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useFetcher, useRevalidator } from "react-router";
import {
  Page, Card, Text, Button, BlockStack, InlineStack, Box,
  Banner, TextField, Select, Checkbox, Divider, Badge,
} from "@shopify/polaris";
import { CheckCircleIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────
interface RecentLoss {
  orderName: string;
  revenue: number;
  netProfit: number;
  currency: string;
}

interface LoaderData {
  totalVariants: number;
  variantsWithCost: number;
  // Aha moment data
  recentOrderCount: number;
  unprofitableOrderCount: number;
  totalLoss7d: number;
  potentialHolds7d: number;
  worstRecentOrder: RecentLoss | null;
  settings: {
    paymentGateway: string;
    transactionFeePercent: number;
    transactionFeeFixed: number;
    shopifyExtraFeePercent: number;
    alertEnabled: boolean;
    alertMarginThreshold: number;
    holdEnabled: boolean;
    holdMarginThreshold: number;
    alertEmail: string | null;
  };
  ads: {
    metaConnected: boolean;
    googleConnected: boolean;
    tiktokConnected: boolean;
    metaAppId: string;
    appUrl: string;
    shop: string;
  };
}

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);

  const [settings, metaIntegration, googleIntegration, tiktokIntegration] = await Promise.all([
    db.shopSettings.findUnique({ where: { shop } }),
    (db as any).adIntegration.findUnique({ where: { shop_platform: { shop, platform: "meta" } } }),
    (db as any).adIntegration.findUnique({ where: { shop_platform: { shop, platform: "google" } } }),
    (db as any).adIntegration.findUnique({ where: { shop_platform: { shop, platform: "tiktok" } } }),
  ]);

  if (settings?.onboardingComplete) {
    return redirect("/app");
  }

  const [totalVariants, variantsWithCost, recentOrders] = await Promise.all([
    db.productVariant.count({ where: { product: { shop } } }),
    db.productVariant.count({ where: { product: { shop }, effectiveCost: { not: null } } }),
    db.order.findMany({
      where: { shop, shopifyCreatedAt: { gte: sevenDaysAgo } },
      select: {
        shopifyOrderName: true, netProfit: true,
        totalPrice: true, currency: true,
      },
      orderBy: { netProfit: "asc" },
      take: 100,
    }),
  ]);

  const unprofitableOrders = recentOrders.filter((o) => o.netProfit < 0);
  const totalLoss7d = unprofitableOrders.reduce((s, o) => s + Math.abs(o.netProfit), 0);
  const worstOrder = unprofitableOrders[0] ?? null;

  return {
    totalVariants,
    variantsWithCost,
    recentOrderCount: recentOrders.length,
    unprofitableOrderCount: unprofitableOrders.length,
    totalLoss7d,
    // Estimate how many would have been held if hold was active
    potentialHolds7d: unprofitableOrders.length,
    worstRecentOrder: worstOrder
      ? {
          orderName: worstOrder.shopifyOrderName,
          revenue: worstOrder.totalPrice,
          netProfit: worstOrder.netProfit,
          currency: worstOrder.currency,
        }
      : null,
    settings: {
      paymentGateway: settings?.paymentGateway ?? "shopify_payments",
      transactionFeePercent: settings?.transactionFeePercent ?? 2.9,
      transactionFeeFixed: settings?.transactionFeeFixed ?? 0.3,
      shopifyExtraFeePercent: settings?.shopifyExtraFeePercent ?? 0.0,
      alertEnabled: settings?.alertEnabled ?? true,
      alertMarginThreshold: settings?.alertMarginThreshold ?? 0,
      holdEnabled: settings?.holdEnabled ?? false,
      holdMarginThreshold: settings?.holdMarginThreshold ?? 0,
      alertEmail: settings?.alertEmail ?? null,
    },
    ads: {
      metaConnected: !!metaIntegration?.isActive,
      googleConnected: !!googleIntegration?.isActive,
      tiktokConnected: !!tiktokIntegration?.isActive,
      metaAppId: process.env.META_APP_ID || "",
      appUrl: process.env.SHOPIFY_APP_URL || "https://profit-app-shopify-production.up.railway.app",
      shop: session.shop,
    },
  } satisfies LoaderData;
};

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "saveFees") {
    await db.shopSettings.update({
      where: { shop },
      data: {
        paymentGateway: formData.get("paymentGateway") as string,
        transactionFeePercent: parseFloat(formData.get("transactionFeePercent") as string) || 2.9,
        transactionFeeFixed: parseFloat(formData.get("transactionFeeFixed") as string) || 0.3,
        shopifyExtraFeePercent: parseFloat(formData.get("shopifyExtraFeePercent") as string) || 0,
      },
    });
    return { ok: true };
  }

  if (intent === "saveAlerts") {
    await db.shopSettings.update({
      where: { shop },
      data: {
        alertEnabled: formData.get("alertEnabled") === "true",
        alertMarginThreshold: parseFloat(formData.get("alertMarginThreshold") as string) || 0,
        holdEnabled: formData.get("holdEnabled") === "true",
        holdMarginThreshold: parseFloat(formData.get("holdMarginThreshold") as string) || 0,
        alertEmail: (formData.get("alertEmail") as string) || null,
      },
    });
    return { ok: true };
  }

  if (intent === "complete") {
    await db.shopSettings.update({ where: { shop }, data: { onboardingComplete: true } });
    return redirect("/app");
  }

  return { ok: true };
};

// ── Constants ─────────────────────────────────────────────────────────────────
const STEPS = ["Welcome", "Product Costs", "Transaction Fees", "Alerts & Holds", "Ad Spend", "Done"];

const GATEWAY_OPTIONS = [
  { label: "Shopify Payments", value: "shopify_payments", percent: 2.9, fixed: 0.3 },
  { label: "Stripe", value: "stripe", percent: 2.9, fixed: 0.3 },
  { label: "PayPal", value: "paypal", percent: 3.49, fixed: 0.49 },
  { label: "Mollie", value: "mollie", percent: 1.8, fixed: 0.25 },
  { label: "Klarna", value: "klarna", percent: 2.99, fixed: 0.35 },
  { label: "Square", value: "square", percent: 2.6, fixed: 0.1 },
  { label: "Adyen", value: "adyen", percent: 0.3, fixed: 0.12 },
  { label: "Authorize.net", value: "authorize_net", percent: 2.9, fixed: 0.3 },
  { label: "Braintree", value: "braintree", percent: 2.59, fixed: 0.49 },
  { label: "Checkout.com", value: "checkout", percent: 1.9, fixed: 0.2 },
  { label: "Razorpay", value: "razorpay", percent: 2.0, fixed: 0.0 },
  { label: "2Checkout (Verifone)", value: "twocheckout", percent: 3.5, fixed: 0.35 },
  { label: "iDEAL (via Mollie)", value: "ideal", percent: 0.29, fixed: 0.0 },
  { label: "Other", value: "other", percent: 2.9, fixed: 0.3 },
];

const EXTRA_FEE_OPTIONS = [
  { label: "None (Shopify Payments)", value: "0" },
  { label: "0.5% (Advanced plan)", value: "0.5" },
  { label: "1.0% (Shopify plan)", value: "1.0" },
  { label: "2.0% (Basic plan)", value: "2.0" },
];

function fmtCurrency(amount: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(amount);
}

// ── Shared components ─────────────────────────────────────────────────────────
function StepIndicator({ step }: { step: number }) {
  const progress = Math.round(((step + 1) / STEPS.length) * 100);
  return (
    <Box paddingBlockEnd="400">
      <BlockStack gap="200">
        <InlineStack align="space-between">
          <Text as="p" variant="bodySm" tone="subdued">
            Step {step + 1} of {STEPS.length} — {STEPS[step]}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">{progress}%</Text>
        </InlineStack>
        {/* Native progress bar — Polaris ProgressBar may not be available */}
        <div style={{ height: "6px", borderRadius: "3px", background: "#e5e7eb", overflow: "hidden" }}>
          <div style={{
            height: "100%", width: `${progress}%`,
            background: "#008060", borderRadius: "3px", transition: "width 0.3s ease",
          }} />
        </div>
      </BlockStack>
    </Box>
  );
}

function NavButtons({
  onNext, nextLabel = "Next", showBack = true, isSaving,
}: {
  onNext: () => void;
  nextLabel?: string;
  showBack?: boolean;
  isSaving: boolean;
}) {
  return (
    <InlineStack align="space-between">
      {showBack
        ? <Button onClick={onNext} disabled={isSaving}>Back</Button>
        : <span />}
      <Button variant="primary" onClick={onNext} loading={isSaving}>{nextLabel}</Button>
    </InlineStack>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Onboarding() {
  const {
    totalVariants, variantsWithCost, settings, ads,
    recentOrderCount, unprofitableOrderCount, totalLoss7d,
    potentialHolds7d, worstRecentOrder,
  } = useLoaderData() as LoaderData;

  const fetcher = useFetcher();
  const { revalidate } = useRevalidator();
  const [step, setStep] = useState(0);

  useEffect(() => {
    const onFocus = () => { if (step === 4) revalidate(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [step, revalidate]);

  const [paymentGateway, setPaymentGateway] = useState(settings.paymentGateway);
  const [feePercent, setFeePercent] = useState(String(settings.transactionFeePercent));
  const [feeFixed, setFeeFixed] = useState(String(settings.transactionFeeFixed));
  const [extraFee, setExtraFee] = useState(String(settings.shopifyExtraFeePercent));
  const [alertEnabled, setAlertEnabled] = useState(settings.alertEnabled);
  const [alertMargin, setAlertMargin] = useState(String(settings.alertMarginThreshold));
  const [holdEnabled, setHoldEnabled] = useState(settings.holdEnabled);
  const [holdMargin, setHoldMargin] = useState(String(settings.holdMarginThreshold));
  const [alertEmail, setAlertEmail] = useState(settings.alertEmail ?? "");

  const isSaving = fetcher.state !== "idle";

  const handleGatewayChange = (value: string) => {
    setPaymentGateway(value);
    const preset = GATEWAY_OPTIONS.find((g) => g.value === value);
    if (preset) { setFeePercent(String(preset.percent)); setFeeFixed(String(preset.fixed)); }
    if (value === "shopify_payments") setExtraFee("0");
  };

  const handleSaveFees = () => {
    fetcher.submit(
      { intent: "saveFees", paymentGateway, transactionFeePercent: feePercent, transactionFeeFixed: feeFixed, shopifyExtraFeePercent: extraFee },
      { method: "POST" }
    );
    setStep(3);
  };

  const handleSaveAlerts = () => {
    fetcher.submit(
      { intent: "saveAlerts", alertEnabled: String(alertEnabled), alertMarginThreshold: alertMargin, holdEnabled: String(holdEnabled), holdMarginThreshold: holdMargin, alertEmail },
      { method: "POST" }
    );
    setStep(4);
  };

  const handleConnectMeta = () => {
    const redirectUri = encodeURIComponent(`${ads.appUrl}/connect/meta/callback`);
    const scopes = encodeURIComponent("ads_read,ads_management,business_management");
    const state = btoa(ads.shop);
    window.open(`https://www.facebook.com/v19.0/dialog/oauth?client_id=${ads.metaAppId}&redirect_uri=${redirectUri}&scope=${scopes}&state=${state}&response_type=code`, "_blank");
    setTimeout(() => revalidate(), 1500);
  };
  const handleConnectGoogle = () => {
    window.open(`${ads.appUrl}/connect/google?shop=${ads.shop}`, "_blank");
    setTimeout(() => revalidate(), 1500);
  };
  const handleConnectTiktok = () => {
    window.open(`${ads.appUrl}/connect/tiktok?shop=${ads.shop}`, "_blank");
    setTimeout(() => revalidate(), 1500);
  };

  // ── STEP 0: Welcome ──────────────────────────────────────────────────────────
  if (step === 0) {
    const hasLossData = unprofitableOrderCount > 0 && recentOrderCount > 0;

    return (
      <Page narrowWidth>
        <StepIndicator step={step} />
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="100">
              <Text as="h1" variant="headingXl">Welcome to ClearProfit 👋</Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                You'll be up and running in 5 minutes.
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Takes ~3 minutes to stop this — let's go.
              </Text>
            </BlockStack>

            <Divider />

            {/* Aha moment — show real loss data if available */}
            {hasLossData ? (
              <div style={{
                padding: "20px", borderRadius: "12px",
                background: "#fff1f0", border: "1px solid #ff4d4f",
              }}>
                <BlockStack gap="300">
                  <BlockStack gap="050">
                    <Text as="h2" variant="headingMd" tone="critical">
                      ⚠️ Your store has unprofitable orders right now
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">Last 7 days · Before ClearProfit was active</Text>
                  </BlockStack>
                  <InlineStack gap="600" wrap>
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" tone="subdued">Orders analyzed</Text>
                      <Text as="p" variant="headingMd">{recentOrderCount}</Text>
                    </BlockStack>
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" tone="subdued">Unprofitable orders</Text>
                      <Text as="p" variant="headingMd" tone="critical">{unprofitableOrderCount}</Text>
                    </BlockStack>
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" tone="subdued">Total loss</Text>
                      <Text as="p" variant="headingMd" tone="critical">
                        {fmtCurrency(totalLoss7d, worstRecentOrder?.currency ?? "USD")}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                  {worstRecentOrder && (
                    <div style={{ padding: "12px 16px", background: "#fff", borderRadius: "8px", border: "1px solid #ffa39e" }}>
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="0">
                          <Text as="p" variant="bodySm" fontWeight="semibold">{worstRecentOrder.orderName}</Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {`Revenue: ${fmtCurrency(worstRecentOrder.revenue, worstRecentOrder.currency)}`}
                          </Text>
                        </BlockStack>
                        <Text as="p" variant="bodyMd" fontWeight="semibold" tone="critical">
                          {fmtCurrency(worstRecentOrder.netProfit, worstRecentOrder.currency)}
                        </Text>
                      </InlineStack>
                    </div>
                  )}
                  <Text as="p" variant="bodySm" tone="critical">
                    {`${potentialHolds7d} of these orders could have been automatically held before shipping.`}
                  </Text>
                  <Text as="p" variant="bodySm" tone="critical" fontWeight="semibold">
                    {`At this rate, you're losing ${fmtCurrency(totalLoss7d * 4, worstRecentOrder?.currency ?? "USD")} per month.`}
                  </Text>
                </BlockStack>
              </div>
            ) : (
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">What does ClearProfit do?</Text>
                {[
                  { icon: "📊", title: "Real-time profit calculation", body: "Every order is calculated instantly: revenue minus COGS, transaction fees, shipping, and ad spend." },
                  { icon: "🛑", title: "Stop losing money automatically", body: "Orders with a margin below your threshold are blocked before they ship — before it's too late." },
                  { icon: "🔔", title: "Alerts on unprofitable orders", body: "Get notified the moment an order falls below your margin threshold." },
                  { icon: "📢", title: "Ad spend integration", body: "Connect Meta, TikTok and Google Ads to include advertising costs in your per-order profit." },
                ].map(({ icon, title, body }) => (
                  <div key={title} style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                    <span style={{ fontSize: "20px", lineHeight: "24px", flexShrink: 0 }}>{icon}</span>
                    <BlockStack gap="0">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">{title}</Text>
                      <Text as="p" variant="bodySm" tone="subdued">{body}</Text>
                    </BlockStack>
                  </div>
                ))}
              </BlockStack>
            )}

            <Divider />

            <InlineStack align="end">
              <Button variant="primary" onClick={() => setStep(1)}>
                {hasLossData ? "Fix this now →" : "Get started →"}
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  // ── STEP 1: Product Costs (COGS) ─────────────────────────────────────────────
  if (step === 1) {
    const missingCogs = totalVariants - variantsWithCost;
    const cogsPercent = totalVariants > 0 ? Math.round((variantsWithCost / totalVariants) * 100) : 0;
    const allGood = missingCogs === 0 && totalVariants > 0;
    const noProducts = totalVariants === 0;

    return (
      <Page narrowWidth>
        <StepIndicator step={step} />
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="100">
              <Text as="h1" variant="headingXl">Product costs (COGS)</Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                COGS is what you actually pay for a product.
              </Text>
            </BlockStack>

            <Divider />

            {/* Harder framing */}
            <div style={{ padding: "14px 16px", borderRadius: "8px", background: "#fff7ed", border: "1px solid #ffd591" }}>
              <Text as="p" variant="bodySm" tone="caution">
                <strong>Orders without cost = fake profit.</strong> If a variant has no cost price, it counts as €0 — making your margin look better than it really is. You might be losing money without knowing it.
              </Text>
            </div>

            {noProducts ? (
              <Banner tone="warning">
                <Text as="p" variant="bodySm">
                  No products have been synced yet. This happens automatically in the background. Check the <strong>Products</strong> page later to set your cost prices.
                </Text>
              </Banner>
            ) : (
              <BlockStack gap="300">
                <Box
                  background={allGood ? "bg-surface-success" : "bg-surface-caution"}
                  padding="400"
                  borderRadius="200"
                >
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {variantsWithCost} / {totalVariants} variants have a cost price
                    </Text>
                    <Badge tone={allGood ? "success" : "warning"}>{cogsPercent + "%"}</Badge>
                  </InlineStack>
                </Box>

                {!allGood && (
                  <Banner tone="warning">
                    <Text as="p" variant="bodySm">
                      {missingCogs} variant{missingCogs !== 1 ? "s are" : " is"} missing a cost price.
                      Set them on the <strong>Products</strong> page, or directly in Shopify via Products → variant → <em>Cost per item</em>.
                    </Text>
                  </Banner>
                )}

                {allGood && (
                  <Banner tone="success">
                    <Text as="p" variant="bodySm">
                      All variants have a cost price. Profit calculation will be accurate from the start.
                    </Text>
                  </Banner>
                )}
              </BlockStack>
            )}

            <Divider />
            <InlineStack align="space-between">
              <Button onClick={() => setStep(0)} disabled={isSaving}>Back</Button>
              <Button variant="primary" onClick={() => setStep(2)}>Next</Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  // ── STEP 2: Transaction Fees ─────────────────────────────────────────────────
  if (step === 2) {
    // Impact calculation — show what this means financially
    const feePercentNum = parseFloat(feePercent) || 2.9;
    const feeFixedNum = parseFloat(feeFixed) || 0.3;
    const avgOrderValue = 75; // reasonable assumption for preview
    const avgFeePerOrder = (avgOrderValue * feePercentNum / 100) + feeFixedNum;
    const monthlyEstimate = avgFeePerOrder * 200; // 200 orders/mo assumption

    return (
      <Page narrowWidth>
        <StepIndicator step={step} />
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="100">
              <Text as="h1" variant="headingXl">Transaction fees</Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Every payment costs money. We deduct it from each order automatically — so your profit is always accurate.
              </Text>
            </BlockStack>

            <Divider />

            <BlockStack gap="400">
              <Select
                label="Payment processor"
                options={GATEWAY_OPTIONS.map((g) => ({ label: g.label, value: g.value }))}
                value={paymentGateway}
                onChange={handleGatewayChange}
                helpText="Selecting a provider fills in the standard rates. Adjust below if needed."
              />

              <InlineStack gap="400">
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Percentage fee"
                    value={feePercent}
                    onChange={setFeePercent}
                    type="number"
                    suffix="%"
                    helpText="e.g. 2.9"
                    autoComplete="off"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Fixed fee per transaction"
                    value={feeFixed}
                    onChange={setFeeFixed}
                    type="number"
                    helpText="e.g. 0.30"
                    autoComplete="off"
                  />
                </div>
              </InlineStack>

              <Select
                label="Extra Shopify fee"
                options={EXTRA_FEE_OPTIONS}
                value={extraFee}
                onChange={setExtraFee}
                disabled={paymentGateway === "shopify_payments"}
                helpText="Shopify charges an extra fee if you don't use Shopify Payments."
              />

              {/* Financial impact preview */}
              <div style={{ padding: "14px 16px", borderRadius: "8px", background: "#f0f9ff", border: "1px solid #bae6fd" }}>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold">With these settings:</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {`Avg fee per €${avgOrderValue} order: ~${fmtCurrency(avgFeePerOrder)}`}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {`Monthly impact (est. 200 orders): ~${fmtCurrency(monthlyEstimate)}`}
                  </Text>
                  <Text as="p" variant="bodySm" tone="critical">
                    This is money leaving your business on every sale.
                  </Text>
                </BlockStack>
              </div>
            </BlockStack>

            <Divider />
            <InlineStack align="space-between">
              <Button onClick={() => setStep(1)} disabled={isSaving}>Back</Button>
              <Button variant="primary" onClick={handleSaveFees} loading={isSaving}>Save & continue</Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  // ── STEP 3: Alerts & Holds ───────────────────────────────────────────────────
  if (step === 3) {
    const hasLossData = unprofitableOrderCount > 0;

    return (
      <Page narrowWidth>
        <StepIndicator step={step} />
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="100">
              {/* Reframed heading */}
              <Text as="h1" variant="headingXl">Stop losing money automatically</Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                This is the core of ClearProfit. Orders that lose you money can be blocked before they ship.
              </Text>
            </BlockStack>

            <Divider />

            {/* Show potential impact from real data */}
            {hasLossData && (
              <div style={{ padding: "14px 16px", borderRadius: "8px", background: "#fff1f0", border: "1px solid #ffa39e" }}>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold" tone="critical">
                    Based on your recent orders:
                  </Text>
                  <Text as="p" variant="bodySm" tone="critical">
                    {`→ ${potentialHolds7d} orders in the last 7 days would have been held`}
                  </Text>
                  <Text as="p" variant="bodySm" tone="critical">
                    {`→ Estimated protected: ${fmtCurrency(totalLoss7d, worstRecentOrder?.currency ?? "USD")}`}
                  </Text>
                </BlockStack>
              </div>
            )}

            <BlockStack gap="400">
              <Checkbox
                label="Enable alerts"
                helpText="Get notified in the dashboard when an order falls below your threshold."
                checked={alertEnabled}
                onChange={setAlertEnabled}
              />

              {alertEnabled && (
                <>
                  <TextField
                    label="Alert when margin drops below (%)"
                    value={alertMargin}
                    onChange={setAlertMargin}
                    type="number"
                    suffix="%"
                    helpText="Set to 0 for negative orders only. Set to 10 to be alerted on all orders below 10%."
                    autoComplete="off"
                  />
                  <TextField
                    label="Alert email address(es)"
                    value={alertEmail}
                    onChange={setAlertEmail}
                    type="email"
                    placeholder="you@example.com, colleague@example.com"
                    helpText="Separate multiple addresses with a comma."
                    autoComplete="off"
                  />
                </>
              )}

              <Divider />

              <Checkbox
                label="Enable automatic fulfillment holds"
                helpText="Unprofitable orders are blocked before they ship. You decide: release or cancel."
                checked={holdEnabled}
                onChange={setHoldEnabled}
              />

              {holdEnabled && (
                <>
                  <TextField
                    label="Hold when margin drops below (%)"
                    value={holdMargin}
                    onChange={setHoldMargin}
                    type="number"
                    suffix="%"
                    helpText="Set to 0 to only hold orders that lose money."
                    autoComplete="off"
                  />
                  <Banner tone="info">
                    <Text as="p" variant="bodySm">
                      Held orders appear in your dashboard under <strong>Held Orders</strong>. You can release or cancel them from there.
                    </Text>
                  </Banner>
                  <Banner tone="success">
                    <Text as="p" variant="bodySm">
                      You stay in control — you can review and release any held order at any time. Nothing ships or cancels without your approval.
                    </Text>
                  </Banner>
                </>
              )}
            </BlockStack>

            <Divider />
            <InlineStack align="space-between">
              <Button onClick={() => setStep(2)} disabled={isSaving}>Back</Button>
              <Button variant="primary" onClick={handleSaveAlerts} loading={isSaving}>Save & continue</Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  // ── STEP 4: Ad Spend ─────────────────────────────────────────────────────────
  if (step === 4) {
    const hasAnyConnection = ads.metaConnected || ads.googleConnected || ads.tiktokConnected;
    const nextLabel = hasAnyConnection ? "Continue" : "Skip for now";

    return (
      <Page narrowWidth>
        <StepIndicator step={step} />
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="100">
              <Text as="h1" variant="headingXl">Ad spend</Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Running ads? Without connecting your ad accounts, your profit calculation is incomplete.
              </Text>
            </BlockStack>

            <Divider />

            {/* Reframed — not "how it works" but "why you need it" */}
            <div style={{ padding: "14px 16px", borderRadius: "8px", background: "#fff7ed", border: "1px solid #ffd591" }}>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" fontWeight="semibold" tone="caution">
                  Without ads connected, your profit is incomplete
                </Text>
                <Text as="p" variant="bodySm" tone="critical">
                  You're likely approving orders that are actually unprofitable.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  If you run Facebook or Google Ads, a portion of that cost belongs to every order. Without this, your margin looks higher than it really is.
                </Text>
              </BlockStack>
            </div>

            <BlockStack gap="300">
              {[
                { icon: "📘", label: "Meta Ads", connected: ads.metaConnected, onConnect: handleConnectMeta },
                { icon: "🔍", label: "Google Ads", connected: ads.googleConnected, onConnect: handleConnectGoogle },
                { icon: "🎵", label: "TikTok Ads", connected: ads.tiktokConnected, onConnect: handleConnectTiktok },
              ].map(({ icon, label, connected, onConnect }) => (
                <Box key={label} padding="400" background="bg-surface-secondary" borderRadius="200" borderWidth="025" borderColor="border">
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="300" blockAlign="center">
                      <span style={{ fontSize: "24px" }}>{icon}</span>
                      <Text as="p" variant="bodyMd" fontWeight="semibold">{label}</Text>
                    </InlineStack>
                    {connected
                      ? <Badge tone="success" icon={CheckCircleIcon}>Linked successfully</Badge>
                      : <Button size="slim" onClick={onConnect}>Connect account</Button>}
                  </InlineStack>
                </Box>
              ))}

              {!hasAnyConnection && (
                <InlineStack align="center">
                  <Button variant="plain" onClick={() => revalidate()}>Refresh connection status</Button>
                </InlineStack>
              )}
            </BlockStack>

            <Divider />
            <InlineStack align="space-between">
              <Button onClick={() => setStep(3)} disabled={isSaving}>Back</Button>
              <Button variant="primary" onClick={() => setStep(5)} loading={isSaving}>{nextLabel}</Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  // ── STEP 5: Done ─────────────────────────────────────────────────────────────
  return (
    <Page narrowWidth>
      <StepIndicator step={step} />
      <Card>
        <BlockStack gap="500">
          <BlockStack gap="100">
            <Text as="h1" variant="headingXl">You're now protected 🎉</Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              ClearProfit is configured. Every new order will now be calculated automatically.
            </Text>
          </BlockStack>

          <Divider />

          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">What's active now:</Text>
            <BlockStack gap="100">
              <Text as="p" variant="bodyMd">✅ Real-time profit calculation on every order</Text>
              <Text as="p" variant="bodyMd">✅ Cost prices synced from Shopify</Text>
              {holdEnabled && <Text as="p" variant="bodyMd">✅ Automatic fulfillment holds — unprofitable orders won't ship</Text>}
              {alertEnabled && <Text as="p" variant="bodyMd">✅ Alerts active — you'll know the moment a margin drops</Text>}
            </BlockStack>
          </BlockStack>

          {/* Momentum CTAs — not just "go to dashboard" */}
          {unprofitableOrderCount > 0 && (
            <div style={{ padding: "16px", borderRadius: "8px", background: "#fff1f0", border: "1px solid #ffa39e" }}>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" fontWeight="semibold" tone="critical">
                  {`${unprofitableOrderCount} unprofitable orders are waiting for your review`}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Go to the dashboard and click "View loss orders" to see them.
                </Text>
              </BlockStack>
            </div>
          )}

          <Banner tone="info">
            <Text as="p" variant="bodySm">
              <strong>Tip:</strong> You can connect or manage ad accounts later via <strong>Settings</strong>.
            </Text>
          </Banner>

          <Divider />

          <Form method="POST">
            <input type="hidden" name="intent" value="complete" />
            <InlineStack align="space-between">
              <Button onClick={() => setStep(4)} disabled={isSaving}>Back</Button>
              {/* Dynamic CTA based on whether there's urgent action */}
              <Button variant="primary" submit loading={isSaving}>
                {unprofitableOrderCount > 0
                  ? `Go to dashboard — fix ${unprofitableOrderCount} loss order${unprofitableOrderCount > 1 ? "s" : ""} →`
                  : "Go to dashboard →"}
              </Button>
            </InlineStack>
          </Form>
        </BlockStack>
      </Card>
    </Page>
  );
}
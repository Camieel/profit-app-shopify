import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useFetcher } from "react-router";
import {
  Page,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  Box,
  Banner,
  TextField,
  Select,
  Checkbox,
  Divider,
  ProgressBar,
  Badge,
  Link,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

interface LoaderData {
  totalVariants: number;
  variantsWithCost: number;
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
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await db.shopSettings.findUnique({ where: { shop } });

  if (settings?.onboardingComplete) {
    return redirect("/app");
  }

  const totalVariants = await db.productVariant.count({
    where: { product: { shop } },
  });
  const variantsWithCost = await db.productVariant.count({
    where: { product: { shop }, effectiveCost: { not: null } },
  });

  return {
    totalVariants,
    variantsWithCost,
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
  } satisfies LoaderData;
};

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
        transactionFeePercent:
          parseFloat(formData.get("transactionFeePercent") as string) || 2.9,
        transactionFeeFixed:
          parseFloat(formData.get("transactionFeeFixed") as string) || 0.3,
        shopifyExtraFeePercent:
          parseFloat(formData.get("shopifyExtraFeePercent") as string) || 0,
      },
    });
    return { ok: true };
  }

  if (intent === "saveAlerts") {
    await db.shopSettings.update({
      where: { shop },
      data: {
        alertEnabled: formData.get("alertEnabled") === "true",
        alertMarginThreshold:
          parseFloat(formData.get("alertMarginThreshold") as string) || 0,
        holdEnabled: formData.get("holdEnabled") === "true",
        holdMarginThreshold:
          parseFloat(formData.get("holdMarginThreshold") as string) || 0,
        alertEmail: (formData.get("alertEmail") as string) || null,
      },
    });
    return { ok: true };
  }

  if (intent === "complete") {
    await db.shopSettings.update({
      where: { shop },
      data: { onboardingComplete: true },
    });
    return redirect("/app");
  }

  return { ok: true };
};

const STEPS = [
  "Welcome",
  "Product Costs",
  "Transaction Fees",
  "Alerts & Holds",
  "Ad Spend",
  "Done",
];

// Payment providers with preset defaults
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

export default function Onboarding() {
  const { totalVariants, variantsWithCost, settings } =
    useLoaderData() as LoaderData;
  const fetcher = useFetcher();
  const [step, setStep] = useState(0);

  // Fee state
  const [paymentGateway, setPaymentGateway] = useState(settings.paymentGateway);
  const [feePercent, setFeePercent] = useState(String(settings.transactionFeePercent));
  const [feeFixed, setFeeFixed] = useState(String(settings.transactionFeeFixed));
  const [extraFee, setExtraFee] = useState(String(settings.shopifyExtraFeePercent));

  // Alert state
  const [alertEnabled, setAlertEnabled] = useState(settings.alertEnabled);
  const [alertMargin, setAlertMargin] = useState(String(settings.alertMarginThreshold));
  const [holdEnabled, setHoldEnabled] = useState(settings.holdEnabled);
  const [holdMargin, setHoldMargin] = useState(String(settings.holdMarginThreshold));
  const [alertEmail, setAlertEmail] = useState(settings.alertEmail ?? "");

  const isSaving = fetcher.state !== "idle";
  const progress = (step / (STEPS.length - 1)) * 100;

  const handleGatewayChange = (value: string) => {
    setPaymentGateway(value);
    const preset = GATEWAY_OPTIONS.find((g) => g.value === value);
    if (preset) {
      setFeePercent(String(preset.percent));
      setFeeFixed(String(preset.fixed));
    }
  };

  const handleSaveFees = () => {
    fetcher.submit(
      {
        intent: "saveFees",
        paymentGateway,
        transactionFeePercent: feePercent,
        transactionFeeFixed: feeFixed,
        shopifyExtraFeePercent: extraFee,
      },
      { method: "POST" }
    );
    setStep(3);
  };

  const handleSaveAlerts = () => {
    fetcher.submit(
      {
        intent: "saveAlerts",
        alertEnabled: String(alertEnabled),
        alertMarginThreshold: alertMargin,
        holdEnabled: String(holdEnabled),
        holdMarginThreshold: holdMargin,
        alertEmail,
      },
      { method: "POST" }
    );
    setStep(4);
  };

  const StepIndicator = () => (
    <Box paddingBlockEnd="400">
      <BlockStack gap="200">
        <InlineStack align="space-between">
          <Text as="p" variant="bodySm" tone="subdued">
            Step {step + 1} of {STEPS.length} — {STEPS[step]}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {Math.round(progress)}%
          </Text>
        </InlineStack>
        <ProgressBar progress={Math.round(progress)} size="small" />
      </BlockStack>
    </Box>
  );

  const NavButtons = ({
    onNext,
    nextLabel = "Next",
    showBack = true,
  }: {
    onNext: () => void;
    nextLabel?: string;
    showBack?: boolean;
  }) => (
    <InlineStack align="space-between">
      {showBack ? (
        <Button onClick={() => setStep((s) => s - 1)} disabled={isSaving}>
          Back
        </Button>
      ) : (
        <span />
      )}
      <Button variant="primary" onClick={onNext} loading={isSaving}>
        {nextLabel}
      </Button>
    </InlineStack>
  );

  // ── STEP 0: Welcome ──────────────────────────────────────────────────────────
  if (step === 0) {
    return (
      <Page narrowWidth>
        <StepIndicator />
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="100">
              <Text as="h1" variant="headingXl">
                Welcome to ClearProfit 👋
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                You'll be up and running in 5 minutes.
              </Text>
            </BlockStack>

            <Divider />

            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                What does ClearProfit do?
              </Text>

              <BlockStack gap="400">
                {[
                  {
                    icon: "📊",
                    title: "Real-time profit calculation",
                    body: "Every order is calculated instantly: revenue minus COGS, transaction fees, shipping, and ad spend.",
                  },
                  {
                    icon: "🛑",
                    title: "Automatic fulfillment holds",
                    body: "Orders with a margin below your threshold are blocked before they ship. You decide what happens next.",
                  },
                  {
                    icon: "🔔",
                    title: "Alerts on unprofitable orders",
                    body: "Get notified the moment an order falls below your margin threshold.",
                  },
                  {
                    icon: "📢",
                    title: "Ad spend integration",
                    body: "Connect Meta and Google Ads to include advertising costs in your per-order profit.",
                  },
                ].map(({ icon, title, body }) => (
                  <div key={title} style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                    <span style={{ fontSize: "20px", lineHeight: "24px", flexShrink: 0 }}>{icon}</span>
                    <BlockStack gap="0">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">
                        {title}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {body}
                      </Text>
                    </BlockStack>
                  </div>
                ))}
              </BlockStack>
            </BlockStack>

            <Divider />

            <InlineStack align="end">
              <Button variant="primary" onClick={() => setStep(1)}>
                Get started →
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
    const cogsPercent =
      totalVariants > 0
        ? Math.round((variantsWithCost / totalVariants) * 100)
        : 0;
    const allGood = missingCogs === 0 && totalVariants > 0;
    const noProducts = totalVariants === 0;

    return (
      <Page narrowWidth>
        <StepIndicator />
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="100">
              <Text as="h1" variant="headingXl">
                Product costs (COGS)
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                COGS is what you pay for a product. Without a cost price, a variant counts as €0 — making your profit look higher than it really is.
              </Text>
            </BlockStack>

            <Divider />

            {noProducts ? (
              <Banner tone="warning">
                <Text as="p" variant="bodySm">
                  No products have been synced yet. This happens automatically in the background. Check the <strong>Products</strong> page later to review and set your cost prices.
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
                    <Badge tone={allGood ? "success" : "warning"}>
                      {cogsPercent + "%"}
                    </Badge>
                  </InlineStack>
                </Box>

                {!allGood && (
                  <Banner tone="warning">
                    <Text as="p" variant="bodySm">
                      {missingCogs} variant{missingCogs !== 1 ? "s are" : " is"} missing a cost price. You can set them on the <strong>Products</strong> page, or directly in Shopify via Products → variant → <em>Cost per item</em>.
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
            <NavButtons onNext={() => setStep(2)} />
          </BlockStack>
        </Card>
      </Page>
    );
  }

  // ── STEP 2: Transaction Fees ─────────────────────────────────────────────────
  if (step === 2) {
    return (
      <Page narrowWidth>
        <StepIndicator />
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="100">
              <Text as="h1" variant="headingXl">
                Transaction fees
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Every payment costs money. Tell us what your payment processor charges so we can deduct it from each order automatically.
              </Text>
            </BlockStack>

            <Divider />

            <BlockStack gap="400">
              <Select
                label="Payment processor"
                options={GATEWAY_OPTIONS.map((g) => ({ label: g.label, value: g.value }))}
                value={paymentGateway}
                onChange={handleGatewayChange}
                helpText="Selecting a provider fills in the standard rates. You can adjust them below."
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
                    prefix="€"
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
                helpText="Shopify charges an additional fee if you don't use Shopify Payments."
              />
            </BlockStack>

            <Divider />
            <NavButtons onNext={handleSaveFees} />
          </BlockStack>
        </Card>
      </Page>
    );
  }

  // ── STEP 3: Alerts & Holds ───────────────────────────────────────────────────
  if (step === 3) {
    return (
      <Page narrowWidth>
        <StepIndicator />
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="100">
              <Text as="h1" variant="headingXl">
                Alerts & fulfillment holds
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                This is the core of ClearProfit. Set when you want to be notified and whether orders should be automatically held before shipping.
              </Text>
            </BlockStack>

            <Divider />

            <BlockStack gap="400">
              <Checkbox
                label="Enable alerts"
                helpText="You'll get a notification in the dashboard when an order falls below your threshold."
                checked={alertEnabled}
                onChange={setAlertEnabled}
              />

              {alertEnabled && (
                <TextField
                  label="Alert when margin drops below (%)"
                  value={alertMargin}
                  onChange={setAlertMargin}
                  type="number"
                  suffix="%"
                  helpText="Set to 0 for negative orders only. Set e.g. 10 to be alerted when margin drops below 10%."
                  autoComplete="off"
                />
              )}

              <TextField
                label="Alert email address(es)"
                value={alertEmail}
                onChange={setAlertEmail}
                type="email"
                placeholder="you@example.com, colleague@example.com"
                helpText="Separate multiple addresses with a comma. You can also configure this later in Settings."
                autoComplete="off"
              />

              <Divider />

              <Checkbox
                label="Enable automatic fulfillment holds"
                helpText="Orders with a margin below your threshold will be blocked before they ship. You decide whether to release or cancel them."
                checked={holdEnabled}
                onChange={setHoldEnabled}
              />

              {holdEnabled && (
                <TextField
                  label="Hold when margin drops below (%)"
                  value={holdMargin}
                  onChange={setHoldMargin}
                  type="number"
                  suffix="%"
                  helpText="Set to 0 to only hold orders that lose money."
                  autoComplete="off"
                />
              )}

              {holdEnabled && (
                <Banner tone="info">
                  <Text as="p" variant="bodySm">
                    Held orders appear in the dashboard under <strong>Pending holds</strong>. You can release or cancel them from there.
                  </Text>
                </Banner>
              )}
            </BlockStack>

            <Divider />
            <NavButtons onNext={handleSaveAlerts} />
          </BlockStack>
        </Card>
      </Page>
    );
  }

  // ── STEP 4: Ad Spend ─────────────────────────────────────────────────────────
  if (step === 4) {
    return (
      <Page narrowWidth>
        <StepIndicator />
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="100">
              <Text as="h1" variant="headingXl">
                Ad spend
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Running ads on Meta or Google? Include those costs in your per-order profit calculation.
              </Text>
            </BlockStack>

            <Divider />

            <BlockStack gap="300">
              <Text as="p" variant="bodyMd">
                ClearProfit distributes your daily ad spend proportionally across all orders from that day. This gives you the true cost of each order.
              </Text>

              <Banner tone="info">
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold">
                    How does the allocation work?
                  </Text>
                  <Text as="p" variant="bodySm">
                    Total daily ad spend ÷ total daily revenue × order value. Each order gets a proportional share of the advertising costs.
                  </Text>
                </BlockStack>
              </Banner>

              <BlockStack gap="200">
                {[
                  { icon: "📘", label: "Meta Ads (Facebook / Instagram)" },
                  { icon: "🔍", label: "Google Ads" },
                ].map(({ icon, label }) => (
                  <div key={label} style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                    <span style={{ fontSize: "18px" }}>{icon}</span>
                    <Text as="p" variant="bodyMd" fontWeight="semibold">{label}</Text>
                  </div>
                ))}
              </BlockStack>

              <Text as="p" variant="bodySm" tone="subdued">
                Connect your ad accounts via <strong>Settings → Ad integrations</strong>. Takes less than 2 minutes per platform and can be done later.
              </Text>
            </BlockStack>

            <Divider />
            <NavButtons onNext={() => setStep(5)} />
          </BlockStack>
        </Card>
      </Page>
    );
  }

  // ── STEP 5: Done ─────────────────────────────────────────────────────────────
  return (
    <Page narrowWidth>
      <StepIndicator />
      <Card>
        <BlockStack gap="500">
          <BlockStack gap="100">
            <Text as="h1" variant="headingXl">
              You're all set! 🎉
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              ClearProfit is configured and ready to go.
            </Text>
          </BlockStack>

          <Divider />

          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              What happens now?
            </Text>
            <BlockStack gap="100">
              <Text as="p" variant="bodyMd">✅ Every new order is automatically calculated</Text>
              <Text as="p" variant="bodyMd">✅ Cost prices are synced from Shopify</Text>
              {holdEnabled && (
                <Text as="p" variant="bodyMd">✅ Fulfillment holds are active</Text>
              )}
              {alertEnabled && (
                <Text as="p" variant="bodyMd">✅ Alerts are enabled</Text>
              )}
            </BlockStack>
          </BlockStack>

          <Banner tone="info">
            <Text as="p" variant="bodySm">
              <strong>Tip:</strong> Connect Meta or Google Ads via <strong>Settings → Ad integrations</strong> for the most accurate profit numbers.
            </Text>
          </Banner>

          <Divider />

          <Form method="POST">
            <input type="hidden" name="intent" value="complete" />
            <InlineStack align="end">
              <Button variant="primary" submit>
                Go to dashboard →
              </Button>
            </InlineStack>
          </Form>
        </BlockStack>
      </Card>
    </Page>
  );
}
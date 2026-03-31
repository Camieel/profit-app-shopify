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
  "Welkom",
  "Kostprijzen",
  "Transactiekosten",
  "Alerts & Holds",
  "Advertenties",
  "Klaar",
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

  const gatewayOptions = [
    { label: "Shopify Payments", value: "shopify_payments" },
    { label: "PayPal", value: "paypal" },
    { label: "Stripe", value: "stripe" },
    { label: "Anders", value: "other" },
  ];

  const extraFeeOptions = [
    { label: "Geen (Shopify Payments)", value: "0" },
    { label: "0.5% (Advanced plan)", value: "0.5" },
    { label: "1.0% (Shopify plan)", value: "1.0" },
    { label: "2.0% (Basic plan)", value: "2.0" },
  ];

  const StepIndicator = () => (
    <Box paddingBlockEnd="400">
      <BlockStack gap="200">
        <InlineStack align="space-between">
          <Text as="p" variant="bodySm" tone="subdued">
            Stap {step + 1} van {STEPS.length} — {STEPS[step]}
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
    nextLabel = "Volgende",
    showBack = true,
  }: { 
    onNext: () => void;
    nextLabel?: string;
    showBack?: boolean;
  }) => (
    <InlineStack align="space-between">
      {showBack ? (
        <Button onClick={() => setStep((s) => s - 1)} disabled={isSaving}>
          Terug
        </Button>
      ) : (
        <span />
      )}
      <Button variant="primary" onClick={onNext} loading={isSaving}>
        {nextLabel}
      </Button>
    </InlineStack>
  );

  // ── STAP 0: Welkom ──────────────────────────────────────────────────────────
  if (step === 0) {
    return (
      <Page narrowWidth>
        <StepIndicator />
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="100">
              <Text as="h1" variant="headingXl">
                Welkom bij ClearProfit 👋
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                In 5 minuten is alles ingesteld.
              </Text>
            </BlockStack>

            <Divider />

            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Wat doet ClearProfit?
              </Text>

              <BlockStack gap="300">
                <InlineStack gap="300" blockAlign="start">
                  <Text as="span" variant="bodyLg">📊</Text>
                  <BlockStack gap="0">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      Real-time winstberekening
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Elke order wordt direct berekend: omzet min COGS,
                      transactiekosten, verzending en ad spend.
                    </Text>
                  </BlockStack>
                </InlineStack>

                <InlineStack gap="300" blockAlign="start">
                  <Text as="span" variant="bodyLg">🛑</Text>
                  <BlockStack gap="0">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      Automatische fulfillment holds
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Orders met een te lage marge worden geblokkeerd vóórdat ze
                      verstuurd worden. Jij beslist wat er daarna mee gebeurt.
                    </Text>
                  </BlockStack>
                </InlineStack>

                <InlineStack gap="300" blockAlign="start">
                  <Text as="span" variant="bodyLg">🔔</Text>
                  <BlockStack gap="0">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      Alerts bij verliesgevende orders
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Krijg een melding zodra een order onder jouw drempel valt.
                    </Text>
                  </BlockStack>
                </InlineStack>

                <InlineStack gap="300" blockAlign="start">
                  <Text as="span" variant="bodyLg">📢</Text>
                  <BlockStack gap="0">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      Ad spend integratie
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Verbind Meta en Google Ads om advertentiekosten mee te
                      rekenen in de winst per order.
                    </Text>
                  </BlockStack>
                </InlineStack>
              </BlockStack>
            </BlockStack>

            <Divider />

            <InlineStack align="end">
              <Button variant="primary" onClick={() => setStep(1)}>
                Begin instellen →
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  // ── STAP 1: COGS ────────────────────────────────────────────────────────────
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
                Kostprijzen (COGS)
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                COGS is wat jij betaalt voor een product. Zonder kostprijs telt
                een variant als €0 mee — waardoor je winst te hoog lijkt.
              </Text>
            </BlockStack>

            <Divider />

            {noProducts ? (
              <Banner tone="warning">
                <Text as="p" variant="bodySm">
                  Er zijn nog geen producten gesynchroniseerd. Dat gebeurt
                  automatisch op de achtergrond. Kom later even terug naar{" "}
                  <strong>Producten</strong> om kostprijzen te controleren.
                </Text>
              </Banner>
            ) : (
              <BlockStack gap="300">
                <Box
                  background={
                    allGood ? "bg-surface-success" : "bg-surface-caution"
                  }
                  padding="400"
                  borderRadius="200"
                >
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {variantsWithCost} / {totalVariants} varianten hebben een
                      kostprijs
                    </Text>
                    <Badge tone={allGood ? "success" : "warning"}>
                      {cogsPercent + "%"}
                    </Badge>
                  </InlineStack>
                </Box>

                {!allGood && (
                  <Banner tone="warning">
                    <Text as="p" variant="bodySm">
                      {missingCogs} variant{missingCogs !== 1 ? "en" : ""}{" "}
                      mist nog een kostprijs. Stel ze in via de{" "}
                      <strong>Producten</strong> pagina, of in Shopify zelf via
                      Producten → variant → <em>Kosten per artikel</em>.
                    </Text>
                  </Banner>
                )}

                {allGood && (
                  <Banner tone="success">
                    <Text as="p" variant="bodySm">
                      Alle varianten hebben een kostprijs. De winstberekening
                      start meteen accuraat.
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

  // ── STAP 2: Transactiekosten ─────────────────────────────────────────────────
  if (step === 2) {
    return (
      <Page narrowWidth>
        <StepIndicator />
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="100">
              <Text as="h1" variant="headingXl">
                Transactiekosten
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Elke betaling kost geld. Stel hier in wat jouw payment processor
                rekent zodat de app dat van elke order aftrekt.
              </Text>
            </BlockStack>

            <Divider />

            <BlockStack gap="400">
              <Select
                label="Payment processor"
                options={gatewayOptions}
                value={paymentGateway}
                onChange={setPaymentGateway}
              />

              <InlineStack gap="400">
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Percentage"
                    value={feePercent}
                    onChange={setFeePercent}
                    type="number"
                    suffix="%"
                    helpText="Bijv. 2.9"
                    autoComplete="off"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Vast bedrag per transactie"
                    value={feeFixed}
                    onChange={setFeeFixed}
                    type="number"
                    prefix="€"
                    helpText="Bijv. 0.30"
                    autoComplete="off"
                  />
                </div>
              </InlineStack>

              <Select
                label="Extra Shopify fee"
                options={extraFeeOptions}
                value={extraFee}
                onChange={setExtraFee}
                helpText="Shopify rekent extra als je niet hun eigen betaalmethode gebruikt."
              />
            </BlockStack>

            <Divider />
            <NavButtons onNext={handleSaveFees} />
          </BlockStack>
        </Card>
      </Page>
    );
  }

  // ── STAP 3: Alerts & Holds ───────────────────────────────────────────────────
  if (step === 3) {
    return (
      <Page narrowWidth>
        <StepIndicator />
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="100">
              <Text as="h1" variant="headingXl">
                Alerts & Fulfillment Holds
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Dit is de kern van ClearProfit. Stel in wanneer je gewaarschuwd
                wilt worden en of orders automatisch tegengehouden moeten worden.
              </Text>
            </BlockStack>

            <Divider />

            <BlockStack gap="400">
              <Checkbox
                label="Alerts inschakelen"
                helpText="Je krijgt een melding in het dashboard als een order onder de drempel valt."
                checked={alertEnabled}
                onChange={setAlertEnabled}
              />

              {alertEnabled && (
                <TextField
                  label="Alert bij marge onder (%)"
                  value={alertMargin}
                  onChange={setAlertMargin}
                  type="number"
                  suffix="%"
                  helpText="Stel 0 in voor alleen negatieve orders. Stel bijv. 10 in om al te waarschuwen als de marge onder 10% valt."
                  autoComplete="off"
                />
              )}

              <TextField
                label="Alert email (optioneel)"
                value={alertEmail}
                onChange={setAlertEmail}
                type="email"
                placeholder="jouw@email.com"
                helpText="Ontvang een email bij elke alert. Kan later ook worden ingesteld via Instellingen."
                autoComplete="off"
              />

              <Divider />

              <Checkbox
                label="Automatische fulfillment hold inschakelen"
                helpText="Orders met een te lage marge worden geblokkeerd vóór verzending. Je beslist daarna zelf of ze alsnog verstuurd worden."
                checked={holdEnabled}
                onChange={setHoldEnabled}
              />

              {holdEnabled && (
                <TextField
                  label="Hold bij marge onder (%)"
                  value={holdMargin}
                  onChange={setHoldMargin}
                  type="number"
                  suffix="%"
                  helpText="Stel 0 in voor alleen verliesgevende orders."
                  autoComplete="off"
                />
              )}

              {holdEnabled && (
                <Banner tone="info">
                  <Text as="p" variant="bodySm">
                    Geblokkeerde orders zijn zichtbaar in het dashboard onder{" "}
                    <strong>Openstaande holds</strong>. Je kunt ze daar
                    vrijgeven of annuleren.
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

  // ── STAP 4: Advertenties ─────────────────────────────────────────────────────
  if (step === 4) {
    return (
      <Page narrowWidth>
        <StepIndicator />
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="100">
              <Text as="h1" variant="headingXl">
                Advertentiekosten
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Adverteer je op Meta of Google? Dan kun je die kosten meenemen
                in de winstberekening per order.
              </Text>
            </BlockStack>

            <Divider />

            <BlockStack gap="300">
              <Text as="p" variant="bodyMd">
                ClearProfit verdeelt je dagelijkse ad spend proportioneel over
                alle orders van die dag. Zo zie je wat een order écht kost.
              </Text>

              <Banner tone="info">
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold">
                    Hoe werkt de allocatie?
                  </Text>
                  <Text as="p" variant="bodySm">
                    Totale dagelijkse ad spend ÷ totale dagomzet × orderwaarde.
                    Elke order krijgt een evenredig deel van de kosten.
                  </Text>
                </BlockStack>
              </Banner>

              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span">📘</Text>
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    Meta Ads (Facebook / Instagram)
                  </Text>
                </InlineStack>
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span">🔍</Text>
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    Google Ads
                  </Text>
                </InlineStack>
              </BlockStack>

              <Text as="p" variant="bodySm" tone="subdued">
                Verbinden doe je via{" "}
                <strong>Instellingen → Ad integraties</strong>. Dit duurt minder
                dan 2 minuten per platform en kan ook later.
              </Text>
            </BlockStack>

            <Divider />
            <NavButtons onNext={() => setStep(5)} />
          </BlockStack>
        </Card>
      </Page>
    );
  }

  // ── STAP 5: Klaar ────────────────────────────────────────────────────────────
  return (
    <Page narrowWidth>
      <StepIndicator />
      <Card>
        <BlockStack gap="500">
          <BlockStack gap="100">
            <Text as="h1" variant="headingXl">
              Je bent klaar! 🎉
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              ClearProfit is ingesteld en klaar om te draaien.
            </Text>
          </BlockStack>

          <Divider />

          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Wat gebeurt er nu?
            </Text>
            <BlockStack gap="100">
              <Text as="p" variant="bodyMd">
                ✅ Elke nieuwe order wordt automatisch berekend
              </Text>
              <Text as="p" variant="bodyMd">
                ✅ Kostprijzen worden gesynchroniseerd vanuit Shopify
              </Text>
              {holdEnabled && (
                <Text as="p" variant="bodyMd">
                  ✅ Fulfillment holds zijn actief
                </Text>
              )}
              {alertEnabled && (
                <Text as="p" variant="bodyMd">
                  ✅ Alerts zijn ingeschakeld
                </Text>
              )}
            </BlockStack>
          </BlockStack>

          <Banner tone="info">
            <Text as="p" variant="bodySm">
              <strong>Tip:</strong> Verbind Meta of Google Ads via{" "}
              <strong>Instellingen → Ad integraties</strong> voor de meest
              accurate winstcijfers.
            </Text>
          </Banner>

          <Divider />

          <Form method="POST">
            <input type="hidden" name="intent" value="complete" />
            <InlineStack align="end">
              <Button variant="primary" submit>
                Naar het dashboard →
              </Button>
            </InlineStack>
          </Form>
        </BlockStack>
      </Card>
    </Page>
  );
}
import { useState } from "react";
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigation, useSubmit } from "react-router";
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
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const settings = await db.shopSettings.findUnique({
    where: { shop: session.shop },
  });

  return json({
    holdMarginThreshold: settings?.holdMarginThreshold ?? 0,
    alertMarginThreshold: settings?.alertMarginThreshold ?? 0,
    transactionFeePercent: settings?.transactionFeePercent ?? 2.9,
    transactionFeeFixed: settings?.transactionFeeFixed ?? 0.30,
    defaultShippingCost: settings?.defaultShippingCost ?? 0,
    alertEmail: settings?.alertEmail ?? "",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

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

  const submit = useSubmit();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  const handleSave = () => {
    submit(
      { holdMarginThreshold: holdThreshold, alertMarginThreshold: alertThreshold,
        transactionFeePercent: feePercent, transactionFeeFixed: feeFixed,
        defaultShippingCost: shippingCost, alertEmail },
      { method: "POST" }
    );
    setShowBanner(true);
  };

  return (
    <Page title="Settings" backAction={{ content: "Dashboard", url: "/app" }}>
      <Layout>
        {showBanner && !isSaving && (
          <Layout.Section>
            <Banner title="Settings saved" tone="success" onDismiss={() => setShowBanner(false)} />
          </Layout.Section>
        )}

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

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Shipping Cost</Text>
              <Text as="p" tone="subdued">
                What you pay the carrier per order on average. Used in profit calculations.
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

        <Layout.Section>
          <Button variant="primary" onClick={handleSave} loading={isSaving}>
            Save settings
          </Button>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
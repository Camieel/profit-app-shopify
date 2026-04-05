// app/routes/app.payment.tsx
// Requires in schema.prisma → ShopSettings: paymentGateways String?

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigation, useSubmit, useFetcher } from "react-router";
import { useState } from "react";
import {
  Page, Layout, Card, Text, Badge, Box, BlockStack, InlineStack,
  Button, TextField, Banner, DataTable, Modal, Select, Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────
interface PaymentGateway {
  id: string;
  name: string;
  percentFee: number;
  fixedFee: number;
  isActive: boolean;
}

interface LoaderData {
  gateways: PaymentGateway[];
  activeGateway: PaymentGateway | null;
  shop: string;
}

// ── Presets ───────────────────────────────────────────────────────────────────
const GATEWAY_PRESETS: Omit<PaymentGateway, "id" | "isActive">[] = [
  { name: "Shopify Payments", percentFee: 2.9, fixedFee: 0.30 },
  { name: "Shopify Payments (Advanced)", percentFee: 2.6, fixedFee: 0.30 },
  { name: "Shopify Payments (Plus)", percentFee: 2.4, fixedFee: 0.30 },
  { name: "Mollie", percentFee: 1.8, fixedFee: 0.25 },
  { name: "PayPal", percentFee: 3.49, fixedFee: 0.49 },
  { name: "Stripe", percentFee: 2.9, fixedFee: 0.30 },
  { name: "iDEAL (via Mollie)", percentFee: 0.0, fixedFee: 0.29 },
  { name: "Klarna", percentFee: 2.99, fixedFee: 0.35 },
  { name: "Bancontact", percentFee: 1.8, fixedFee: 0.25 },
  { name: "Custom gateway", percentFee: 0, fixedFee: 0 },
];

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const rawGateways = (settings as any)?.paymentGateways;

  let gateways: PaymentGateway[] = [];
  try {
    gateways = rawGateways ? JSON.parse(rawGateways) : [];
  } catch {
    gateways = [];
  }

  // Default: if nothing configured yet, seed with Shopify Payments
  if (gateways.length === 0) {
    gateways = [{
      id: newId(),
      name: "Shopify Payments",
      percentFee: settings?.transactionFeePercent ?? 2.9,
      fixedFee: settings?.transactionFeeFixed ?? 0.30,
      isActive: true,
    }];
  }

  const activeGateway = gateways.find((g) => g.isActive) ?? null;

  return json({ gateways, activeGateway, shop });
};

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const settings = await db.shopSettings.findUnique({ where: { shop } });
  let gateways: PaymentGateway[] = [];
  try {
    gateways = (settings as any)?.paymentGateways
      ? JSON.parse((settings as any).paymentGateways)
      : [];
  } catch { gateways = []; }

  if (intent === "saveGateway") {
    const id = formData.get("id") as string;
    const name = formData.get("name") as string;
    const percentFee = parseFloat(formData.get("percentFee") as string) || 0;
    const fixedFee = parseFloat(formData.get("fixedFee") as string) || 0;
    const isActive = formData.get("isActive") === "true";

    if (id) {
      // Update existing
      gateways = gateways.map((g) =>
        g.id === id ? { ...g, name, percentFee, fixedFee } : g
      );
    } else {
      // Add new — deactivate others if this one is active
      const newGateway: PaymentGateway = { id: newId(), name, percentFee, fixedFee, isActive };
      if (isActive) gateways = gateways.map((g) => ({ ...g, isActive: false }));
      gateways.push(newGateway);
    }

    // Sync active gateway fees to main settings fields
    const active = gateways.find((g) => g.isActive);
    await db.shopSettings.upsert({
      where: { shop },
      update: {
        paymentGateways: JSON.stringify(gateways),
        transactionFeePercent: active?.percentFee ?? 2.9,
        transactionFeeFixed: active?.fixedFee ?? 0.30,
      } as any,
      create: {
        shop,
        paymentGateways: JSON.stringify(gateways),
        transactionFeePercent: active?.percentFee ?? 2.9,
        transactionFeeFixed: active?.fixedFee ?? 0.30,
      } as any,
    });
    return json({ success: true });
  }

  if (intent === "deleteGateway") {
    const id = formData.get("id") as string;
    gateways = gateways.filter((g) => g.id !== id);
    const active = gateways.find((g) => g.isActive);
    await db.shopSettings.upsert({
      where: { shop },
      update: {
        paymentGateways: JSON.stringify(gateways),
        transactionFeePercent: active?.percentFee ?? 2.9,
        transactionFeeFixed: active?.fixedFee ?? 0.30,
      } as any,
      create: { shop, paymentGateways: JSON.stringify(gateways) } as any,
    });
    return json({ success: true });
  }

  if (intent === "toggleGateway") {
    const id = formData.get("id") as string;
    // Only one active at a time
    gateways = gateways.map((g) => ({ ...g, isActive: g.id === id }));
    const active = gateways.find((g) => g.isActive)!;
    await db.shopSettings.upsert({
      where: { shop },
      update: {
        paymentGateways: JSON.stringify(gateways),
        transactionFeePercent: active.percentFee,
        transactionFeeFixed: active.fixedFee,
      } as any,
      create: { shop, paymentGateways: JSON.stringify(gateways) } as any,
    });
    return json({ success: true });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

// ── Gateway modal ─────────────────────────────────────────────────────────────
function GatewayModal({ open, onClose, gateway }: {
  open: boolean;
  onClose: () => void;
  gateway: PaymentGateway | null; // null = add new
}) {
  const submit = useSubmit();
  const [preset, setPreset] = useState<string>("");
  const [name, setName] = useState(gateway?.name ?? "");
  const [percentFee, setPercentFee] = useState(String(gateway?.percentFee ?? ""));
  const [fixedFee, setFixedFee] = useState(String(gateway?.fixedFee ?? ""));

  const handlePresetChange = (val: string) => {
    setPreset(val);
    const found = GATEWAY_PRESETS.find((p) => p.name === val);
    if (found) {
      setName(found.name);
      setPercentFee(String(found.percentFee));
      setFixedFee(String(found.fixedFee));
    }
  };

  const handleSave = () => {
    if (!name) return;
    submit(
      {
        intent: "saveGateway",
        id: gateway?.id ?? "",
        name,
        percentFee,
        fixedFee,
        isActive: gateway?.isActive ? "true" : "false",
      },
      { method: "POST" }
    );
    onClose();
  };

  const avgFeePreview = (75 * (parseFloat(percentFee) || 0) / 100) + (parseFloat(fixedFee) || 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={gateway ? "Edit gateway" : "Add payment gateway"}
      primaryAction={{ content: "Save", onAction: handleSave, disabled: !name }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {!gateway && (
            <Select
              label="Choose a preset"
              options={[
                { label: "Select a gateway…", value: "" },
                ...GATEWAY_PRESETS.map((p) => ({ label: p.name, value: p.name })),
              ]}
              value={preset}
              onChange={handlePresetChange}
            />
          )}
          <TextField
            label="Gateway name"
            value={name}
            onChange={setName}
            autoComplete="off"
            placeholder="e.g. Shopify Payments"
          />
          <InlineStack gap="400">
            <Box width="50%">
              <TextField
                label="Percentage fee"
                type="number"
                value={percentFee}
                onChange={setPercentFee}
                suffix="%"
                autoComplete="off"
                helpText="e.g. 2.9 for 2.9%"
              />
            </Box>
            <Box width="50%">
              <TextField
                label="Fixed fee per transaction"
                type="number"
                value={fixedFee}
                onChange={setFixedFee}
                prefix="$"
                autoComplete="off"
                helpText="e.g. 0.30"
              />
            </Box>
          </InlineStack>
          <div style={{ padding: "12px 14px", borderRadius: "8px", background: "#f9fafb", border: "1px solid #e5e7eb" }}>
            <Text variant="bodySm" as="p" tone="subdued">
              {`Preview: avg fee on $75 order = $${avgFeePreview.toFixed(2)}`}
            </Text>
          </div>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ── Toggle button ─────────────────────────────────────────────────────────────
function ToggleGateway({ gateway }: { gateway: PaymentGateway }) {
  const fetcher = useFetcher();
  const isLoading = fetcher.state !== "idle";
  return (
    <Button
      size="slim"
      variant={gateway.isActive ? "primary" : "plain"}
      loading={isLoading}
      onClick={() =>
        fetcher.submit(
          { intent: "toggleGateway", id: gateway.id },
          { method: "POST" }
        )
      }
    >
      {gateway.isActive ? "Active" : "Set active"}
    </Button>
  );
}

// ── Delete button ─────────────────────────────────────────────────────────────
function DeleteGateway({ gateway }: { gateway: PaymentGateway }) {
  const fetcher = useFetcher();
  return (
    <Button
      size="slim"
      variant="plain"
      tone="critical"
      loading={fetcher.state !== "idle"}
      onClick={() =>
        fetcher.submit(
          { intent: "deleteGateway", id: gateway.id },
          { method: "POST" }
        )
      }
      disabled={gateway.isActive}
    >
      Delete
    </Button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function PaymentPage() {
  const { gateways, activeGateway } = useLoaderData() as LoaderData;
  const [modalOpen, setModalOpen] = useState(false);
  const [editGateway, setEditGateway] = useState<PaymentGateway | null>(null);

  const rows = gateways.map((g) => [
    <InlineStack key={g.id + "-name"} gap="200" blockAlign="center">
      <Text variant="bodyMd" as="p" fontWeight={g.isActive ? "semibold" : undefined}>{g.name}</Text>
      {g.isActive && <Badge tone="success">Active</Badge>}
    </InlineStack>,
    `${g.percentFee.toFixed(2)}%`,
    `$${g.fixedFee.toFixed(2)}`,
    <ToggleGateway key={g.id + "-toggle"} gateway={g} />,
    <InlineStack key={g.id + "-actions"} gap="200">
      <Button size="slim" variant="plain" onClick={() => { setEditGateway(g); setModalOpen(true); }}>Edit</Button>
      <DeleteGateway gateway={g} />
    </InlineStack>,
  ]);

  return (
    <Page
      title="Payment Gateways"
      backAction={{ content: "Settings", url: "/app/settings" }}
      primaryAction={{ content: "Add gateway", onAction: () => { setEditGateway(null); setModalOpen(true); } }}
    >
      <Layout>
        <Layout.Section>
          <Banner tone="info">
            <p>
              These gateways calculate the <strong>Transaction Fees</strong> applied during profitability calculation.
              Formula: <code>(Order Total × Fee%) + Fixed Fee</code>. Only one gateway can be active at a time.
            </p>
          </Banner>
        </Layout.Section>

        {activeGateway && (
          <Layout.Section>
            <div style={{ padding: "16px 20px", borderRadius: "12px", background: "#f0fdf8", border: "1px solid #b3e8d8" }}>
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="0">
                  <Text variant="headingSm" as="h3">Currently active: {activeGateway.name}</Text>
                  <Text variant="bodySm" as="p" tone="subdued">
                    {`${activeGateway.percentFee}% + $${activeGateway.fixedFee.toFixed(2)} per transaction`}
                  </Text>
                </BlockStack>
                <Text variant="bodySm" as="p" tone="subdued">
                  {`Avg fee on $75 order: $${((75 * activeGateway.percentFee / 100) + activeGateway.fixedFee).toFixed(2)}`}
                </Text>
              </InlineStack>
            </div>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card padding="0">
            {gateways.length === 0 ? (
              <Box padding="400">
                <Text as="p" tone="subdued">No gateways configured. Add one to start tracking fees accurately.</Text>
              </Box>
            ) : (
              <DataTable
                columnContentTypes={["text", "numeric", "numeric", "text", "text"]}
                headings={["Gateway", "Percentage Fee", "Fixed Fee", "Status", "Actions"]}
                rows={rows}
              />
            )}
          </Card>
        </Layout.Section>
      </Layout>

      <GatewayModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditGateway(null); }}
        gateway={editGateway}
      />
    </Page>
  );
}
// app/routes/app.shipping.tsx
// Requires in schema.prisma → ShopSettings: shippingRules String?

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "react-router";
import { useState } from "react";
import {
  Page, Layout, Card, Text, Badge, Box, BlockStack, InlineStack,
  Button, TextField, Banner, DataTable, Modal, Select, Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────
type RuleType = "flat" | "quantity" | "weight";

interface ShippingRule {
  id: string;
  label: string;         // e.g. "Worldwide", "Netherlands", "France"
  ruleType: RuleType;
  cost: number;          // base cost
  costPerUnit?: number;  // for quantity-based: cost per extra unit above 1
  returnFee: number;     // RTO fee
  isActive: boolean;
}

interface LoaderData {
  rules: ShippingRule[];
  defaultShippingCost: number;
  shop: string;
}

function newId() { return Math.random().toString(36).slice(2, 10); }

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const rawRules = (settings as any)?.shippingRules;

  let rules: ShippingRule[] = [];
  try {
    rules = rawRules ? JSON.parse(rawRules) : [];
  } catch { rules = []; }

  // Default: seed from existing defaultShippingCost if nothing configured
  if (rules.length === 0 && (settings?.defaultShippingCost ?? 0) > 0) {
    rules = [{
      id: newId(),
      label: "Worldwide",
      ruleType: "flat",
      cost: settings!.defaultShippingCost,
      returnFee: 0,
      isActive: true,
    }];
  }

  return json({
    rules,
    defaultShippingCost: settings?.defaultShippingCost ?? 0,
    shop,
  });
};

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const settings = await db.shopSettings.findUnique({ where: { shop } });
  let rules: ShippingRule[] = [];
  try {
    rules = (settings as any)?.shippingRules
      ? JSON.parse((settings as any).shippingRules)
      : [];
  } catch { rules = []; }

  const saveRules = async (newRules: ShippingRule[]) => {
    // Sync worldwide flat rate to defaultShippingCost for backward compat
    const worldwide = newRules.find((r) => r.isActive && r.ruleType === "flat");
    await db.shopSettings.upsert({
      where: { shop },
      update: {
        shippingRules: JSON.stringify(newRules),
        defaultShippingCost: worldwide?.cost ?? settings?.defaultShippingCost ?? 0,
      } as any,
      create: {
        shop,
        shippingRules: JSON.stringify(newRules),
        defaultShippingCost: worldwide?.cost ?? 0,
      } as any,
    });
  };

  if (intent === "saveRule") {
    const id = formData.get("id") as string;
    const label = formData.get("label") as string;
    const ruleType = formData.get("ruleType") as RuleType;
    const cost = parseFloat(formData.get("cost") as string) || 0;
    const costPerUnit = parseFloat(formData.get("costPerUnit") as string) || 0;
    const returnFee = parseFloat(formData.get("returnFee") as string) || 0;

    if (id) {
      rules = rules.map((r) =>
        r.id === id ? { ...r, label, ruleType, cost, costPerUnit, returnFee } : r
      );
    } else {
      rules.push({ id: newId(), label, ruleType, cost, costPerUnit, returnFee, isActive: true });
    }
    await saveRules(rules);
    return json({ success: true });
  }

  if (intent === "deleteRule") {
    const id = formData.get("id") as string;
    rules = rules.filter((r) => r.id !== id);
    await saveRules(rules);
    return json({ success: true });
  }

  if (intent === "toggleRule") {
    const id = formData.get("id") as string;
    rules = rules.map((r) => r.id === id ? { ...r, isActive: !r.isActive } : r);
    await saveRules(rules);
    return json({ success: true });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

// ── Rule modal ────────────────────────────────────────────────────────────────
function RuleModal({ open, onClose, rule }: {
  open: boolean;
  onClose: () => void;
  rule: ShippingRule | null;
}) {
  const fetcher = useFetcher();
  const [label, setLabel] = useState(rule?.label ?? "Worldwide");
  const [ruleType, setRuleType] = useState<RuleType>(rule?.ruleType ?? "flat");
  const [cost, setCost] = useState(String(rule?.cost ?? ""));
  const [costPerUnit, setCostPerUnit] = useState(String(rule?.costPerUnit ?? ""));
  const [returnFee, setReturnFee] = useState(String(rule?.returnFee ?? "0"));

  const handleSave = () => {
    if (!label || !cost) return;
    fetcher.submit(
      {
        intent: "saveRule",
        id: rule?.id ?? "",
        label,
        ruleType,
        cost,
        costPerUnit,
        returnFee,
      },
      { method: "POST" }
    );
    onClose();
  };

  const ruleTypeOptions = [
    { label: "Flat rate — fixed cost per order", value: "flat" },
    { label: "Quantity-based — cost per unit", value: "quantity" },
    { label: "Weight-based — cost per kg", value: "weight" },
  ];

  const ruleTypeDescriptions: Record<RuleType, string> = {
    flat: "Same cost regardless of order size",
    quantity: "Base cost for 1 item, add cost per extra unit",
    weight: "Base cost for 0–1 kg, add cost per extra kg",
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={rule ? "Edit shipping rule" : "New shipping configuration"}
      primaryAction={{ content: "Save & activate", onAction: handleSave, disabled: !label || !cost }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <TextField
            label="Destination label"
            value={label}
            onChange={setLabel}
            autoComplete="off"
            placeholder="e.g. Worldwide, Netherlands, EU"
            helpText="Used as a label in the rates ledger. Applies to all orders unless overridden."
          />
          <Divider />
          <Select
            label="Rule type"
            options={ruleTypeOptions}
            value={ruleType}
            onChange={(v) => setRuleType(v as RuleType)}
          />
          <Text variant="bodySm" as="p" tone="subdued">
            {ruleTypeDescriptions[ruleType]}
          </Text>
          <InlineStack gap="400">
            <Box width="50%">
              <TextField
                label={ruleType === "flat" ? "Shipping cost" : "Base cost (1 item/kg)"}
                type="number"
                value={cost}
                onChange={setCost}
                prefix="$"
                autoComplete="off"
              />
            </Box>
            {ruleType !== "flat" && (
              <Box width="50%">
                <TextField
                  label={ruleType === "quantity" ? "Cost per extra unit" : "Cost per extra kg"}
                  type="number"
                  value={costPerUnit}
                  onChange={setCostPerUnit}
                  prefix="$"
                  autoComplete="off"
                />
              </Box>
            )}
          </InlineStack>
          <TextField
            label="Return (RTO) fee"
            type="number"
            value={returnFee}
            onChange={setReturnFee}
            prefix="$"
            autoComplete="off"
            helpText="Cost deducted on returned orders. Set to 0 to ignore."
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ── Toggle button ─────────────────────────────────────────────────────────────
function ToggleRule({ rule }: { rule: ShippingRule }) {
  const fetcher = useFetcher();
  return (
    <Button
      size="slim"
      variant={rule.isActive ? "primary" : "plain"}
      loading={fetcher.state !== "idle"}
      onClick={() => fetcher.submit({ intent: "toggleRule", id: rule.id }, { method: "POST" })}
    >
      {rule.isActive ? "Active" : "Inactive"}
    </Button>
  );
}

function DeleteRule({ rule }: { rule: ShippingRule }) {
  const fetcher = useFetcher();
  return (
    <Button
      size="slim"
      variant="plain"
      tone="critical"
      loading={fetcher.state !== "idle"}
      onClick={() => fetcher.submit({ intent: "deleteRule", id: rule.id }, { method: "POST" })}
    >
      Delete
    </Button>
  );
}

function ruleTypeBadge(type: RuleType) {
  const labels: Record<RuleType, string> = {
    flat: "Flat rate",
    quantity: "Qty-based",
    weight: "Weight-based",
  };
  return <Badge>{labels[type]}</Badge>;
}

function costDescription(rule: ShippingRule) {
  if (rule.ruleType === "flat") return `$${rule.cost.toFixed(2)}`;
  if (rule.ruleType === "quantity") return `$${rule.cost.toFixed(2)} + $${(rule.costPerUnit ?? 0).toFixed(2)}/unit`;
  return `$${rule.cost.toFixed(2)} + $${(rule.costPerUnit ?? 0).toFixed(2)}/kg`;
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ShippingPage() {
  const { rules, defaultShippingCost } = useLoaderData() as LoaderData;
  const [modalOpen, setModalOpen] = useState(false);
  const [editRule, setEditRule] = useState<ShippingRule | null>(null);

  const rows = rules.map((rule) => [
    <Text key={rule.id + "-label"} variant="bodyMd" as="p" fontWeight={rule.isActive ? "semibold" : undefined}>
      {rule.label}
    </Text>,
    ruleTypeBadge(rule.ruleType),
    costDescription(rule),
    rule.returnFee > 0 ? `$${rule.returnFee.toFixed(2)}` : "—",
    <ToggleRule key={rule.id + "-toggle"} rule={rule} />,
    <InlineStack key={rule.id + "-actions"} gap="200">
      <Button size="slim" variant="plain" onClick={() => { setEditRule(rule); setModalOpen(true); }}>
        Edit
      </Button>
      <DeleteRule rule={rule} />
    </InlineStack>,
  ]);

  const activeRules = rules.filter((r) => r.isActive);

  return (
    <Page
      title="Shipping Configuration"
      backAction={{ content: "Settings", url: "/app/settings" }}
      primaryAction={{
        content: "New shipping rule",
        onAction: () => { setEditRule(null); setModalOpen(true); },
      }}
    >
      <Layout>
        <Layout.Section>
          <Banner tone="info">
            <p>
              Shipping costs are deducted from every order in your profit calculation.
              Rules apply to <strong>all orders</strong> — future destination-based filtering is coming.
              The worldwide flat rate syncs automatically to your default shipping cost.
            </p>
          </Banner>
        </Layout.Section>

        {activeRules.length > 0 && (
          <Layout.Section>
            <Card>
              <InlineStack gap="600" wrap>
                {activeRules.map((r) => (
                  <BlockStack key={r.id} gap="050">
                    <Text variant="bodySm" as="p" tone="subdued">{r.label}</Text>
                    <Text variant="headingMd" as="p">{costDescription(r)}</Text>
                    {r.returnFee > 0 && (
                      <Text variant="bodySm" as="p" tone="subdued">{`RTO: $${r.returnFee.toFixed(2)}`}</Text>
                    )}
                  </BlockStack>
                ))}
              </InlineStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <Text variant="headingSm" as="h2">Active rates ledger</Text>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            {rules.length === 0 ? (
              <Box padding="400">
                <BlockStack gap="200">
                  <Text as="p" tone="subdued">No shipping rules configured yet.</Text>
                  <Button variant="primary" onClick={() => { setEditRule(null); setModalOpen(true); }}>
                    Add first rule
                  </Button>
                </BlockStack>
              </Box>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "numeric", "numeric", "text", "text"]}
                headings={["Destination", "Rule type", "Cost", "Return (RTO)", "Status", "Actions"]}
                rows={rows}
              />
            )}
          </Card>
        </Layout.Section>
      </Layout>

      <RuleModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditRule(null); }}
        rule={editRule}
      />
    </Page>
  );
}
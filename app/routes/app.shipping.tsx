// app/routes/app.shipping.tsx
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "react-router";
import { useState } from "react";
import {
  Page, BlockStack, InlineStack, Button, Banner, Modal, Select, TextField, Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────
type RuleType = "flat" | "quantity" | "weight";

interface ShippingRule {
  id: string;
  label: string;
  ruleType: RuleType;
  cost: number;
  costPerUnit?: number;
  returnFee: number;
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
  let rules: ShippingRule[] = [];
  try { rules = (settings as any)?.shippingRules ? JSON.parse((settings as any).shippingRules) : []; } catch {}
  if (rules.length === 0 && (settings?.defaultShippingCost ?? 0) > 0) {
    rules = [{ id: newId(), label: "Worldwide", ruleType: "flat", cost: settings!.defaultShippingCost, returnFee: 0, isActive: true }];
  }
  return json({ rules, defaultShippingCost: settings?.defaultShippingCost ?? 0, shop });
};

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  let rules: ShippingRule[] = [];
  try { rules = (settings as any)?.shippingRules ? JSON.parse((settings as any).shippingRules) : []; } catch {}

  const saveRules = async (newRules: ShippingRule[]) => {
    const worldwide = newRules.find((r) => r.isActive && r.ruleType === "flat");
    await db.shopSettings.upsert({
      where: { shop },
      update: { shippingRules: JSON.stringify(newRules), defaultShippingCost: worldwide?.cost ?? settings?.defaultShippingCost ?? 0 } as any,
      create: { shop, shippingRules: JSON.stringify(newRules), defaultShippingCost: worldwide?.cost ?? 0 } as any,
    });
  };

  if (intent === "saveRule") {
    const id = formData.get("id") as string;
    const label = formData.get("label") as string;
    const ruleType = formData.get("ruleType") as RuleType;
    const cost = parseFloat(formData.get("cost") as string) || 0;
    const costPerUnit = parseFloat(formData.get("costPerUnit") as string) || 0;
    const returnFee = parseFloat(formData.get("returnFee") as string) || 0;
    if (id) { rules = rules.map((r) => r.id === id ? { ...r, label, ruleType, cost, costPerUnit, returnFee } : r); }
    else { rules.push({ id: newId(), label, ruleType, cost, costPerUnit, returnFee, isActive: true }); }
    await saveRules(rules);
    return json({ success: true });
  }
  if (intent === "deleteRule") { rules = rules.filter((r) => r.id !== (formData.get("id") as string)); await saveRules(rules); return json({ success: true }); }
  if (intent === "toggleRule") { const id = formData.get("id") as string; rules = rules.map((r) => r.id === id ? { ...r, isActive: !r.isActive } : r); await saveRules(rules); return json({ success: true }); }
  return json({ error: "Unknown intent" }, { status: 400 });
};

// ── Design tokens ─────────────────────────────────────────────────────────────
const tokens = {
  profit: "#16a34a", profitBg: "#f0fdf4", profitBorder: "#bbf7d0",
  loss: "#dc2626", lossBg: "#fef2f2", lossBorder: "#fecaca",
  border: "#e2e8f0", cardBg: "#ffffff",
  text: "#0f172a", textMuted: "#64748b",
};

function DCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: tokens.cardBg, border: `1px solid ${tokens.border}`, borderRadius: "12px", overflow: "hidden", ...style }}>{children}</div>;
}

function DBadge({ children, variant = "default", size = "md" }: {
  children: React.ReactNode;
  variant?: "default" | "success" | "warning" | "neutral";
  size?: "sm" | "md";
}) {
  const colors: Record<string, { bg: string; color: string; border: string }> = {
    default: { bg: "#f1f5f9", color: "#475569", border: "#e2e8f0" },
    success: { bg: tokens.profitBg, color: tokens.profit, border: tokens.profitBorder },
    warning: { bg: "#fffbeb", color: "#d97706", border: "#fde68a" },
    neutral: { bg: "#f8fafc", color: tokens.textMuted, border: tokens.border },
  };
  const c = colors[variant];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: size === "sm" ? "2px 8px" : "3px 10px", borderRadius: "100px",
      fontSize: size === "sm" ? "11px" : "12px", fontWeight: 600,
      background: c.bg, color: c.color, border: `1px solid ${c.border}`,
    }}>{children}</span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function costDescription(rule: ShippingRule) {
  if (rule.ruleType === "flat") return `$${rule.cost.toFixed(2)} flat`;
  if (rule.ruleType === "quantity") return `$${rule.cost.toFixed(2)} + $${(rule.costPerUnit ?? 0).toFixed(2)}/unit`;
  return `$${rule.cost.toFixed(2)} + $${(rule.costPerUnit ?? 0).toFixed(2)}/kg`;
}

const ruleTypeLabels: Record<RuleType, string> = {
  flat: "Flat rate",
  quantity: "Qty-based",
  weight: "Weight-based",
};

const ruleTypeIcons: Record<RuleType, string> = {
  flat: "📦",
  quantity: "📊",
  weight: "⚖️",
};

// ── Rule modal ────────────────────────────────────────────────────────────────
function RuleModal({ open, onClose, rule }: { open: boolean; onClose: () => void; rule: ShippingRule | null }) {
  const fetcher = useFetcher();
  const [label, setLabel] = useState(rule?.label ?? "Worldwide");
  const [ruleType, setRuleType] = useState<RuleType>(rule?.ruleType ?? "flat");
  const [cost, setCost] = useState(String(rule?.cost ?? ""));
  const [costPerUnit, setCostPerUnit] = useState(String(rule?.costPerUnit ?? ""));
  const [returnFee, setReturnFee] = useState(String(rule?.returnFee ?? "0"));

  const handleSave = () => {
    if (!label || !cost) return;
    fetcher.submit({ intent: "saveRule", id: rule?.id ?? "", label, ruleType, cost, costPerUnit, returnFee }, { method: "POST" });
    onClose();
  };

  const avgPreview = ruleType === "flat"
    ? `$${(parseFloat(cost) || 0).toFixed(2)} per order`
    : ruleType === "quantity"
    ? `$${(parseFloat(cost) || 0).toFixed(2)} for 1 item, +$${(parseFloat(costPerUnit) || 0).toFixed(2)} each extra`
    : `$${(parseFloat(cost) || 0).toFixed(2)} up to 1kg, +$${(parseFloat(costPerUnit) || 0).toFixed(2)}/kg`;

  return (
    <Modal
      open={open} onClose={onClose}
      title={rule ? "Edit shipping rule" : "Add shipping rule"}
      primaryAction={{ content: "Save", onAction: handleSave, disabled: !label || !cost }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <TextField
            label="Destination label" value={label} onChange={setLabel}
            autoComplete="off" placeholder="e.g. Worldwide, Netherlands, EU"
            helpText="Applies to all orders unless destination-based rules are added later."
          />
          <Select
            label="Rule type"
            options={[
              { label: "Flat rate — fixed cost per order", value: "flat" },
              { label: "Quantity-based — cost per unit", value: "quantity" },
              { label: "Weight-based — cost per kg", value: "weight" },
            ]}
            value={ruleType}
            onChange={(v) => setRuleType(v as RuleType)}
          />
          <div style={{ display: "grid", gridTemplateColumns: ruleType === "flat" ? "1fr" : "1fr 1fr", gap: "16px" }}>
            <TextField
              label={ruleType === "flat" ? "Shipping cost" : "Base cost (1 item/kg)"}
              type="number" value={cost} onChange={setCost} prefix="$" autoComplete="off"
            />
            {ruleType !== "flat" && (
              <TextField
                label={ruleType === "quantity" ? "Cost per extra unit" : "Cost per extra kg"}
                type="number" value={costPerUnit} onChange={setCostPerUnit} prefix="$" autoComplete="off"
              />
            )}
          </div>
          <TextField
            label="Return (RTO) fee" type="number" value={returnFee} onChange={setReturnFee}
            prefix="$" autoComplete="off"
            helpText="Deducted on returned orders. Set to 0 to ignore."
          />
          {/* Preview */}
          <div style={{ padding: "10px 14px", borderRadius: "8px", background: "#f8fafc", border: `1px solid ${tokens.border}` }}>
            <p style={{ margin: 0, fontSize: "13px", color: tokens.textMuted }}>
              Preview: <strong style={{ color: tokens.text }}>{avgPreview}</strong>
            </p>
          </div>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ── Inline toggle/delete ──────────────────────────────────────────────────────
function ToggleRule({ rule }: { rule: ShippingRule }) {
  const fetcher = useFetcher();
  return (
    <button
      onClick={() => fetcher.submit({ intent: "toggleRule", id: rule.id }, { method: "POST" })}
      disabled={fetcher.state !== "idle"}
      style={{
        padding: "4px 12px", borderRadius: "8px",
        background: rule.isActive ? tokens.profitBg : "transparent",
        color: rule.isActive ? tokens.profit : tokens.textMuted,
        border: `1px solid ${rule.isActive ? tokens.profitBorder : tokens.border}`,
        cursor: "pointer", fontSize: "12px", fontWeight: 600,
        opacity: fetcher.state !== "idle" ? 0.6 : 1, transition: "all 0.15s",
      }}
    >
      {rule.isActive ? "Active" : "Inactive"}
    </button>
  );
}

function DeleteRule({ rule }: { rule: ShippingRule }) {
  const fetcher = useFetcher();
  return (
    <button
      onClick={() => fetcher.submit({ intent: "deleteRule", id: rule.id }, { method: "POST" })}
      disabled={fetcher.state !== "idle"}
      style={{
        background: "none", border: "none", cursor: "pointer",
        fontSize: "12px", color: tokens.loss, fontWeight: 500,
        textDecoration: "underline", padding: 0,
        opacity: fetcher.state !== "idle" ? 0.6 : 1,
      }}
    >
      Delete
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ShippingPage() {
  const { rules } = useLoaderData() as LoaderData;
  const [modalOpen, setModalOpen] = useState(false);
  const [editRule, setEditRule] = useState<ShippingRule | null>(null);

  const activeRules = rules.filter((r) => r.isActive);

  return (
    <Page
      title="Shipping Configuration"
      backAction={{ content: "Settings", url: "/app/settings" }}
      primaryAction={{ content: "Add rule", onAction: () => { setEditRule(null); setModalOpen(true); } }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

        {/* Info */}
        <Banner tone="info">
          <p>
            Shipping costs are deducted from every order in your profit calculation.
            The active worldwide flat rate syncs to your default shipping cost automatically.
          </p>
        </Banner>

        {/* Active summary */}
        {activeRules.length > 0 && (
          <DCard>
            <div style={{ padding: "16px 20px", borderBottom: `1px solid ${tokens.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <p style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: tokens.text }}>Active rates</p>
              <DBadge variant="success" size="sm">{activeRules.length} active</DBadge>
            </div>
            <div style={{ display: "flex", gap: "0", flexWrap: "wrap" }}>
              {activeRules.map((r, i) => (
                <div
                  key={r.id}
                  style={{
                    padding: "16px 24px",
                    borderRight: i < activeRules.length - 1 ? `1px solid ${tokens.border}` : undefined,
                    minWidth: "160px",
                  }}
                >
                  <p style={{ margin: "0 0 4px", fontSize: "11px", fontWeight: 500, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {ruleTypeIcons[r.ruleType]} {r.label}
                  </p>
                  <p style={{ margin: "0 0 2px", fontSize: "20px", fontWeight: 700, color: tokens.text, letterSpacing: "-0.02em" }}>
                    {costDescription(r)}
                  </p>
                  {r.returnFee > 0 && (
                    <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>RTO: ${r.returnFee.toFixed(2)}</p>
                  )}
                </div>
              ))}
            </div>
          </DCard>
        )}

        {/* Rules table */}
        <DCard>
          {/* Header */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 180px 100px 100px auto", padding: "10px 20px", borderBottom: `1px solid ${tokens.border}`, background: "#f8fafc" }}>
            {["Destination", "Type", "Cost", "RTO fee", "Status", "Actions"].map((h) => (
              <span key={h} style={{ fontSize: "11px", fontWeight: 700, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</span>
            ))}
          </div>

          {rules.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center" }}>
              <p style={{ margin: "0 0 12px", fontSize: "15px", fontWeight: 600, color: tokens.text }}>No shipping rules yet</p>
              <p style={{ margin: "0 0 16px", fontSize: "13px", color: tokens.textMuted }}>Add your first rule to start tracking shipping costs accurately.</p>
              <button
                onClick={() => { setEditRule(null); setModalOpen(true); }}
                style={{ padding: "8px 20px", borderRadius: "8px", background: tokens.text, color: "#fff", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}
              >
                Add first rule
              </button>
            </div>
          ) : (
            rules.map((rule, i) => (
              <div
                key={rule.id}
                style={{
                  display: "grid", gridTemplateColumns: "1fr 120px 180px 100px 100px auto",
                  padding: "14px 20px",
                  borderBottom: i < rules.length - 1 ? `1px solid ${tokens.border}` : undefined,
                  background: rule.isActive ? tokens.profitBg : tokens.cardBg,
                  alignItems: "center", transition: "background 0.15s",
                }}
              >
                {/* Label */}
                <div>
                  <p style={{ margin: 0, fontSize: "14px", fontWeight: rule.isActive ? 700 : 500, color: tokens.text }}>{rule.label}</p>
                </div>
                {/* Type */}
                <DBadge variant="neutral" size="sm">{ruleTypeLabels[rule.ruleType]}</DBadge>
                {/* Cost */}
                <p style={{ margin: 0, fontSize: "13px", fontWeight: 600, color: tokens.text }}>{costDescription(rule)}</p>
                {/* RTO */}
                <p style={{ margin: 0, fontSize: "13px", color: tokens.textMuted }}>
                  {rule.returnFee > 0 ? `$${rule.returnFee.toFixed(2)}` : "—"}
                </p>
                {/* Toggle */}
                <ToggleRule rule={rule} />
                {/* Actions */}
                <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                  <button
                    onClick={() => { setEditRule(rule); setModalOpen(true); }}
                    style={{ background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "#2563eb", fontWeight: 500, textDecoration: "underline", padding: 0 }}
                  >
                    Edit
                  </button>
                  <DeleteRule rule={rule} />
                </div>
              </div>
            ))
          )}
        </DCard>

        {/* How it works */}
        <div style={{ padding: "14px 20px", borderRadius: "10px", background: "#f8fafc", border: `1px solid ${tokens.border}` }}>
          <p style={{ margin: "0 0 8px", fontSize: "13px", fontWeight: 700, color: tokens.text }}>How shipping costs are applied</p>
          <p style={{ margin: "0 0 4px", fontSize: "13px", color: tokens.textMuted }}>
            The active rate is deducted from every order. For quantity-based rules, the formula is:
          </p>
          <p style={{ margin: 0 }}>
            <code style={{ background: "#e2e8f0", padding: "2px 8px", borderRadius: "4px", fontSize: "12px" }}>
              Base cost + (extra units × cost per unit)
            </code>
          </p>
        </div>

      </div>

      <RuleModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditRule(null); }}
        rule={editRule}
      />
    </Page>
  );
}
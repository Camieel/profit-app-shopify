// app/routes/app.payment.tsx
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useFetcher } from "react-router";
import { useState } from "react";
import {
  Page, BlockStack, InlineStack, Button, Banner, Modal, Select,
  TextField, Box, Text, Badge,
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
  { name: "Shopify Payments",           percentFee: 2.9,  fixedFee: 0.30 },
  { name: "Shopify Payments (Advanced)",percentFee: 2.6,  fixedFee: 0.30 },
  { name: "Shopify Payments (Plus)",    percentFee: 2.4,  fixedFee: 0.30 },
  { name: "Mollie",                     percentFee: 1.8,  fixedFee: 0.25 },
  { name: "PayPal",                     percentFee: 3.49, fixedFee: 0.49 },
  { name: "Stripe",                     percentFee: 2.9,  fixedFee: 0.30 },
  { name: "iDEAL (via Mollie)",         percentFee: 0.0,  fixedFee: 0.29 },
  { name: "Klarna",                     percentFee: 2.99, fixedFee: 0.35 },
  { name: "Bancontact",                 percentFee: 1.8,  fixedFee: 0.25 },
  { name: "Custom gateway",             percentFee: 0,    fixedFee: 0    },
];

function newId() { return Math.random().toString(36).slice(2, 10); }

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  let gateways: PaymentGateway[] = [];
  try { gateways = (settings as any)?.paymentGateways ? JSON.parse((settings as any).paymentGateways) : []; } catch {}
  if (gateways.length === 0) {
    gateways = [{ id: newId(), name: "Shopify Payments", percentFee: settings?.transactionFeePercent ?? 2.9, fixedFee: settings?.transactionFeeFixed ?? 0.30, isActive: true }];
  }
  return json({ gateways, activeGateway: gateways.find((g) => g.isActive) ?? null, shop });
};

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  let gateways: PaymentGateway[] = [];
  try { gateways = (settings as any)?.paymentGateways ? JSON.parse((settings as any).paymentGateways) : []; } catch {}

  const save = async (updated: PaymentGateway[]) => {
    const active = updated.find((g) => g.isActive);
    await db.shopSettings.upsert({
      where: { shop },
      update: { paymentGateways: JSON.stringify(updated), transactionFeePercent: active?.percentFee ?? 2.9, transactionFeeFixed: active?.fixedFee ?? 0.30 } as any,
      create: { shop, paymentGateways: JSON.stringify(updated), transactionFeePercent: active?.percentFee ?? 2.9, transactionFeeFixed: active?.fixedFee ?? 0.30 } as any,
    });
  };

  if (intent === "saveGateway") {
    const id = formData.get("id") as string;
    const name = formData.get("name") as string;
    const percentFee = parseFloat(formData.get("percentFee") as string) || 0;
    const fixedFee = parseFloat(formData.get("fixedFee") as string) || 0;
    if (id) { gateways = gateways.map((g) => g.id === id ? { ...g, name, percentFee, fixedFee } : g); }
    else {
      const isActive = formData.get("isActive") === "true";
      if (isActive) gateways = gateways.map((g) => ({ ...g, isActive: false }));
      gateways.push({ id: newId(), name, percentFee, fixedFee, isActive });
    }
    await save(gateways);
    return json({ success: true });
  }
  if (intent === "deleteGateway") {
    gateways = gateways.filter((g) => g.id !== (formData.get("id") as string));
    await save(gateways);
    return json({ success: true });
  }
  if (intent === "toggleGateway") {
    const id = formData.get("id") as string;
    gateways = gateways.map((g) => ({ ...g, isActive: g.id === id }));
    await save(gateways);
    return json({ success: true });
  }
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
  return (
    <div style={{ background: tokens.cardBg, border: `1px solid ${tokens.border}`, borderRadius: "12px", overflow: "hidden", ...style }}>
      {children}
    </div>
  );
}

function DBadge({ children, variant = "default", size = "md" }: {
  children: React.ReactNode;
  variant?: "default" | "success" | "danger" | "warning";
  size?: "sm" | "md";
}) {
  const colors: Record<string, { bg: string; color: string; border: string }> = {
    default: { bg: "#f1f5f9", color: "#475569", border: "#e2e8f0" },
    success: { bg: tokens.profitBg, color: tokens.profit, border: tokens.profitBorder },
    danger:  { bg: tokens.lossBg, color: tokens.loss, border: tokens.lossBorder },
    warning: { bg: "#fffbeb", color: "#d97706", border: "#fde68a" },
  };
  const c = colors[variant];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: size === "sm" ? "2px 8px" : "3px 10px", borderRadius: "100px",
      fontSize: size === "sm" ? "11px" : "12px", fontWeight: 600,
      background: c.bg, color: c.color, border: `1px solid ${c.border}`,
    }}>
      {children}
    </span>
  );
}

// ── Gateway modal ─────────────────────────────────────────────────────────────
function GatewayModal({ open, onClose, gateway }: {
  open: boolean; onClose: () => void; gateway: PaymentGateway | null;
}) {
  const submit = useSubmit();
  const [preset, setPreset] = useState("");
  const [name, setName] = useState(gateway?.name ?? "");
  const [percentFee, setPercentFee] = useState(String(gateway?.percentFee ?? ""));
  const [fixedFee, setFixedFee] = useState(String(gateway?.fixedFee ?? ""));

  const handlePresetChange = (val: string) => {
    setPreset(val);
    const found = GATEWAY_PRESETS.find((p) => p.name === val);
    if (found) { setName(found.name); setPercentFee(String(found.percentFee)); setFixedFee(String(found.fixedFee)); }
  };

  const handleSave = () => {
    if (!name) return;
    submit({ intent: "saveGateway", id: gateway?.id ?? "", name, percentFee, fixedFee, isActive: gateway?.isActive ? "true" : "false" }, { method: "POST" });
    onClose();
  };

  const avgFeePreview = (75 * (parseFloat(percentFee) || 0) / 100) + (parseFloat(fixedFee) || 0);

  return (
    <Modal
      open={open} onClose={onClose}
      title={gateway ? "Edit gateway" : "Add payment gateway"}
      primaryAction={{ content: "Save", onAction: handleSave, disabled: !name }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {!gateway && (
            <Select
              label="Choose a preset"
              options={[{ label: "Select a gateway…", value: "" }, ...GATEWAY_PRESETS.map((p) => ({ label: p.name, value: p.name }))]}
              value={preset}
              onChange={handlePresetChange}
            />
          )}
          <TextField label="Gateway name" value={name} onChange={setName} autoComplete="off" placeholder="e.g. Shopify Payments" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <TextField label="Percentage fee" type="number" value={percentFee} onChange={setPercentFee} suffix="%" autoComplete="off" helpText="e.g. 2.9 for 2.9%" />
            <TextField label="Fixed fee per transaction" type="number" value={fixedFee} onChange={setFixedFee} prefix="$" autoComplete="off" helpText="e.g. 0.30" />
          </div>
          {/* Fee preview */}
          <div style={{ padding: "12px 16px", borderRadius: "8px", background: "#f8fafc", border: `1px solid ${tokens.border}` }}>
            <p style={{ margin: 0, fontSize: "13px", color: tokens.textMuted }}>
              Preview on $75 order:{" "}
              <strong style={{ color: tokens.text }}>${avgFeePreview.toFixed(2)}</strong>
              <span style={{ marginLeft: "6px", fontSize: "12px" }}>
                ({percentFee || 0}% × $75 + ${fixedFee || 0})
              </span>
            </p>
          </div>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ── Inline toggle/delete buttons ──────────────────────────────────────────────
function ToggleGateway({ gateway }: { gateway: PaymentGateway }) {
  const fetcher = useFetcher();
  const isLoading = fetcher.state !== "idle";
  if (gateway.isActive) {
    return <DBadge variant="success" size="sm">Active</DBadge>;
  }
  return (
    <button
      onClick={() => fetcher.submit({ intent: "toggleGateway", id: gateway.id }, { method: "POST" })}
      disabled={isLoading}
      style={{
        padding: "4px 12px", borderRadius: "8px",
        background: "transparent", color: tokens.textMuted,
        border: `1px solid ${tokens.border}`, cursor: "pointer",
        fontSize: "12px", fontWeight: 600,
        transition: "all 0.15s", opacity: isLoading ? 0.6 : 1,
      }}
      onMouseEnter={(e) => { (e.currentTarget.style.background = "#f8fafc"); (e.currentTarget.style.color = tokens.text); }}
      onMouseLeave={(e) => { (e.currentTarget.style.background = "transparent"); (e.currentTarget.style.color = tokens.textMuted); }}
    >
      {isLoading ? "Setting…" : "Set active"}
    </button>
  );
}

function DeleteGateway({ gateway }: { gateway: PaymentGateway }) {
  const fetcher = useFetcher();
  if (gateway.isActive) return <span style={{ fontSize: "12px", color: "#cbd5e1" }}>Can't delete active</span>;
  return (
    <button
      onClick={() => fetcher.submit({ intent: "deleteGateway", id: gateway.id }, { method: "POST" })}
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
export default function PaymentPage() {
  const { gateways, activeGateway } = useLoaderData() as LoaderData;
  const [modalOpen, setModalOpen] = useState(false);
  const [editGateway, setEditGateway] = useState<PaymentGateway | null>(null);

  return (
    <Page
      title="Payment Gateways"
      backAction={{ content: "Settings", url: "/app/settings" }}
      primaryAction={{ content: "Add gateway", onAction: () => { setEditGateway(null); setModalOpen(true); } }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

        {/* Active gateway summary */}
        {activeGateway && (
          <DCard>
            <div style={{ padding: "20px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                  <p style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: tokens.text }}>
                    {activeGateway.name}
                  </p>
                  <DBadge variant="success" size="sm">Active</DBadge>
                </div>
                <p style={{ margin: 0, fontSize: "13px", color: tokens.textMuted }}>
                  {activeGateway.percentFee}% + ${activeGateway.fixedFee.toFixed(2)} per transaction
                </p>
              </div>
              <div style={{ textAlign: "right" }}>
                <p style={{ margin: "0 0 2px", fontSize: "11px", color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Avg fee on $75 order
                </p>
                <p style={{ margin: 0, fontSize: "22px", fontWeight: 700, color: tokens.text, letterSpacing: "-0.02em" }}>
                  ${((75 * activeGateway.percentFee / 100) + activeGateway.fixedFee).toFixed(2)}
                </p>
              </div>
            </div>
          </DCard>
        )}

        {/* Info banner */}
        <Banner tone="info">
          <p>
            Transaction fees are calculated as <strong>(Order Total × Fee%) + Fixed Fee</strong>. Only one gateway is active at a time — switch freely without losing your configurations.
          </p>
        </Banner>

        {/* Gateways list */}
        <DCard>
          {/* Header */}
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 120px 120px 100px auto",
            padding: "10px 20px", borderBottom: `1px solid ${tokens.border}`,
            background: "#f8fafc",
          }}>
            {["Gateway", "% Fee", "Fixed Fee", "Status", "Actions"].map((h) => (
              <span key={h} style={{ fontSize: "11px", fontWeight: 700, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {h}
              </span>
            ))}
          </div>

          {gateways.length === 0 ? (
            <div style={{ padding: "32px 20px", textAlign: "center" }}>
              <p style={{ margin: 0, fontSize: "14px", color: tokens.textMuted }}>
                No gateways configured yet.{" "}
                <button
                  onClick={() => { setEditGateway(null); setModalOpen(true); }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#2563eb", fontWeight: 600, textDecoration: "underline", fontSize: "14px" }}
                >
                  Add your first gateway
                </button>
              </p>
            </div>
          ) : (
            gateways.map((g) => (
              <div
                key={g.id}
                style={{
                  display: "grid", gridTemplateColumns: "1fr 120px 120px 100px auto",
                  padding: "14px 20px",
                  borderBottom: `1px solid ${tokens.border}`,
                  background: g.isActive ? tokens.profitBg : tokens.cardBg,
                  alignItems: "center",
                  transition: "background 0.15s",
                }}
              >
                {/* Name */}
                <div>
                  <p style={{ margin: 0, fontSize: "14px", fontWeight: g.isActive ? 700 : 500, color: tokens.text }}>
                    {g.name}
                  </p>
                </div>
                {/* % fee */}
                <p style={{ margin: 0, fontSize: "13px", color: tokens.text, fontWeight: 500 }}>
                  {g.percentFee.toFixed(2)}%
                </p>
                {/* Fixed fee */}
                <p style={{ margin: 0, fontSize: "13px", color: tokens.text, fontWeight: 500 }}>
                  ${g.fixedFee.toFixed(2)}
                </p>
                {/* Toggle */}
                <ToggleGateway gateway={g} />
                {/* Edit + Delete */}
                <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                  <button
                    onClick={() => { setEditGateway(g); setModalOpen(true); }}
                    style={{
                      background: "none", border: "none", cursor: "pointer",
                      fontSize: "12px", color: "#2563eb", fontWeight: 500,
                      textDecoration: "underline", padding: 0,
                    }}
                  >
                    Edit
                  </button>
                  <DeleteGateway gateway={g} />
                </div>
              </div>
            ))
          )}
        </DCard>

        {/* Fee formula explainer */}
        <div style={{ padding: "16px 20px", borderRadius: "10px", background: "#f8fafc", border: `1px solid ${tokens.border}` }}>
          <p style={{ margin: "0 0 8px", fontSize: "13px", fontWeight: 700, color: tokens.text }}>How fees are calculated</p>
          <p style={{ margin: "0 0 6px", fontSize: "13px", color: tokens.textMuted }}>
            For each order: <code style={{ background: "#e2e8f0", padding: "2px 6px", borderRadius: "4px", fontSize: "12px" }}>
              (Order Total × {activeGateway?.percentFee ?? 2.9}%) + ${(activeGateway?.fixedFee ?? 0.30).toFixed(2)}
            </code>
          </p>
          <p style={{ margin: 0, fontSize: "12px", color: "#94a3b8" }}>
            Example: $100 order → ${(((activeGateway?.percentFee ?? 2.9) * 100 / 100) + (activeGateway?.fixedFee ?? 0.30)).toFixed(2)} in fees
          </p>
        </div>

      </div>

      <GatewayModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditGateway(null); }}
        gateway={editGateway}
      />
    </Page>
  );
}
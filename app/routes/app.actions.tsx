// app/routes/app.actions.tsx
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useFetcher } from "react-router";
import { useState, useEffect, useCallback } from "react";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { toMonthly } from "./app.expenses";

// ── Types ─────────────────────────────────────────────────────────────────────
type LossReason = "loss_due_to_ads"|"loss_due_to_cogs"|"loss_due_to_shipping"|"loss_due_to_fees"|"loss_mixed"|"low_margin"|"high_expenses";
type Severity = "critical"|"warning"|"info";

interface ActionItem {
  type: LossReason;
  severity: Severity;
  score: number;
  title: string;
  description: string;
  potentialRecovery: number | null;
  weeklyLoss: number | null;
  timeToFix: string;
  actions: { label: string; url: string; primary?: boolean }[];
  detectedAt: string; // ISO
}

interface LoaderData {
  items: ActionItem[];
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  totalLoss7d: number;
  avgMargin7d: number;
  lossOrders7d: number;
  heldCount: number;
}

// ── Server helpers ─────────────────────────────────────────────────────────────
function fmtK(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}
function getTopCostReason(o: { adSpendAllocated: number; cogs: number; shippingCost: number; transactionFee: number }) {
  return [
    { label: "Ads", value: o.adSpendAllocated ?? 0 },
    { label: "COGS", value: o.cogs ?? 0 },
    { label: "Shipping", value: o.shippingCost ?? 0 },
    { label: "Fees", value: o.transactionFee ?? 0 },
  ].reduce((max, c) => c.value > max.value ? c : max).label;
}

// ── Root cause analysis (same as dashboard) ────────────────────────────────────
function analyzeLossReasons(lossOrders: Array<{ id: string; netProfit: number; adSpendAllocated: number; cogs: number; shippingCost: number; transactionFee: number; totalDiscounts: number; isHeld: boolean }>, lineItemsByOrder: Map<string, Array<{ productId: string; productTitle: string; cogs: number; price: number; quantity: number }>>) {
  if (lossOrders.length === 0) return null;
  const breakdown = { ads: 0, cogs: 0, shipping: 0, fees: 0, discounts: 0 };
  for (const o of lossOrders) {
    const totalCosts = (o.adSpendAllocated ?? 0) + (o.cogs ?? 0) + (o.shippingCost ?? 0) + (o.transactionFee ?? 0) + (o.totalDiscounts ?? 0);
    if (totalCosts === 0) continue;
    const lossShare = Math.abs(o.netProfit) / totalCosts;
    breakdown.ads += (o.adSpendAllocated ?? 0) * lossShare;
    breakdown.cogs += (o.cogs ?? 0) * lossShare;
    breakdown.shipping += (o.shippingCost ?? 0) * lossShare;
    breakdown.fees += (o.transactionFee ?? 0) * lossShare;
    breakdown.discounts += (o.totalDiscounts ?? 0) * lossShare;
  }
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const entries = Object.entries(breakdown) as [keyof typeof breakdown, number][];
  const [topSource, topSourceAmount] = entries.reduce((max, cur) => cur[1] > max[1] ? cur : max);
  const topSourcePercent = Math.round((topSourceAmount / total) * 100);
  const isDominant = topSourcePercent > 50;

  // Product-level breakdown
  const productLossMap = new Map<string, { title: string; loss: number; costBreakdown: { ads: number; cogs: number; shipping: number; fees: number } }>();
  for (const o of lossOrders) {
    const items = lineItemsByOrder.get(o.id) ?? [];
    const totalQty = items.reduce((s, i) => s + i.quantity, 0) || 1;
    const adsPerUnit = (o.adSpendAllocated ?? 0) / totalQty;
    const shipPerUnit = (o.shippingCost ?? 0) / totalQty;
    const feesPerUnit = (o.transactionFee ?? 0) / totalQty;
    for (const item of items) {
      const rev = item.price * item.quantity;
      const profit = rev - item.cogs - (adsPerUnit + shipPerUnit + feesPerUnit) * item.quantity;
      const existing = productLossMap.get(item.productId);
      const cb = { ads: adsPerUnit * item.quantity, cogs: item.cogs, shipping: shipPerUnit * item.quantity, fees: feesPerUnit * item.quantity };
      if (existing) { existing.loss += profit; existing.costBreakdown.ads += cb.ads; existing.costBreakdown.cogs += cb.cogs; existing.costBreakdown.shipping += cb.shipping; existing.costBreakdown.fees += cb.fees; }
      else { productLossMap.set(item.productId, { title: item.productTitle, loss: profit, costBreakdown: cb }); }
    }
  }
  const lossProducts = [...productLossMap.entries()].filter(([, v]) => v.loss < 0).sort((a, b) => a[1].loss - b[1].loss);
  const totalProductLoss = lossProducts.reduce((s, [, v]) => s + Math.abs(v.loss), 0);
  let topProduct: { pid: string; title: string; totalLoss: number; pct: number; topCostSource: string; topCostSourcePct: number } | null = null;
  if (lossProducts.length > 0) {
    const [pid, pdata] = lossProducts[0];
    const pAmt = Math.abs(pdata.loss);
    const pct = totalProductLoss > 0 ? Math.round((pAmt / totalProductLoss) * 100) : 0;
    const pEntries = Object.entries(pdata.costBreakdown) as [string, number][];
    const pTotal = pEntries.reduce((s, [, v]) => s + v, 0);
    const [pTopSrc] = pEntries.reduce((max, cur) => cur[1] > max[1] ? cur : max);
    const pTopPct = pTotal > 0 ? Math.round((pdata.costBreakdown[pTopSrc as keyof typeof pdata.costBreakdown] / pTotal) * 100) : 0;
    topProduct = { pid, title: pdata.title, totalLoss: pAmt, pct, topCostSource: pTopSrc, topCostSourcePct: pTopPct };
  }
  return { ...breakdown, total, topSource, topSourcePercent, isDominant, topProduct };
}

// ── Loader ─────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const sinceStr = sevenDaysAgo.toISOString().split("T")[0];

  const [orders7d, heldOrders, missingCogsVariants, settings, expenses, allOrdersLast30] = await Promise.all([
    db.order.findMany({
      where: { shop, shopifyCreatedAt: { gte: sevenDaysAgo } },
      select: { id: true, netProfit: true, marginPercent: true, isHeld: true, adSpendAllocated: true, cogs: true, shippingCost: true, transactionFee: true, totalPrice: true, totalDiscounts: true },
    }),
    db.order.findMany({ where: { shop, isHeld: true }, select: { id: true } }),
    db.productVariant.findMany({ where: { product: { shop }, effectiveCost: null }, select: { id: true } }),
    db.shopSettings.findUnique({ where: { shop } }),
    db.expense?.findMany({ where: { shop, isActive: true } }).catch(() => []),
    db.order.aggregate({ where: { shop, shopifyCreatedAt: { gte: new Date(now.getTime() - 30 * 86400000) } }, _sum: { totalPrice: true, netProfit: true }, _avg: { marginPercent: true } }),
  ]);

  const alertMarginThreshold = settings?.alertMarginThreshold ?? 10;
  const monthlyExpenses = (expenses ?? []).reduce((s: number, e: { amount: number; interval: string }) => s + toMonthly(e.amount, e.interval), 0);
  const totalRevenue30d = allOrdersLast30._sum.totalPrice ?? 0;
  const lossOrders7d = orders7d.filter((o) => o.netProfit < 0);
  const lossAmount7d = lossOrders7d.reduce((s, o) => s + Math.abs(o.netProfit), 0);
  const avgMargin7d = orders7d.length > 0 ? orders7d.reduce((s, o) => s + o.marginPercent, 0) / orders7d.length : 0;
  const totalAdSpend7d = orders7d.reduce((s, o) => s + (o.adSpendAllocated ?? 0), 0);
  const totalRevenue7d = orders7d.reduce((s, o) => s + o.totalPrice, 0);

  // Fetch line items for product analysis
  const lossOrderIds = lossOrders7d.map((o) => o.id);
  const lossLineItems = lossOrderIds.length > 0
    ? await db.orderLineItem.findMany({ where: { orderId: { in: lossOrderIds } }, select: { orderId: true, cogs: true, price: true, quantity: true, shopifyVariantId: true, productTitle: true } })
    : [];
  const lineItemsByOrder = new Map<string, Array<{ productId: string; productTitle: string; cogs: number; price: number; quantity: number }>>();
  for (const item of lossLineItems) {
    const productId = item.shopifyVariantId ?? item.productTitle;
    const existing = lineItemsByOrder.get(item.orderId) ?? [];
    existing.push({ productId, productTitle: item.productTitle, cogs: item.cogs, price: item.price, quantity: item.quantity });
    lineItemsByOrder.set(item.orderId, existing);
  }

  const lossBreakdown = analyzeLossReasons(lossOrders7d, lineItemsByOrder);
  const now7d = now.toISOString();
  const items: ActionItem[] = [];

  // ── Loss orders item ────────────────────────────────────────────────────────
  if (lossOrders7d.length > 0 && lossBreakdown) {
    const { topSource, topSourcePercent, isDominant, topProduct } = lossBreakdown;
    const maxSingleLoss = Math.max(...lossOrders7d.map((o) => Math.abs(o.netProfit)));
    const bigLossPenalty = maxSingleLoss > 200 ? 300 : maxSingleLoss > 100 ? 200 : maxSingleLoss > 50 ? 100 : 0;
    const score = Math.pow(lossAmount7d, 1.2) * 0.6 + lossOrders7d.length * 30 * 0.3 + 100 * 0.1 + bigLossPenalty;
    const unheld = lossOrders7d.filter((o) => !o.isHeld).length;
    const filterUrls: Record<string, string> = { ads: "/app/orders?profitability=loss&reason=ads", cogs: "/app/orders?profitability=loss&reason=cogs", shipping: "/app/orders?profitability=loss&reason=shipping", fees: "/app/orders?profitability=loss", discounts: "/app/orders?profitability=loss" };
    const sourceLabels: Record<string, string> = { ads: "Ad spend", cogs: "Product costs", shipping: "Shipping costs", fees: "Transaction fees", discounts: "Discounts" };
    const sourceAdvice: Record<string, string> = { ads: "Consider pausing high-spend campaigns or raising your prices.", cogs: "Your product costs are too high relative to your prices. Update cost prices or raise selling prices to break even.", shipping: "Shipping costs are eating into margins. Review your shipping rules or increase prices.", fees: "Transaction fees are eroding thin margins. Consider switching gateway or raising prices.", discounts: "You're discounting too aggressively — margins can't absorb it." };
    const typeMap: Record<string, LossReason> = { ads: "loss_due_to_ads", cogs: "loss_due_to_cogs", shipping: "loss_due_to_shipping", fees: "loss_due_to_fees", discounts: "loss_mixed" };

    let title: string;
    let type: LossReason;
    let severity: Severity = "critical";
    let itemActions: ActionItem["actions"] = [];
    let description: string;
    let recovery: number | null = null;

    if (topProduct && topProduct.pct >= 40) {
      const costNames: Record<string, string> = { ads: "ad spend", cogs: "product cost", shipping: "shipping", fees: "fees", discounts: "discounts" };
      title = topProduct.topCostSourcePct >= 50
        ? `"${topProduct.title}" is losing money mainly due to ${costNames[topProduct.topCostSource]} (${topProduct.topCostSourcePct}%)`
        : `"${topProduct.title}" caused ${topProduct.pct}% of your losses this week`;
      severity = topProduct.pct > 60 ? "critical" : "warning";
      type = typeMap[topProduct.topCostSource] ?? "loss_due_to_ads";
      recovery = topProduct.totalLoss;
      description = `${lossOrders7d.length} order${lossOrders7d.length > 1 ? "s" : ""} unprofitable${unheld > 0 ? `, ${unheld} shipped without hold` : ""}. ${sourceAdvice[topProduct.topCostSource] ?? ""}`;
      if (topProduct.topCostSource === "cogs") itemActions = [{ label: "Update cost price", url: `/app/cogs?search=${encodeURIComponent(topProduct.title)}`, primary: true }, { label: "View loss orders", url: filterUrls["cogs"] }];
      else if (topProduct.topCostSource === "ads") itemActions = [{ label: "Review ad spend", url: "/app/ads", primary: true }, { label: "View affected orders", url: filterUrls["ads"] }];
      else if (topProduct.topCostSource === "shipping") itemActions = [{ label: "Check shipping rules", url: "/app/shipping", primary: true }, { label: "View orders", url: filterUrls["shipping"] }];
      else itemActions = [{ label: "Fix cost price", url: `/app/cogs?search=${encodeURIComponent(topProduct.title)}`, primary: true }, { label: "View loss orders", url: "/app/orders?profitability=loss" }];
    } else if (isDominant) {
      title = `${sourceLabels[topSource]} causing ${topSourcePercent}% of your losses`;
      type = typeMap[topSource] ?? "loss_due_to_ads";
      recovery = lossAmount7d;
      description = `${lossOrders7d.length} order${lossOrders7d.length > 1 ? "s" : ""} unprofitable this week${unheld > 0 ? `, ${unheld} shipped without hold` : ""}. ${sourceAdvice[topSource]}`;
      itemActions = [{ label: "View affected orders", url: filterUrls[topSource], primary: true }, ...(!settings?.holdEnabled ? [{ label: "Enable auto-hold", url: "/app/settings" }] : [])];
    } else {
      title = "Losses spread across multiple cost factors";
      type = "loss_mixed";
      recovery = lossAmount7d;
      description = `${lossOrders7d.length} order${lossOrders7d.length > 1 ? "s" : ""} unprofitable${unheld > 0 ? `, ${unheld} shipped without hold` : ""}. Review your pricing, COGS, and ad spend together.`;
      itemActions = [{ label: "View loss orders", url: "/app/orders?profitability=loss", primary: true }, { label: "Review products", url: "/app/products" }];
    }
    items.push({ type, severity, score, title, description, potentialRecovery: recovery, weeklyLoss: lossAmount7d, timeToFix: isDominant ? (topSource === "cogs" ? "10 min" : "5 min") : "10 min", actions: itemActions, detectedAt: now7d });
  }

  // ── Held orders item ────────────────────────────────────────────────────────
  if (heldOrders.length > 0) {
    items.push({
      type: "loss_mixed", severity: "critical", score: heldOrders.length * 80,
      title: `${heldOrders.length} order${heldOrders.length > 1 ? "s" : ""} on hold — cashflow blocked`,
      description: `${heldOrders.length} order${heldOrders.length > 1 ? "s are" : " is"} currently held from fulfillment. Each hour of delay risks customer dissatisfaction. Review and release or cancel them.`,
      potentialRecovery: null, weeklyLoss: null, timeToFix: "2 min",
      actions: [{ label: "Review held orders", url: "/app/orders?status=held", primary: true }],
      detectedAt: now7d,
    });
  }

  // ── Low margin item ────────────────────────────────────────────────────────
  if (avgMargin7d > 0 && avgMargin7d < alertMarginThreshold && lossOrders7d.length === 0) {
    const gap = alertMarginThreshold - avgMargin7d;
    const score = Math.pow(gap * 20, 1.1) * 0.6 + orders7d.length * 5 * 0.3 + 50 * 0.1;
    items.push({
      type: "low_margin", severity: "warning", score,
      title: `Average margin is ${gap.toFixed(1)}% below your target`,
      description: `Your average margin this week is ${avgMargin7d.toFixed(1)}%, against your target of ${alertMarginThreshold}%+. Every order is underperforming. Review product pricing and COGS accuracy.`,
      potentialRecovery: null, weeklyLoss: null, timeToFix: "10 min",
      actions: [{ label: "Fix missing COGS", url: "/app/cogs", primary: true }, { label: "Check settings", url: "/app/settings" }],
      detectedAt: now7d,
    });
  }

  // ── High ad spend item ─────────────────────────────────────────────────────
  if (totalAdSpend7d > 0 && totalRevenue7d > 0 && totalAdSpend7d / totalRevenue7d > 0.4) {
    const excessSpend = totalAdSpend7d - totalRevenue7d * 0.3;
    items.push({
      type: "loss_due_to_ads", severity: "warning", score: Math.pow(excessSpend, 1.1) * 0.6,
      title: "Ad spend is too high relative to revenue",
      description: `Ad spend is ${((totalAdSpend7d / totalRevenue7d) * 100).toFixed(0)}% of revenue this week — healthy benchmarks suggest keeping it below 30%. Consider pausing low-performing campaigns.`,
      potentialRecovery: excessSpend, weeklyLoss: null, timeToFix: "5 min",
      actions: [{ label: "View ad breakdown", url: "/app/ads", primary: true }, { label: "View affected orders", url: "/app/orders?profitability=loss" }],
      detectedAt: now7d,
    });
  }

  // ── Missing COGS item ──────────────────────────────────────────────────────
  if (missingCogsVariants.length > 0) {
    const impact = missingCogsVariants.length * 15; // rough estimate per variant
    items.push({
      type: "loss_due_to_cogs", severity: missingCogsVariants.length > 10 ? "warning" : "info",
      score: missingCogsVariants.length * 10,
      title: `${missingCogsVariants.length} product variant${missingCogsVariants.length > 1 ? "s" : ""} missing cost data`,
      description: `Orders with missing COGS show inflated margins and won't trigger auto-holds correctly. Your profit figures may be overstated by ~$${impact}/mo.`,
      potentialRecovery: null, weeklyLoss: null, timeToFix: "2 min",
      actions: [{ label: "Fix missing COGS", url: "/app/cogs", primary: true }],
      detectedAt: now7d,
    });
  }

  // ── High fixed costs item ──────────────────────────────────────────────────
  if (monthlyExpenses > totalRevenue30d * 0.2 && monthlyExpenses > 0) {
    const ratio = monthlyExpenses / Math.max(totalRevenue30d, 1);
    items.push({
      type: "high_expenses", severity: "info", score: Math.pow(ratio * 100, 1.05) * 5,
      title: `Fixed costs at ${fmtK(monthlyExpenses)}/month are ${(ratio * 100).toFixed(0)}% of revenue`,
      description: `Your recurring expenses are consuming a large share of revenue. Every order you sell carries part of this cost. Review your largest expenses and identify any that can be reduced or eliminated.`,
      potentialRecovery: null, weeklyLoss: null, timeToFix: "5 min",
      actions: [{ label: "Review expenses", url: "/app/expenses", primary: true }],
      detectedAt: now7d,
    });
  }

  // Sort by severity then score
  const severityOrder: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  items.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || b.score - a.score);

  const criticalCount = items.filter((i) => i.severity === "critical").length;
  const warningCount = items.filter((i) => i.severity === "warning").length;
  const infoCount = items.filter((i) => i.severity === "info").length;

  return json({ items, criticalCount, warningCount, infoCount, totalLoss7d: lossAmount7d, avgMargin7d, lossOrders7d: lossOrders7d.length, heldCount: heldOrders.length });
};

// ── Action — dismiss (server-persisted) ─────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  // Client-side dismiss via sessionStorage — no server action needed for v1
  return json({ ok: true });
};

// ── Design tokens ─────────────────────────────────────────────────────────────
const tokens = {
  profit: "#16a34a", profitBg: "#f0fdf4", profitBorder: "#bbf7d0",
  loss: "#dc2626", lossBg: "#fef2f2", lossBorder: "#fecaca",
  warning: "#d97706", warningBg: "#fffbeb", warningBorder: "#fde68a",
  border: "#e2e8f0", cardBg: "#ffffff", text: "#0f172a", textMuted: "#64748b",
};

function DCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: tokens.cardBg, border: `1px solid ${tokens.border}`, borderRadius: "12px", overflow: "hidden", ...style }}>{children}</div>;
}

function DBadge({ children, variant = "default", size = "md" }: {
  children: React.ReactNode;
  variant?: "default"|"success"|"danger"|"warning"|"info"|"neutral";
  size?: "sm"|"md";
}) {
  const colors: Record<string, { bg: string; color: string; border: string }> = {
    default: { bg: "#f1f5f9", color: "#475569", border: "#e2e8f0" },
    success: { bg: tokens.profitBg, color: tokens.profit, border: tokens.profitBorder },
    danger:  { bg: tokens.lossBg, color: tokens.loss, border: tokens.lossBorder },
    warning: { bg: tokens.warningBg, color: tokens.warning, border: tokens.warningBorder },
    info:    { bg: "#eff6ff", color: "#2563eb", border: "#bfdbfe" },
    neutral: { bg: "#f8fafc", color: tokens.textMuted, border: tokens.border },
  };
  const c = colors[variant];
  return <span style={{ display: "inline-flex", alignItems: "center", padding: size === "sm" ? "2px 8px" : "3px 10px", borderRadius: "100px", fontSize: size === "sm" ? "11px" : "12px", fontWeight: 600, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>{children}</span>;
}

// ── Dismiss logic ─────────────────────────────────────────────────────────────
const DISMISS_KEY = "cp_dismissed_actions_v2";
const DISMISS_TTL = 24 * 60 * 60 * 1000;

function useDismissed() {
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DISMISS_KEY);
      if (!raw) return;
      const parsed: { type: string; at: number }[] = JSON.parse(raw);
      setDismissed(parsed.filter((d) => Date.now() - d.at < DISMISS_TTL).map((d) => d.type));
    } catch {}
  }, []);
  const dismiss = useCallback((type: string) => {
    setDismissed((prev) => {
      const next = [...prev, type];
      try {
        const raw = sessionStorage.getItem(DISMISS_KEY);
        const existing: { type: string; at: number }[] = raw ? JSON.parse(raw) : [];
        sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...existing.filter((d) => d.type !== type), { type, at: Date.now() }]));
      } catch {}
      return next;
    });
  }, []);
  return { dismissed, dismiss };
}

// ── Icons ─────────────────────────────────────────────────────────────────────
const typeIcons: Record<string, string> = {
  loss_due_to_ads: "📢", loss_due_to_cogs: "📦", loss_due_to_shipping: "🚚",
  loss_due_to_fees: "💳", loss_mixed: "⚖️", low_margin: "📉", high_expenses: "🏢",
};
const severityConfig = {
  critical: { border: tokens.lossBorder, labelBg: tokens.lossBg, color: tokens.loss, badge: "danger" as const, icon: "🔴", label: "Critical" },
  warning:  { border: tokens.warningBorder, labelBg: tokens.warningBg, color: tokens.warning, badge: "warning" as const, icon: "⚠️", label: "Warning" },
  info:     { border: "#bfdbfe", labelBg: "#eff6ff", color: "#2563eb", badge: "info" as const, icon: "ℹ️", label: "Info" },
};

// ── Action item card ──────────────────────────────────────────────────────────
function ActionCard({ item, onDismiss }: { item: ActionItem; onDismiss: (type: string) => void }) {
  const navigate = useNavigate();
  const cfg = severityConfig[item.severity];
  const typeIcon = typeIcons[item.type] ?? "•";
  const primaryAction = item.actions.find((a) => a.primary) ?? item.actions[0];
  const secondaryActions = item.actions.filter((a) => !a.primary);

  return (
    <div style={{
      background: tokens.cardBg, border: `1px solid ${tokens.border}`,
      borderRadius: "12px", overflow: "hidden", position: "relative",
      borderLeft: `4px solid ${cfg.color}`,
    }}>
      {/* Dismiss button */}
      <button
        onClick={() => onDismiss(item.type)}
        title="Dismiss for 24h"
        style={{
          position: "absolute", top: "12px", right: "14px",
          background: "none", border: "none", cursor: "pointer",
          fontSize: "20px", color: "#cbd5e1", lineHeight: 1, padding: "2px 4px",
          transition: "color 0.1s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "#94a3b8")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "#cbd5e1")}
      >
        ×
      </button>

      <div style={{ padding: "16px 48px 16px 16px", display: "flex", gap: "12px", alignItems: "flex-start" }}>
        {/* Severity + type icon */}
        <div style={{
          width: 36, height: 36, borderRadius: "10px", flexShrink: 0,
          background: cfg.labelBg, border: `1px solid ${cfg.border}`,
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: "17px",
        }}>
          {typeIcon}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Header row */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
            <DBadge variant={cfg.badge} size="sm">{cfg.icon} {cfg.label}</DBadge>
            <DBadge variant="neutral" size="sm">⏱ {item.timeToFix}</DBadge>
            {item.weeklyLoss != null && item.weeklyLoss > 0 && (
              <DBadge variant="danger" size="sm">−{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(item.weeklyLoss)}/wk</DBadge>
            )}
          </div>

          {/* Title */}
          <p style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: 700, color: tokens.text, lineHeight: "1.4" }}>
            {item.title}
          </p>

          {/* Description */}
          <p style={{ margin: "0 0 12px", fontSize: "13px", color: tokens.textMuted, lineHeight: "1.6" }}>
            {item.description}
            {item.potentialRecovery != null && item.potentialRecovery > 0 && (
              <span style={{ color: tokens.profit, fontWeight: 600 }}>
                {" "}Potential recovery: ~{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(item.potentialRecovery)}/week.
              </span>
            )}
          </p>

          {/* CTAs */}
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            {primaryAction && (
              <button
                onClick={() => navigate(primaryAction.url)}
                style={{
                  padding: "8px 18px", borderRadius: "8px",
                  background: tokens.text, color: "#fff",
                  border: "none", cursor: "pointer",
                  fontSize: "13px", fontWeight: 600, transition: "background 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#1e293b")}
                onMouseLeave={(e) => (e.currentTarget.style.background = tokens.text)}
              >
                {primaryAction.label} →
              </button>
            )}
            {secondaryActions.map((a) => (
              <button
                key={a.label}
                onClick={() => navigate(a.url)}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  fontSize: "13px", color: tokens.textMuted,
                  textDecoration: "underline", padding: 0,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = tokens.text)}
                onMouseLeave={(e) => (e.currentTarget.style.color = tokens.textMuted)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Filter tab ────────────────────────────────────────────────────────────────
function FilterTab({ label, count, active, onClick, color }: {
  label: string; count: number; active: boolean; onClick: () => void; color?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 16px", borderRadius: "8px", cursor: "pointer",
        background: active ? tokens.text : "transparent",
        color: active ? "#fff" : tokens.textMuted,
        border: active ? "none" : `1px solid ${tokens.border}`,
        fontSize: "13px", fontWeight: 600,
        display: "flex", alignItems: "center", gap: "6px",
        transition: "all 0.15s",
      }}
    >
      {label}
      {count > 0 && (
        <span style={{
          minWidth: "18px", height: "18px", borderRadius: "100px",
          background: active ? "rgba(255,255,255,0.2)" : color ?? "#e2e8f0",
          color: active ? "#fff" : tokens.text,
          fontSize: "11px", fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "0 4px",
        }}>
          {count}
        </span>
      )}
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ActionsPage() {
  const { items, criticalCount, warningCount, infoCount, totalLoss7d, avgMargin7d, lossOrders7d, heldCount } = useLoaderData() as LoaderData;
  const navigate = useNavigate();
  const { dismissed, dismiss } = useDismissed();
  const [filter, setFilter] = useState<"all"|"critical"|"warning"|"info">("all");

  const visibleItems = items.filter((i) => !dismissed.includes(i.type));
  const filteredItems = filter === "all" ? visibleItems : visibleItems.filter((i) => i.severity === filter);

  const visibleCritical = visibleItems.filter((i) => i.severity === "critical").length;
  const visibleWarning = visibleItems.filter((i) => i.severity === "warning").length;
  const visibleInfo = visibleItems.filter((i) => i.severity === "info").length;
  const totalVisible = visibleItems.length;

  const totalLossFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(totalLoss7d);

  return (
    <Page title="Action Center" subtitle="Issues detected in the last 7 days" backAction={{ content: "Dashboard", url: "/app" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

        {/* Summary bar */}
        <DCard>
          <div style={{ display: "flex", overflowX: "auto" }}>
            {[
              { label: "Open Issues", value: String(totalVisible), sub: "need action", critical: totalVisible > 0 },
              { label: "Loss This Week", value: totalLoss7d > 0 ? totalLossFmt : "—", sub: "in unprofitable orders", critical: totalLoss7d > 0 },
              { label: "Avg Margin 7d", value: `${avgMargin7d.toFixed(1)}%`, sub: "last 7 days", critical: avgMargin7d < 10 && avgMargin7d > 0 },
              { label: "Loss Orders", value: String(lossOrders7d), sub: "unprofitable", critical: lossOrders7d > 0 },
              { label: "On Hold", value: String(heldCount), sub: "awaiting review", critical: heldCount > 0 },
            ].map((m, i, arr) => (
              <div key={m.label} style={{ flex: "1 1 0", minWidth: "120px", padding: "14px 18px", borderRight: i < arr.length - 1 ? `1px solid ${tokens.border}` : undefined }}>
                <p style={{ margin: "0 0 4px", fontSize: "11px", fontWeight: 600, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{m.label}</p>
                <p style={{ margin: "0 0 2px", fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", color: m.critical ? tokens.loss : tokens.text }}>{m.value}</p>
                <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>{m.sub}</p>
              </div>
            ))}
          </div>
        </DCard>

        {/* Filters */}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <FilterTab label="All" count={totalVisible} active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterTab label="Critical" count={visibleCritical} active={filter === "critical"} onClick={() => setFilter("critical")} color={tokens.lossBg} />
          <FilterTab label="Warnings" count={visibleWarning} active={filter === "warning"} onClick={() => setFilter("warning")} color={tokens.warningBg} />
          <FilterTab label="Info" count={visibleInfo} active={filter === "info"} onClick={() => setFilter("info")} color="#eff6ff" />
        </div>

        {/* Items */}
        {filteredItems.length === 0 ? (
          totalVisible === 0 ? (
            /* All clear state */
            <DCard style={{ border: `1px solid ${tokens.profitBorder}` }}>
              <div style={{ padding: "48px 24px", textAlign: "center" }}>
                <div style={{ fontSize: "48px", marginBottom: "16px" }}>🎉</div>
                <p style={{ margin: "0 0 8px", fontSize: "20px", fontWeight: 700, color: tokens.text }}>All clear — no issues found</p>
                <p style={{ margin: "0 0 20px", fontSize: "14px", color: tokens.textMuted }}>Your profit tracking is fully configured and no loss patterns were detected in the last 7 days.</p>
                <div style={{ display: "flex", justifyContent: "center", gap: "12px" }}>
                  <button
                    onClick={() => navigate("/app")}
                    style={{ padding: "8px 20px", borderRadius: "8px", background: tokens.text, color: "#fff", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}
                  >
                    View dashboard
                  </button>
                  <button
                    onClick={() => navigate("/app/orders")}
                    style={{ padding: "8px 20px", borderRadius: "8px", background: "transparent", color: tokens.textMuted, border: `1px solid ${tokens.border}`, cursor: "pointer", fontSize: "13px", fontWeight: 500 }}
                  >
                    Browse orders
                  </button>
                </div>
              </div>
            </DCard>
          ) : (
            <div style={{ padding: "24px", textAlign: "center", color: tokens.textMuted, fontSize: "13px" }}>
              No {filter} issues — <button onClick={() => setFilter("all")} style={{ background: "none", border: "none", cursor: "pointer", color: "#2563eb", textDecoration: "underline", fontSize: "13px" }}>show all</button>
            </div>
          )
        ) : (
          <>
            {/* Group: Critical */}
            {(filter === "all" || filter === "critical") && filteredItems.filter((i) => i.severity === "critical").length > 0 && (
              <div>
                {filter === "all" && (
                  <p style={{ margin: "0 0 8px", fontSize: "11px", fontWeight: 700, color: tokens.loss, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    🔴 Critical — fix these first
                  </p>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {filteredItems.filter((i) => i.severity === "critical").map((item) => (
                    <ActionCard key={item.type} item={item} onDismiss={dismiss} />
                  ))}
                </div>
              </div>
            )}

            {/* Group: Warning */}
            {(filter === "all" || filter === "warning") && filteredItems.filter((i) => i.severity === "warning").length > 0 && (
              <div>
                {filter === "all" && (
                  <p style={{ margin: "8px 0 8px", fontSize: "11px", fontWeight: 700, color: tokens.warning, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    ⚠️ Warnings — address soon
                  </p>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {filteredItems.filter((i) => i.severity === "warning").map((item) => (
                    <ActionCard key={item.type} item={item} onDismiss={dismiss} />
                  ))}
                </div>
              </div>
            )}

            {/* Group: Info */}
            {(filter === "all" || filter === "info") && filteredItems.filter((i) => i.severity === "info").length > 0 && (
              <div>
                {filter === "all" && (
                  <p style={{ margin: "8px 0 8px", fontSize: "11px", fontWeight: 700, color: "#2563eb", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    ℹ️ Suggestions
                  </p>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {filteredItems.filter((i) => i.severity === "info").map((item) => (
                    <ActionCard key={item.type} item={item} onDismiss={dismiss} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Footer note */}
        {totalVisible > 0 && (
          <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted, textAlign: "center" }}>
            Dismissed items disappear for 24h and reappear automatically. Issues clear automatically when the underlying problem is resolved.
          </p>
        )}
      </div>
    </Page>
  );
}
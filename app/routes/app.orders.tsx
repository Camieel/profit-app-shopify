// app/routes/app.orders.tsx
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigation, useSearchParams, useNavigate, useLocation, useFetcher } from "react-router";
import { useState, useEffect } from "react";
import { Page, Select, SkeletonBodyText, SkeletonDisplayText } from "@shopify/polaris";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import { DateRangePicker, loadFromStorage } from "../DateRangePicker";
import db from "../db.server";

const PAGE_SIZE = 25;

// ── Types ─────────────────────────────────────────────────────────────────────
interface OrderRow {
  id: string; shopifyOrderId: string; shopifyOrderName: string;
  shopifyCreatedAt: string; currency: string; totalPrice: number;
  totalDiscounts: number; cogs: number; transactionFee: number;
  shippingCost: number; adSpendAllocated: number; grossProfit: number;
  netProfit: number; marginPercent: number; isHeld: boolean;
  cogsComplete: boolean; financialStatus: string | null;
  topCostReason: string; repeatLossCount: number;
}
interface LossSummary { count: number; totalLoss: number; }
interface ActionEntry {
  id: string; message: string; tone: "critical"|"caution"|"info";
  buttonLabel: string; filterKey: string; filterValue: string;
  priorityScore: number; group: "leakage"|"data"|"operations";
  recoverable: number | null;
}
interface Summary {
  totalRevenue: number; totalNetProfit: number; totalDiscounts: number;
  avgMargin: number; orderCount: number; heldCount: number;
  missingCogsCount: number; refundedCount: number; partialRefundCount: number;
  lossSummary: LossSummary;
}
interface LoaderData {
  orders: OrderRow[]; summary: Summary;
  worstOrders: { name: string; netProfit: number; currency: string }[];
  dateFrom: string; dateTo: string; status: string; profitability: string;
  cogsFilter: string; reason: string; page: number; totalPages: number;
  totalCount: number; shop: string;
}

// ── Server helpers ────────────────────────────────────────────────────────────
function toDateString(date: Date) { return date.toISOString().split("T")[0]; }
function getTopCostReason(o: { adSpendAllocated: number; cogs: number; shippingCost: number; transactionFee: number }): string {
  return [{ label: "Ads", value: o.adSpendAllocated ?? 0 }, { label: "COGS", value: o.cogs ?? 0 }, { label: "Shipping", value: o.shippingCost ?? 0 }, { label: "Fees", value: o.transactionFee ?? 0 }].reduce((max, c) => c.value > max.value ? c : max).label;
}

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;
  const url = new URL(request.url);
  const defaultTo = toDateString(new Date());
  const defaultFrom = toDateString(new Date(Date.now() - 30 * 86400000));
  const dateFrom = url.searchParams.get("from") || defaultFrom;
  const dateTo = url.searchParams.get("to") || defaultTo;
  const status = url.searchParams.get("status") || "all";
  const profitability = url.searchParams.get("profitability") || "all";
  const cogsFilter = url.searchParams.get("cogs") || "all";
  const reason = url.searchParams.get("reason") || "all";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const since = new Date(dateFrom + "T00:00:00.000Z");
  const until = new Date(dateTo + "T23:59:59.999Z");
  const where: Prisma.OrderWhereInput = { shop, shopifyCreatedAt: { gte: since, lte: until } };
  if (status === "held") where.isHeld = true;
  else if (status === "refunded") where.financialStatus = "refunded";
  else if (status === "partially_refunded") where.financialStatus = "partially_refunded";
  else if (status === "paid") where.financialStatus = "paid";
  else if (status === "pending") where.financialStatus = "pending";
  else if (status === "cancelled") where.financialStatus = { in: ["voided", "cancelled"] };
  else if (status === "clear") { where.isHeld = false; where.financialStatus = { notIn: ["refunded", "partially_refunded"] }; }
  if (profitability === "profitable") where.netProfit = { gte: 0 };
  else if (profitability === "loss") where.netProfit = { lt: 0 };
  if (cogsFilter === "missing") where.cogsComplete = false;
  const baseSummaryWhere: Prisma.OrderWhereInput = { shop, shopifyCreatedAt: { gte: since, lte: until } };
  const [totalCount, orders, aggregations, heldCount, missingCogsCount, refundedCount, partialRefundCount, orderCount, lossAgg, worstOrdersRaw, allLossOrders] = await Promise.all([
    db.order.count({ where }),
    db.order.findMany({ where, orderBy: { shopifyCreatedAt: "desc" }, skip: (Math.max(1, page) - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    db.order.aggregate({ where: baseSummaryWhere, _sum: { totalPrice: true, netProfit: true, totalDiscounts: true }, _avg: { marginPercent: true } }),
    db.order.count({ where: { ...baseSummaryWhere, isHeld: true } }),
    db.order.count({ where: { ...baseSummaryWhere, cogsComplete: false } }),
    db.order.count({ where: { ...baseSummaryWhere, financialStatus: "refunded" } }),
    db.order.count({ where: { ...baseSummaryWhere, financialStatus: "partially_refunded" } }),
    db.order.count({ where: baseSummaryWhere }),
    db.order.aggregate({ where: { ...baseSummaryWhere, netProfit: { lt: 0 } }, _sum: { netProfit: true }, _count: { id: true } }),
    db.order.findMany({ where: { ...baseSummaryWhere, netProfit: { lt: 0 } }, orderBy: { netProfit: "asc" }, take: 3, select: { shopifyOrderName: true, netProfit: true, currency: true } }),
    db.order.findMany({ where: { ...baseSummaryWhere, netProfit: { lt: 0 } }, select: { adSpendAllocated: true, cogs: true, shippingCost: true, transactionFee: true } }),
  ]);
  const reasonCounts = new Map<string, number>();
  for (const o of allLossOrders) { const r = getTopCostReason(o); reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1); }
  const reasonLabel = reason === "ads" ? "Ads" : reason === "cogs" ? "COGS" : reason === "shipping" ? "Shipping" : reason === "fees" ? "Fees" : null;
  const filteredOrders = reasonLabel ? orders.filter((o) => getTopCostReason(o) === reasonLabel) : orders;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const summary: Summary = {
    totalRevenue: aggregations._sum.totalPrice || 0, totalNetProfit: aggregations._sum.netProfit || 0,
    totalDiscounts: aggregations._sum.totalDiscounts || 0, avgMargin: aggregations._avg.marginPercent || 0,
    orderCount, heldCount, missingCogsCount, refundedCount, partialRefundCount,
    lossSummary: { count: lossAgg._count.id || 0, totalLoss: lossAgg._sum.netProfit || 0 },
  };
  return json({
    orders: filteredOrders.map((o) => ({
      id: o.id, shopifyOrderId: o.shopifyOrderId, shopifyOrderName: o.shopifyOrderName,
      shopifyCreatedAt: o.shopifyCreatedAt.toISOString(), currency: o.currency,
      totalPrice: o.totalPrice, totalDiscounts: o.totalDiscounts, cogs: o.cogs,
      transactionFee: o.transactionFee, shippingCost: o.shippingCost, adSpendAllocated: o.adSpendAllocated,
      grossProfit: o.grossProfit, netProfit: o.netProfit, marginPercent: o.marginPercent,
      isHeld: o.isHeld, cogsComplete: o.cogsComplete, financialStatus: o.financialStatus,
      topCostReason: getTopCostReason(o),
      repeatLossCount: o.netProfit < 0 ? (reasonCounts.get(getTopCostReason(o)) ?? 0) : 0,
    })),
    summary, worstOrders: worstOrdersRaw.map((o) => ({ name: o.shopifyOrderName, netProfit: o.netProfit, currency: o.currency })),
    dateFrom, dateTo, status, profitability, cogsFilter, reason, page: currentPage, totalPages, totalCount, shop,
  });
};

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  if (intent === "releaseHold") {
    const orderId = formData.get("orderId") as string;
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) return json({ error: "Order not found" }, { status: 404 });
    const foResponse: any = await admin.graphql(`#graphql query getFulfillmentOrders($id: ID!) { order(id: $id) { fulfillmentOrders(first: 1) { nodes { id status } } } }`, { variables: { id: order.shopifyOrderId } });
    const fo = (await foResponse.json()).data?.order?.fulfillmentOrders?.nodes?.[0];
    if (fo) {
      const mutRes: any = await admin.graphql(`#graphql mutation releaseHold($id: ID!) { fulfillmentOrderReleaseHold(id: $id) { fulfillmentOrder { id status } userErrors { field message } } }`, { variables: { id: fo.id } });
      const errors = (await mutRes.json()).data?.fulfillmentOrderReleaseHold?.userErrors;
      if (errors?.length > 0) return json({ error: errors[0].message }, { status: 400 });
    }
    await db.order.update({ where: { id: orderId }, data: { isHeld: false, heldReason: null } });
    return json({ success: true });
  }
  return json({ error: "Unknown intent" }, { status: 400 });
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

function fmt(amount: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(amount);
}
function getOrderUrl(shop: string, shopifyOrderId: string) {
  return `https://${shop}/admin/orders/${shopifyOrderId.replace("gid://shopify/Order/", "")}`;
}

// ── Release hold button ───────────────────────────────────────────────────────
function ReleaseHoldButton({ orderId }: { orderId: string }) {
  const fetcher = useFetcher();
  const released = (fetcher.data as any)?.success;
  if (released) return <DBadge variant="success" size="sm">Released</DBadge>;
  return (
    <button onClick={() => fetcher.submit({ intent: "releaseHold", orderId }, { method: "POST" })} disabled={fetcher.state === "submitting"}
      style={{ padding: "4px 12px", borderRadius: "6px", background: tokens.text, color: "#fff", border: "none", cursor: "pointer", fontSize: "12px", fontWeight: 600, opacity: fetcher.state === "submitting" ? 0.6 : 1 }}
    >
      {fetcher.state === "submitting" ? "Releasing…" : "Release"}
    </button>
  );
}

// ── Summary strip ─────────────────────────────────────────────────────────────
function SummaryStrip({ summary, onFilter }: { summary: Summary; onFilter: (key: string, value: string) => void }) {
  const metrics = [
    { label: "Revenue", value: fmt(summary.totalRevenue), critical: false, filterKey: "", filterValue: "" },
    { label: "Net Profit", value: fmt(summary.totalNetProfit), critical: summary.totalNetProfit < 0, filterKey: "profitability", filterValue: "loss" },
    { label: "Avg Margin", value: summary.avgMargin.toFixed(1) + "%", critical: summary.avgMargin < 0, filterKey: "profitability", filterValue: "all" },
    { label: "Orders", value: String(summary.orderCount), critical: false, filterKey: "", filterValue: "" },
    { label: "On Hold", value: String(summary.heldCount), critical: summary.heldCount > 0, filterKey: "status", filterValue: "held" },
    { label: "Refunded", value: String(summary.refundedCount), critical: summary.refundedCount > 0, filterKey: "status", filterValue: "refunded" },
    { label: "Missing COGS", value: String(summary.missingCogsCount), critical: summary.missingCogsCount > 0, filterKey: "cogs", filterValue: "missing" },
  ];
  return (
    <DCard>
      <div style={{ display: "flex", overflowX: "auto" }}>
        {metrics.map((m, i) => {
          const clickable = !!m.filterKey;
          return (
            <div key={m.label} onClick={clickable ? () => onFilter(m.filterKey, m.filterValue) : undefined}
              style={{ flex: "1 1 0", minWidth: "110px", padding: "14px 16px", borderRight: i < metrics.length - 1 ? `1px solid ${tokens.border}` : undefined, background: m.critical ? "#fffbeb" : tokens.cardBg, cursor: clickable ? "pointer" : "default", transition: "background 0.15s" }}
              onMouseEnter={clickable ? (e) => ((e.currentTarget as HTMLDivElement).style.background = "#f8fafc") : undefined}
              onMouseLeave={clickable ? (e) => ((e.currentTarget as HTMLDivElement).style.background = m.critical ? "#fffbeb" : tokens.cardBg) : undefined}
            >
              <p style={{ margin: "0 0 4px", fontSize: "11px", fontWeight: 600, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {m.label} {clickable && <span style={{ color: "#cbd5e1", fontSize: "10px" }}>→</span>}
              </p>
              <p style={{ margin: 0, fontSize: "20px", fontWeight: 700, letterSpacing: "-0.02em", color: m.critical ? tokens.loss : tokens.text }}>{m.value}</p>
            </div>
          );
        })}
      </div>
    </DCard>
  );
}

// ── Loss headline ─────────────────────────────────────────────────────────────
function LossHeadline({ summary, worstOrders }: { summary: Summary; worstOrders: { name: string; netProfit: number; currency: string }[] }) {
  if (summary.lossSummary.count === 0) return null;
  const lossPercent = summary.orderCount > 0 ? Math.round((summary.lossSummary.count / summary.orderCount) * 100) : 0;
  const lossVsRevenue = summary.totalRevenue > 0 ? ((Math.abs(summary.lossSummary.totalLoss) / summary.totalRevenue) * 100).toFixed(1) : null;
  return (
    <DCard style={{ border: `1px solid ${tokens.lossBorder}` }}>
      <div style={{ padding: "16px 20px", background: tokens.lossBg, borderBottom: `1px solid ${tokens.lossBorder}` }}>
        <p style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: 700, color: tokens.loss, letterSpacing: "-0.02em" }}>
          You lost {fmt(Math.abs(summary.lossSummary.totalLoss))} in this period
        </p>
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
          <p style={{ margin: 0, fontSize: "13px", color: tokens.loss, opacity: 0.8 }}>{lossPercent}% of orders ({summary.lossSummary.count}) are unprofitable</p>
          {lossVsRevenue && <p style={{ margin: 0, fontSize: "13px", color: tokens.loss, fontWeight: 600 }}>{lossVsRevenue}% of your revenue is leaking</p>}
        </div>
      </div>
      {worstOrders.length > 0 && (
        <div style={{ padding: "12px 20px" }}>
          <p style={{ margin: "0 0 8px", fontSize: "11px", fontWeight: 700, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Top loss orders</p>
          {worstOrders.map((o, i) => (
            <div key={o.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: tokens.textMuted }}>#{i + 1}</span>
                <span style={{ fontSize: "13px", fontWeight: 500, color: tokens.text }}>{o.name}</span>
              </div>
              <span style={{ fontSize: "13px", fontWeight: 700, color: tokens.loss }}>{fmt(o.netProfit, o.currency)}</span>
            </div>
          ))}
        </div>
      )}
    </DCard>
  );
}

// ── Compact Issue Strip (replaces full Action Center widget on Orders page) ────
// Design decision: Orders page focuses on order data. Issues are resolved in
// Action Center hub. This strip surfaces issues contextually with ONE link.
function IssueStrip({ summary, navigate }: {
  summary: Summary;
  navigate: (url: string) => void;
}) {
  const parts: string[] = [];
  if (summary.lossSummary.count > 0) parts.push(`${summary.lossSummary.count} loss order${summary.lossSummary.count > 1 ? "s" : ""} (${fmt(Math.abs(summary.lossSummary.totalLoss))})`);
  if (summary.heldCount > 0) parts.push(`${summary.heldCount} on hold`);
  if (summary.missingCogsCount > 0) parts.push(`${summary.missingCogsCount} missing COGS`);

  if (parts.length === 0) return (
    <div style={{ padding: "10px 16px", borderRadius: "8px", background: tokens.profitBg, border: `1px solid ${tokens.profitBorder}`, display: "flex", alignItems: "center", gap: "8px" }}>
      <span style={{ fontSize: "13px", color: tokens.profit, fontWeight: 500 }}>✅ No issues in this period</span>
    </div>
  );

  return (
    <div style={{ padding: "10px 16px", borderRadius: "8px", background: tokens.lossBg, border: `1px solid ${tokens.lossBorder}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
      <span style={{ fontSize: "13px", color: tokens.loss, fontWeight: 500 }}>
        🔴 {parts.join(" · ")} in this period
      </span>
      <button
        onClick={() => navigate("/app/actions")}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: tokens.loss, fontWeight: 700, padding: 0, flexShrink: 0 }}
      >
        View in Action Center →
      </button>
    </div>
  );
}


// ── Orders table ──────────────────────────────────────────────────────────────
const COL_WIDTHS = "130px 90px 90px 80px 90px 70px 80px 80px 90px 70px 90px 80px";
const HEADINGS = ["Order", "Date", "Revenue", "Discount", "COGS", "Fees", "Shipping", "Ad Spend", "Net Profit", "Margin", "Top Cost", "Action"];

function OrdersTable({ orders, shop, page, totalPages, totalCount, missingCogsCount, lossSummary, onPageChange, isLoading, sortMode, onSortToggle }: {
  orders: OrderRow[]; shop: string; page: number; totalPages: number; totalCount: number;
  missingCogsCount: number; lossSummary: LossSummary;
  onPageChange: (p: number) => void; isLoading: boolean;
  sortMode: "default"|"loss"; onSortToggle: () => void;
}) {
  const costIcons: Record<string, string> = { Ads: "📢", COGS: "📦", Shipping: "🚚", Fees: "💳" };
  return (
    <DCard>
      {/* Toolbar */}
      <div style={{ padding: "10px 16px", borderBottom: `1px solid ${tokens.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", background: "#f8fafc" }}>
        <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>{sortMode === "loss" ? "Sorted: worst first" : "Sorted: newest first"}</p>
        <button onClick={onSortToggle}
          style={{ padding: "4px 12px", borderRadius: "6px", background: sortMode === "loss" ? tokens.text : "transparent", color: sortMode === "loss" ? "#fff" : tokens.textMuted, border: `1px solid ${sortMode === "loss" ? tokens.text : tokens.border}`, cursor: "pointer", fontSize: "12px", fontWeight: 600 }}
        >{sortMode === "loss" ? "Reset order" : "Show worst first"}</button>
      </div>
      {/* Scrollable table area */}
      <div style={{ overflowX: "auto" }}>
      {/* Column headers */}
      <div style={{ display: "grid", gridTemplateColumns: COL_WIDTHS, padding: "8px 16px", borderBottom: `1px solid ${tokens.border}`, background: "#f8fafc", minWidth: "900px" }}>
        {HEADINGS.map((h) => <span key={h} style={{ fontSize: "11px", fontWeight: 700, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.04em" }}>{h}</span>)}
      </div>
      {/* Rows */}
      <div style={{ opacity: isLoading ? 0.5 : 1, transition: "opacity 0.2s" }}>
        {orders.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center" }}>
            <p style={{ margin: 0, fontSize: "14px", color: tokens.textMuted }}>No orders match your filters</p>
          </div>
        ) : orders.map((o) => {
          const rowBg = !o.cogsComplete ? "#fffbeb" : o.netProfit < 0 ? "#fef2f2" : tokens.cardBg;
          return (
            <div key={o.id} style={{ display: "grid", gridTemplateColumns: COL_WIDTHS, padding: "10px 16px", alignItems: "center", borderBottom: `1px solid ${tokens.border}`, background: rowBg, transition: "filter 0.1s" }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.filter = "brightness(0.97)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.filter = "none")}
            >
              <a href={getOrderUrl(shop, o.shopifyOrderId)} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: "13px", fontWeight: 600, color: "#2563eb", textDecoration: "none", display: "flex", alignItems: "center", gap: "3px" }}
                onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")} onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
              >{o.shopifyOrderName} <span style={{ fontSize: "10px", color: "#94a3b8" }}>↗</span></a>
              <span style={{ fontSize: "12px", color: tokens.textMuted }}>{new Date(o.shopifyCreatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
              <span style={{ fontSize: "13px", color: tokens.text }}>{fmt(o.totalPrice, o.currency)}</span>
              <span style={{ fontSize: "13px", color: o.totalDiscounts > 0 ? tokens.warning : tokens.textMuted }}>{o.totalDiscounts > 0 ? `−${fmt(o.totalDiscounts, o.currency)}` : "—"}</span>
              <span style={{ fontSize: "13px", color: o.cogsComplete ? tokens.text : tokens.warning }}>{fmt(o.cogs, o.currency)}{!o.cogsComplete && " ⚠"}</span>
              <span style={{ fontSize: "13px", color: tokens.textMuted }}>{fmt(o.transactionFee, o.currency)}</span>
              <span style={{ fontSize: "13px", color: tokens.textMuted }}>{fmt(o.shippingCost, o.currency)}</span>
              <span style={{ fontSize: "13px", color: tokens.textMuted }}>{o.adSpendAllocated > 0 ? fmt(o.adSpendAllocated, o.currency) : "—"}</span>
              <span style={{ fontSize: "13px", fontWeight: 700, color: o.netProfit < 0 ? tokens.loss : tokens.profit }}>{fmt(o.netProfit, o.currency)}</span>
              <DBadge variant={!o.cogsComplete ? "warning" : o.marginPercent < 0 ? "danger" : o.marginPercent < 10 ? "warning" : "success"} size="sm">
                {o.cogsComplete ? `${o.marginPercent.toFixed(1)}%` : "?%"}
              </DBadge>
              <div>
                {o.netProfit < 0 ? (
                  <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                    <span style={{ fontSize: "12px" }}>{costIcons[o.topCostReason] ?? "•"} {o.topCostReason}</span>
                    {o.repeatLossCount >= 3 && <DBadge variant="danger" size="sm">×{o.repeatLossCount}</DBadge>}
                    {o.repeatLossCount >= 2 && o.repeatLossCount < 3 && <DBadge variant="warning" size="sm">×{o.repeatLossCount}</DBadge>}
                  </div>
                ) : <span style={{ fontSize: "12px", color: tokens.textMuted }}>—</span>}
              </div>
              <div>
                {o.isHeld ? <ReleaseHoldButton orderId={o.id} /> : (
                  <a href={getOrderUrl(shop, o.shopifyOrderId)} target="_blank" rel="noopener noreferrer" style={{ fontSize: "12px", color: "#2563eb", textDecoration: "none", fontWeight: 500 }}>View ↗</a>
                )}
              </div>
            </div>
          );
        })}
      </div>
      </div>{/* end scrollable table */}
      {/* Footer */}
      <div style={{ padding: "12px 16px", borderTop: `1px solid ${tokens.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>
            {`${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, totalCount)} of ${totalCount} orders`}
            {missingCogsCount > 0 && " · ⚠ = incomplete COGS"}
          </p>
          {lossSummary.count > 0 && <p style={{ margin: "2px 0 0", fontSize: "12px", color: tokens.loss, fontWeight: 500 }}>{lossSummary.count} loss orders · {fmt(Math.abs(lossSummary.totalLoss))} lost</p>}
        </div>
        {totalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "12px", color: tokens.textMuted }}>Page {page} of {totalPages}</span>
            <button onClick={() => onPageChange(page - 1)} disabled={page <= 1} style={{ padding: "5px 12px", borderRadius: "6px", border: `1px solid ${tokens.border}`, background: page <= 1 ? "#f8fafc" : tokens.cardBg, cursor: page <= 1 ? "default" : "pointer", fontSize: "12px", color: page <= 1 ? tokens.textMuted : tokens.text, fontWeight: 500 }}>← Prev</button>
            <button onClick={() => onPageChange(page + 1)} disabled={page >= totalPages} style={{ padding: "5px 12px", borderRadius: "6px", border: `1px solid ${tokens.border}`, background: page >= totalPages ? "#f8fafc" : tokens.cardBg, cursor: page >= totalPages ? "default" : "pointer", fontSize: "12px", color: page >= totalPages ? tokens.textMuted : tokens.text, fontWeight: 500 }}>Next →</button>
          </div>
        )}
      </div>
    </DCard>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function OrdersPage() {
  const { orders, summary, worstOrders, dateFrom, dateTo, status, profitability, cogsFilter, reason, page, totalPages, totalCount, shop } = useLoaderData() as LoaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const isNavigating = navigation.state === "loading";
  const [sortMode, setSortMode] = useState<"default"|"loss">("default");

  useEffect(() => {
    const hasDateParam = searchParams.has("from") || searchParams.has("to");
    if (!hasDateParam) {
      const saved = loadFromStorage();
      if (saved) { const next = new URLSearchParams(searchParams); next.set("from", saved.from); next.set("to", saved.to); setSearchParams(next, { replace: true }); }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete(key); else next.set(key, value);
    if (key !== "page") next.set("page", "1");
    setSearchParams(next);
    // Scroll to table so user sees filtered results immediately
    if (key !== "page") {
      setTimeout(() => {
        document.getElementById("orders-table")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 150);
    }
  };
  const updateDateRange = (from: string, to: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("from", from); next.set("to", to); next.set("page", "1");
    setSearchParams(next);
  };

  const displayOrders = sortMode === "loss" ? [...orders].sort((a, b) => a.netProfit - b.netProfit) : orders;
  const reasonLabels: Record<string, string> = { ads: "📢 Ads", cogs: "📦 COGS", shipping: "🚚 Shipping", fees: "💳 Fees" };

  return (
    <Page title="Orders">
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>

        {/* Filters */}
        <DCard>
          <div style={{ padding: "16px" }}>
            <div style={{ marginBottom: "14px" }}>
              <DateRangePicker dateFrom={dateFrom} dateTo={dateTo} onUpdate={updateDateRange} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
              <Select label="Status" options={[{ label: "All statuses", value: "all" }, { label: "Clear", value: "clear" }, { label: "On Hold", value: "held" }, { label: "Paid", value: "paid" }, { label: "Pending", value: "pending" }, { label: "Refunded", value: "refunded" }, { label: "Partially Refunded", value: "partially_refunded" }, { label: "Cancelled / Voided", value: "cancelled" }]} value={status} onChange={(v) => updateParam("status", v)} disabled={isNavigating} />
              <Select label="Profitability" options={[{ label: "All orders", value: "all" }, { label: "Profitable only", value: "profitable" }, { label: "Losses only", value: "loss" }]} value={profitability} onChange={(v) => updateParam("profitability", v)} disabled={isNavigating} />
              <Select label="COGS" options={[{ label: "All", value: "all" }, { label: "Missing only", value: "missing" }]} value={cogsFilter} onChange={(v) => updateParam("cogs", v)} disabled={isNavigating} />
              <Select label="Top cost" options={[{ label: "All reasons", value: "all" }, { label: "📢 Ads", value: "ads" }, { label: "📦 COGS", value: "cogs" }, { label: "🚚 Shipping", value: "shipping" }, { label: "💳 Fees", value: "fees" }]} value={reason} onChange={(v) => updateParam("reason", v)} disabled={isNavigating} />
            </div>
            {/* Active filters row */}
            {(status !== "all" || profitability !== "all" || cogsFilter !== "all" || reason !== "all") && (
              <div style={{ marginTop: "10px", display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                <span style={{ fontSize: "12px", color: tokens.textMuted, marginRight: "2px" }}>Active:</span>
                {status !== "all" && <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 10px", borderRadius: "100px", background: "#f1f5f9", border: `1px solid ${tokens.border}`, fontSize: "12px", fontWeight: 600 }}>Status: {status} <button onClick={() => updateParam("status", "all")} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: tokens.textMuted, padding: "0 0 0 2px", lineHeight: 1 }}>×</button></span>}
                {profitability !== "all" && <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 10px", borderRadius: "100px", background: "#f1f5f9", border: `1px solid ${tokens.border}`, fontSize: "12px", fontWeight: 600 }}>Profitability: {profitability} <button onClick={() => updateParam("profitability", "all")} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: tokens.textMuted, padding: "0 0 0 2px", lineHeight: 1 }}>×</button></span>}
                {cogsFilter !== "all" && <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 10px", borderRadius: "100px", background: "#f1f5f9", border: `1px solid ${tokens.border}`, fontSize: "12px", fontWeight: 600 }}>COGS: {cogsFilter} <button onClick={() => updateParam("cogs", "all")} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: tokens.textMuted, padding: "0 0 0 2px", lineHeight: 1 }}>×</button></span>}
                {reason !== "all" && <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 10px", borderRadius: "100px", background: "#fffbeb", border: `1px solid #fde68a`, fontSize: "12px", fontWeight: 600, color: tokens.warning }}>{reasonLabels[reason] ?? reason} is top cost <button onClick={() => updateParam("reason", "all")} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: tokens.warning, padding: "0 0 0 2px", lineHeight: 1 }}>×</button></span>}
                <button onClick={() => { updateParam("status", "all"); updateParam("profitability", "all"); updateParam("cogs", "all"); updateParam("reason", "all"); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: tokens.textMuted, textDecoration: "underline", marginLeft: "4px" }}>Clear all</button>
              </div>
            )}
            {isNavigating && <p style={{ margin: "8px 0 0", fontSize: "12px", color: tokens.textMuted }}>Updating…</p>}
          </div>
        </DCard>

        {/* Loss headline */}
        <LossHeadline summary={summary} worstOrders={worstOrders} />

        {/* Action Center — contextual to this date range, with hub link */}
        <IssueStrip summary={summary} navigate={navigate} />

        {/* Summary strip */}
        <SummaryStrip summary={summary} onFilter={updateParam} />

        {/* Orders table */}
        <div id="orders-table" />
        {isNavigating ? (
          <DCard>
            <div style={{ padding: "20px" }}>
              <SkeletonDisplayText size="small" />
              <div style={{ marginTop: "12px" }}><SkeletonBodyText lines={8} /></div>
            </div>
          </DCard>
        ) : (
          <OrdersTable
            orders={displayOrders} shop={shop}
            page={page} totalPages={totalPages} totalCount={totalCount}
            missingCogsCount={summary.missingCogsCount} lossSummary={summary.lossSummary}
            onPageChange={(p) => updateParam("page", String(p))}
            isLoading={isNavigating}
            sortMode={sortMode} onSortToggle={() => setSortMode(s => s === "loss" ? "default" : "loss")}
          />
        )}
      </div>
    </Page>
  );
}
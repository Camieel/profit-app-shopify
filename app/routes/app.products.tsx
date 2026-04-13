// app/routes/app.products.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigation, useSearchParams, useNavigate } from "react-router";
import { useState, useEffect } from "react";
import { Page, Select, SkeletonBodyText, SkeletonDisplayText } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { DateRangePicker, loadFromStorage } from "../DateRangePicker";
import db from "../db.server";

// ── Types (unchanged) ─────────────────────────────────────────────────────────
interface ProductAnalytic {
  id: string; title: string; unitsSold: number; revenue: number;
  grossProfit: number; grossMargin: number; ordersCount: number;
  avgOrderValue: number; cogsComplete: boolean; missingVariantsCount: number;
  totalVariantsCount: number; revenuePrev: number; grossProfitPrev: number;
}
interface LoaderData {
  products: ProductAnalytic[];
  summary: { totalProducts: number; totalUnitsSold: number; totalRevenue: number; totalGrossProfit: number; avgMargin: number; missingCogsProducts: number; missingCogsVariants: number; };
  dateFrom: string; dateTo: string; search: string; sortBy: string; shop: string;
}
function toDateStr(d: Date) { return d.toISOString().split("T")[0]; }

// ── Loader (unchanged) ────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;
  const url = new URL(request.url);
  const now = new Date();
  const defaultTo = toDateStr(now);
  const defaultFrom = toDateStr(new Date(now.getTime() - 30 * 86400000));
  const dateFrom = url.searchParams.get("from") || defaultFrom;
  const dateTo = url.searchParams.get("to") || defaultTo;
  const search = url.searchParams.get("search") || "";
  const sortBy = url.searchParams.get("sort") || "grossProfit";
  const since = new Date(dateFrom + "T00:00:00.000Z");
  const until = new Date(dateTo + "T23:59:59.999Z");
  const periodMs = until.getTime() - since.getTime();
  const prevSince = new Date(since.getTime() - periodMs);
  const prevUntil = new Date(since.getTime() - 1);
  const [lineItemsCurrent, lineItemsPrev, allVariants] = await Promise.all([
    db.orderLineItem.findMany({ where: { order: { shop, shopifyCreatedAt: { gte: since, lte: until } } }, select: { productTitle: true, price: true, quantity: true, cogs: true, orderId: true } }),
    db.orderLineItem.findMany({ where: { order: { shop, shopifyCreatedAt: { gte: prevSince, lte: prevUntil } } }, select: { productTitle: true, price: true, quantity: true, cogs: true } }),
    db.productVariant.findMany({ where: { product: { shop } }, select: { effectiveCost: true, product: { select: { title: true } } } }),
  ]);
  const variantCoverageMap = new Map<string, { total: number; missing: number }>();
  for (const v of allVariants) {
    const pid = v.product?.title ?? "";
    const existing = variantCoverageMap.get(pid) ?? { total: 0, missing: 0 };
    variantCoverageMap.set(pid, { total: existing.total + 1, missing: existing.missing + (v.effectiveCost === null ? 1 : 0) });
  }
  const productMap = new Map<string, { title: string; unitsSold: number; revenue: number; grossProfit: number; orderIds: Set<string> }>();
  for (const item of lineItemsCurrent) {
    const pid = item.productTitle || "Unknown product";
    const existing = productMap.get(pid) ?? { title: item.productTitle || "Unknown product", unitsSold: 0, revenue: 0, grossProfit: 0, orderIds: new Set<string>() };
    const lineRevenue = item.price * item.quantity;
    existing.unitsSold += item.quantity; existing.revenue += lineRevenue;
    existing.grossProfit += lineRevenue - item.cogs; existing.orderIds.add(item.orderId);
    productMap.set(pid, existing);
  }
  const productPrevMap = new Map<string, { revenue: number; grossProfit: number }>();
  for (const item of lineItemsPrev) {
    const pid = item.productTitle || "Unknown product";
    const existing = productPrevMap.get(pid) ?? { revenue: 0, grossProfit: 0 };
    productPrevMap.set(pid, { revenue: existing.revenue + item.price * item.quantity, grossProfit: existing.grossProfit + (item.price * item.quantity - item.cogs) });
  }
  let products: ProductAnalytic[] = [...productMap.entries()].map(([pid, data]) => {
    const coverage = variantCoverageMap.get(pid) ?? { total: 0, missing: 0 };
    const prev = productPrevMap.get(pid) ?? { revenue: 0, grossProfit: 0 };
    const grossMargin = data.revenue > 0 ? (data.grossProfit / data.revenue) * 100 : 0;
    return { id: pid, title: data.title, unitsSold: data.unitsSold, revenue: data.revenue, grossProfit: data.grossProfit, grossMargin, ordersCount: data.orderIds.size, avgOrderValue: data.orderIds.size > 0 ? data.revenue / data.orderIds.size : 0, cogsComplete: coverage.missing === 0, missingVariantsCount: coverage.missing, totalVariantsCount: coverage.total, revenuePrev: prev.revenue, grossProfitPrev: prev.grossProfit };
  });
  if (search) { const q = search.toLowerCase(); products = products.filter((p) => p.title.toLowerCase().includes(q)); }
  const sortFns: Record<string, (a: ProductAnalytic, b: ProductAnalytic) => number> = { grossProfit: (a, b) => b.grossProfit - a.grossProfit, grossProfitAsc: (a, b) => a.grossProfit - b.grossProfit, revenue: (a, b) => b.revenue - a.revenue, units: (a, b) => b.unitsSold - a.unitsSold, margin: (a, b) => b.grossMargin - a.grossMargin };
  products.sort(sortFns[sortBy] ?? sortFns.grossProfit);
  const totalRevenue = products.reduce((s, p) => s + p.revenue, 0);
  const totalGrossProfit = products.reduce((s, p) => s + p.grossProfit, 0);
  const totalUnitsSold = products.reduce((s, p) => s + p.unitsSold, 0);
  const avgMargin = products.length > 0 ? products.reduce((s, p) => s + p.grossMargin, 0) / products.length : 0;
  return json({ products, summary: { totalProducts: products.length, totalUnitsSold, totalRevenue, totalGrossProfit, avgMargin, missingCogsProducts: products.filter((p) => !p.cogsComplete).length, missingCogsVariants: allVariants.filter((v) => v.effectiveCost === null).length }, dateFrom, dateTo, search, sortBy, shop });
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
  variant?: "default" | "success" | "danger" | "warning" | "neutral";
  size?: "sm" | "md";
}) {
  const colors: Record<string, { bg: string; color: string; border: string }> = {
    default: { bg: "#f1f5f9", color: "#475569", border: "#e2e8f0" },
    success: { bg: tokens.profitBg, color: tokens.profit, border: tokens.profitBorder },
    danger:  { bg: tokens.lossBg, color: tokens.loss, border: tokens.lossBorder },
    warning: { bg: tokens.warningBg, color: tokens.warning, border: tokens.warningBorder },
    neutral: { bg: "#f8fafc", color: tokens.textMuted, border: tokens.border },
  };
  const c = colors[variant];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", padding: size === "sm" ? "2px 8px" : "3px 10px", borderRadius: "100px", fontSize: size === "sm" ? "11px" : "12px", fontWeight: 600, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>
      {children}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n);
}

function TrendArrow({ curr, prev }: { curr: number; prev: number }) {
  if (prev === 0) return null;
  const pct = ((curr - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  return (
    <span style={{ fontSize: "11px", fontWeight: 600, color: up ? tokens.profit : tokens.loss }}>
      {up ? "↑" : "↓"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

// ── Summary strip ─────────────────────────────────────────────────────────────
function SummaryStrip({ summary }: { summary: LoaderData["summary"] }) {
  const metrics = [
    { label: "Products", value: String(summary.totalProducts), sub: "with sales", critical: false },
    { label: "Units Sold", value: String(summary.totalUnitsSold), sub: "in period", critical: false },
    { label: "Revenue", value: fmt(summary.totalRevenue), sub: "gross", critical: false },
    { label: "Gross Profit", value: fmt(summary.totalGrossProfit), sub: "after COGS", critical: summary.totalGrossProfit < 0 },
    { label: "Avg Margin", value: summary.avgMargin.toFixed(1) + "%", sub: "gross", critical: summary.avgMargin < 15 },
    { label: "COGS Gaps", value: String(summary.missingCogsProducts), sub: "incomplete", critical: summary.missingCogsProducts > 0 },
  ];
  return (
    <DCard>
      <div style={{ display: "flex", overflowX: "auto" }}>
        {metrics.map((m, i) => (
          <div key={m.label} style={{ flex: "1 1 0", minWidth: "120px", padding: "14px 18px", borderRight: i < metrics.length - 1 ? `1px solid ${tokens.border}` : undefined, background: m.critical ? tokens.warningBg : tokens.cardBg }}>
            <p style={{ margin: "0 0 4px", fontSize: "11px", fontWeight: 600, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{m.label}</p>
            <p style={{ margin: "0 0 2px", fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", color: m.critical ? tokens.loss : tokens.text }}>{m.value}</p>
            <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>{m.sub}</p>
          </div>
        ))}
      </div>
    </DCard>
  );
}

// ── Top/Worst spotlight cards ─────────────────────────────────────────────────
function SpotlightCards({ top, worst, onNavigate }: {
  top: ProductAnalytic | null;
  worst: ProductAnalytic | null;
  onNavigate: (url: string) => void;
}) {
  if (!top && !worst) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
      {top && (
        <div
          onClick={() => onNavigate(`/app/orders?profitability=all&search=${encodeURIComponent(top.title)}`)}
          style={{ padding: "18px 20px", borderRadius: "12px", background: tokens.profitBg, border: `1px solid ${tokens.profitBorder}`, cursor: "pointer", transition: "box-shadow 0.15s" }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.boxShadow = "none")}
        >
          <p style={{ margin: "0 0 4px", fontSize: "11px", fontWeight: 700, color: tokens.profit, textTransform: "uppercase", letterSpacing: "0.08em" }}>🏆 Top Performer</p>
          <p style={{ margin: "0 0 12px", fontSize: "15px", fontWeight: 700, color: tokens.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{top.title}</p>
          <div style={{ display: "flex", gap: "20px" }}>
            {[{ label: "Gross profit", value: `+${fmt(top.grossProfit)}`, color: tokens.profit }, { label: "Units sold", value: String(top.unitsSold) }, { label: "Margin", value: `${top.grossMargin.toFixed(1)}%` }].map((s) => (
              <div key={s.label}>
                <p style={{ margin: "0 0 2px", fontSize: "11px", color: tokens.textMuted }}>{s.label}</p>
                <p style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: s.color ?? tokens.text }}>{s.value}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {worst && (
        <div
          onClick={() => onNavigate(`/app/orders?profitability=loss&search=${encodeURIComponent(worst.title)}`)}
          style={{ padding: "18px 20px", borderRadius: "12px", background: tokens.lossBg, border: `1px solid ${tokens.lossBorder}`, cursor: "pointer", transition: "box-shadow 0.15s" }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.boxShadow = "none")}
        >
          <p style={{ margin: "0 0 4px", fontSize: "11px", fontWeight: 700, color: tokens.loss, textTransform: "uppercase", letterSpacing: "0.08em" }}>⚠️ Biggest Leak</p>
          <p style={{ margin: "0 0 12px", fontSize: "15px", fontWeight: 700, color: tokens.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{worst.title}</p>
          <div style={{ display: "flex", gap: "20px" }}>
            {[{ label: "Gross loss", value: fmt(worst.grossProfit), color: tokens.loss }, { label: "Units sold", value: String(worst.unitsSold) }, { label: "Margin", value: `${worst.grossMargin.toFixed(1)}%`, color: tokens.loss }].map((s) => (
              <div key={s.label}>
                <p style={{ margin: "0 0 2px", fontSize: "11px", color: tokens.textMuted }}>{s.label}</p>
                <p style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: s.color ?? tokens.text }}>{s.value}</p>
              </div>
            ))}
          </div>
          <p style={{ margin: "10px 0 0", fontSize: "12px", color: tokens.loss, fontWeight: 500 }}>Click to view loss orders →</p>
        </div>
      )}
    </div>
  );
}

// ── Products table ────────────────────────────────────────────────────────────
const COL = "1fr 70px 110px 120px 80px 110px 80px";
const HEADS = ["Product", "Units", "Revenue", "Gross Profit", "Margin", "Avg Order", "Action"];

function ProductsTable({ products, isLoading, onNavigate }: {
  products: ProductAnalytic[]; isLoading: boolean; onNavigate: (url: string) => void;
}) {
  return (
    <>
      {/* Column headers */}
      <div style={{ display: "grid", gridTemplateColumns: COL, padding: "8px 16px", borderBottom: `1px solid ${tokens.border}`, background: "#f8fafc" }}>
        {HEADS.map((h) => (
          <span key={h} style={{ fontSize: "11px", fontWeight: 700, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.04em" }}>{h}</span>
        ))}
      </div>
      {/* Rows */}
      <div style={{ opacity: isLoading ? 0.5 : 1, transition: "opacity 0.2s" }}>
        {products.map((p) => (
          <div
            key={p.id}
            onClick={() => onNavigate(`/app/orders?profitability=all&search=${encodeURIComponent(p.title)}`)}
            style={{
              display: "grid", gridTemplateColumns: COL,
              padding: "11px 16px", alignItems: "center",
              borderBottom: `1px solid ${tokens.border}`,
              background: !p.cogsComplete ? tokens.warningBg : p.grossProfit < 0 ? tokens.lossBg : tokens.cardBg,
              cursor: "pointer", transition: "filter 0.1s",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.filter = "brightness(0.97)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.filter = "none")}
          >
            {/* Product name */}
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: "13px", fontWeight: 600, color: tokens.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.title}
              </p>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "2px" }}>
                {!p.cogsComplete && (
                  <span title={`${p.missingVariantsCount} of ${p.totalVariantsCount} variants missing cost data`} style={{ fontSize: "11px", color: tokens.warning, cursor: "help" }}>
                    ⚠ Incomplete COGS
                  </span>
                )}
                <span style={{ fontSize: "11px", color: tokens.textMuted }}>{p.ordersCount} order{p.ordersCount !== 1 ? "s" : ""}</span>
              </div>
            </div>
            {/* Units */}
            <span style={{ fontSize: "13px", color: tokens.text, textAlign: "right" }}>{p.unitsSold}</span>
            {/* Revenue + trend */}
            <div style={{ textAlign: "right" }}>
              <p style={{ margin: 0, fontSize: "13px", color: tokens.text }}>{fmt(p.revenue)}</p>
              <TrendArrow curr={p.revenue} prev={p.revenuePrev} />
            </div>
            {/* Gross profit + trend */}
            <div style={{ textAlign: "right" }}>
              <p style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: p.grossProfit < 0 ? tokens.loss : tokens.profit }}>{fmt(p.grossProfit)}</p>
              <TrendArrow curr={p.grossProfit} prev={p.grossProfitPrev} />
            </div>
            {/* Margin */}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <DBadge variant={p.grossMargin < 0 ? "danger" : p.grossMargin < 15 ? "warning" : "success"} size="sm">
                {p.grossMargin.toFixed(1)}%
              </DBadge>
            </div>
            {/* Avg order */}
            <span style={{ fontSize: "13px", color: tokens.text, textAlign: "right" }}>{fmt(p.avgOrderValue)}</span>
            {/* Action */}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <span style={{ fontSize: "12px", color: "#2563eb", fontWeight: 500 }}>Orders →</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ProductsPage() {
  const { products, summary, dateFrom, dateTo, search, sortBy } = useLoaderData() as LoaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const isLoading = navigation.state === "loading";

  const [searchValue, setSearchValue] = useState(search);
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const hasDateParam = searchParams.has("from") || searchParams.has("to");
    if (!hasDateParam) {
      const saved = loadFromStorage();
      if (saved) {
        const next = new URLSearchParams(searchParams);
        next.set("from", saved.from); next.set("to", saved.to);
        setSearchParams(next, { replace: true });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "page") next.set("page", "1");
    setSearchParams(next);
  };
  const updateDateRange = (from: string, to: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("from", from); next.set("to", to);
    setSearchParams(next);
  };
  const handleSearch = (value: string) => {
    setSearchValue(value);
    if (searchTimeout) clearTimeout(searchTimeout);
    setSearchTimeout(setTimeout(() => updateParam("search", value), 400));
  };

  if (isLoading && products.length === 0) {
    return (
      <Page title="Product Analytics">
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ height: "80px", background: "#f1f5f9", borderRadius: "12px" }} />
          <div style={{ height: "120px", background: "#f1f5f9", borderRadius: "12px" }} />
          <div style={{ height: "300px", background: "#f1f5f9", borderRadius: "12px" }} />
        </div>
      </Page>
    );
  }

  // Only show products with complete COGS as top performer — missing COGS inflates margin to 100%
  const topProduct = products.find((p) => p.cogsComplete && p.grossProfit > 0) ?? null;
  const worstProduct = [...products].filter((p) => p.grossProfit < 0).sort((a, b) => a.grossProfit - b.grossProfit)[0] ?? null;

  return (
    <Page title="Product Analytics">
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>

        {/* COGS warning */}
        {summary.missingCogsVariants > 0 && (
          <div style={{ padding: "12px 16px", borderRadius: "10px", background: tokens.warningBg, border: `1px solid ${tokens.warningBorder}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
            <div>
              <p style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: tokens.warning }}>
                {summary.missingCogsVariants} product variant{summary.missingCogsVariants !== 1 ? "s" : ""} missing cost data — margins may be overstated
              </p>
              <p style={{ margin: "2px 0 0", fontSize: "12px", color: tokens.warning, opacity: 0.8 }}>
                Without cost data, margins appear higher than they actually are.
              </p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-end", flexShrink: 0 }}>
              <button
                onClick={() => navigate("/app/cogs")}
                style={{ padding: "6px 14px", borderRadius: "8px", background: tokens.warning, color: "#fff", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 600, transition: "opacity 0.15s" }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
              >
                Set up product costs →
              </button>
              <button
                onClick={() => navigate("/app/actions")}
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: "11px", color: tokens.warning, textDecoration: "underline", padding: 0 }}
              >
                View in Action Center →
              </button>
            </div>
          </div>
        )}

        {/* Date picker */}
        <DateRangePicker dateFrom={dateFrom} dateTo={dateTo} onUpdate={updateDateRange} />

        {/* Summary strip */}
        <SummaryStrip summary={summary} />

        {/* Spotlight cards */}
        <SpotlightCards top={topProduct} worst={worstProduct} onNavigate={navigate} />

        {/* Table */}
        <DCard>
          {/* Toolbar */}
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tokens.border}`, display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ flex: 1, position: "relative" }}>
              <input
                type="text"
                placeholder="Search by product name…"
                value={searchValue}
                onChange={(e) => handleSearch(e.target.value)}
                style={{
                  width: "100%", padding: "7px 12px 7px 32px", borderRadius: "8px",
                  border: `1px solid ${tokens.border}`, fontSize: "13px", color: tokens.text,
                  outline: "none", background: "#f8fafc", boxSizing: "border-box",
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "#94a3b8")}
                onBlur={(e) => (e.currentTarget.style.borderColor = tokens.border)}
              />
              <span style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", fontSize: "14px", color: tokens.textMuted }}>🔍</span>
              {searchValue && (
                <button onClick={() => handleSearch("")} style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: "14px", color: tokens.textMuted }}>×</button>
              )}
            </div>
            <div style={{ width: "200px", flexShrink: 0 }}>
              <Select
                label="Sort by" labelInline
                options={[{ label: "Gross profit (high → low)", value: "grossProfit" }, { label: "Gross profit (low → high)", value: "grossProfitAsc" }, { label: "Revenue", value: "revenue" }, { label: "Units sold", value: "units" }, { label: "Margin %", value: "margin" }]}
                value={sortBy}
                onChange={(v) => updateParam("sort", v)}
              />
            </div>
          </div>

          {/* Table content */}
          {products.length === 0 ? (
            <div style={{ padding: "48px 20px", textAlign: "center" }}>
              <p style={{ margin: "0 0 8px", fontSize: "15px", fontWeight: 600, color: tokens.text }}>
                {search ? "No products match your search" : "No product sales in this period"}
              </p>
              <p style={{ margin: 0, fontSize: "13px", color: tokens.textMuted }}>
                {search ? "Try a different search term." : "Try a different date range."}
              </p>
            </div>
          ) : (
            <ProductsTable products={products} isLoading={isLoading} onNavigate={navigate} />
          )}

          {/* Footer */}
          <div style={{ padding: "10px 16px", borderTop: `1px solid ${tokens.border}` }}>
            <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>
              {products.length} product{products.length !== 1 ? "s" : ""} · Gross profit = revenue − COGS · Click any row to view orders
            </p>
          </div>
        </DCard>

      </div>
    </Page>
  );
}
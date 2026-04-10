// app/routes/app.configuration.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useNavigate } from "react-router";
import { Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [variantsMissing, settings] = await Promise.all([
    db.productVariant.count({ where: { product: { shop: session.shop }, effectiveCost: null } }),
    db.shopSettings.findUnique({ where: { shop: session.shop } }),
  ]);
  const hasShippingRules = !!(settings as any)?.shippingRules;
  const hasPaymentGateways = !!(settings as any)?.paymentGateways;
  return json({ variantsMissing, hasShippingRules, hasPaymentGateways });
};

// ── Design tokens ─────────────────────────────────────────────────────────────
const tokens = {
  profit: "#16a34a", profitBg: "#f0fdf4", profitBorder: "#bbf7d0",
  warning: "#d97706", warningBg: "#fffbeb", warningBorder: "#fde68a",
  border: "#e2e8f0", cardBg: "#ffffff", text: "#0f172a", textMuted: "#64748b",
};

interface ConfigCard {
  title: string;
  description: string;
  url: string;
  icon: string;
  badge?: { label: string; variant: "warning" | "success" | "neutral" };
  detail: string;
}

export default function ConfigurationPage() {
  const navigate = useNavigate();

  const cards: ConfigCard[] = [
    {
      title: "COGS Configuration",
      description: "Set product cost prices so ClearProfit can calculate accurate gross margins on every order.",
      url: "/app/cogs",
      icon: "📦",
      detail: "Cost of goods sold · per variant",
    },
    {
      title: "Payment Gateways",
      description: "Configure transaction fees per payment provider. Shopify Payments, Mollie, PayPal, Stripe and custom gateways.",
      url: "/app/payment",
      icon: "💳",
      detail: "% fee + fixed fee per order",
    },
    {
      title: "Shipping Rules",
      description: "Set flat, quantity-based or weight-based shipping cost rules to accurately track carrier costs.",
      url: "/app/shipping",
      icon: "🚚",
      detail: "Flat / qty-based / weight-based",
    },
  ];

  return (
    <Page title="Configuration" subtitle="Set up cost data for accurate profit calculations">
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>

        {/* Intro */}
        <div style={{ padding: "14px 18px", borderRadius: "10px", background: "#f8fafc", border: `1px solid ${tokens.border}` }}>
          <p style={{ margin: 0, fontSize: "13px", color: tokens.textMuted }}>
            These three pages contain the cost data that drives every profit calculation in ClearProfit.
            Complete all three sections for accurate margins on every order.
          </p>
        </div>

        {/* Cards grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "14px" }}>
          {cards.map((card) => (
            <button
              key={card.url}
              onClick={() => navigate(card.url)}
              style={{
                display: "flex", flexDirection: "column", alignItems: "flex-start",
                padding: "20px 22px", borderRadius: "12px", textAlign: "left",
                background: tokens.cardBg, border: `1px solid ${tokens.border}`,
                cursor: "pointer", transition: "all 0.15s",
                width: "100%",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.08)");
                (e.currentTarget.style.transform = "translateY(-2px)");
                (e.currentTarget.style.borderColor = "#94a3b8");
              }}
              onMouseLeave={(e) => {
                (e.currentTarget.style.boxShadow = "none");
                (e.currentTarget.style.transform = "none");
                (e.currentTarget.style.borderColor = tokens.border);
              }}
            >
              {/* Icon */}
              <div style={{
                width: 44, height: 44, borderRadius: "10px", marginBottom: "14px",
                background: "#f1f5f9", border: `1px solid ${tokens.border}`,
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: "22px",
              }}>
                {card.icon}
              </div>

              {/* Title + arrow */}
              <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px", width: "100%" }}>
                <p style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "#2563eb", flex: 1 }}>
                  {card.title}
                </p>
                <span style={{ fontSize: "16px", color: "#94a3b8" }}>→</span>
              </div>

              {/* Description */}
              <p style={{ margin: "0 0 12px", fontSize: "13px", color: tokens.textMuted, lineHeight: "1.5" }}>
                {card.description}
              </p>

              {/* Detail pill */}
              <span style={{
                fontSize: "11px", fontWeight: 600, color: tokens.textMuted,
                background: "#f1f5f9", border: `1px solid ${tokens.border}`,
                padding: "2px 10px", borderRadius: "100px",
              }}>
                {card.detail}
              </span>
            </button>
          ))}
        </div>

        {/* Why this matters */}
        <div style={{ padding: "16px 20px", borderRadius: "12px", background: tokens.cardBg, border: `1px solid ${tokens.border}` }}>
          <p style={{ margin: "0 0 10px", fontSize: "13px", fontWeight: 700, color: tokens.text }}>Why all three matter</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
            {[
              { icon: "📦", title: "Missing COGS", impact: "Gross margin shows 100% — completely wrong" },
              { icon: "💳", title: "Missing payment fees", impact: "Net profit overstated by 2–3% per order" },
              { icon: "🚚", title: "Missing shipping rules", impact: "Carrier costs ignored — margins inflated" },
            ].map((item) => (
              <div key={item.title} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                <span style={{ fontSize: "16px", flexShrink: 0 }}>{item.icon}</span>
                <div>
                  <p style={{ margin: "0 0 2px", fontSize: "12px", fontWeight: 600, color: tokens.text }}>{item.title}</p>
                  <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>{item.impact}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Page>
  );
}
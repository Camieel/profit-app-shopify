import { Resend } from "resend";
import { alertEmailHtml, weeklyEmailHtml } from "./email-templates";

const resend = new Resend(process.env.RESEND_API_KEY);

function parseEmails(raw: string): string[] {
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.includes("@"));
}

export async function sendAlertEmail({
  to,
  orderName,
  marginPercent,
  netProfit,
  revenue,
  cogs,
  transactionFee,
  shippingCost,
  adSpend,
  reason,
  isHeld,
}: {
  to: string;
  orderName: string;
  marginPercent: number;
  netProfit: number;
  revenue: number;
  cogs: number;
  transactionFee: number;
  shippingCost: number;
  adSpend: number;
  reason: string;
  isHeld: boolean;
}) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[Email] No RESEND_API_KEY set. Skipping.");
    return;
  }

  const recipients = parseEmails(to);
  if (recipients.length === 0) return;

  try {
    await resend.emails.send({
      from: "ClearProfit <alerts@clearprofit.nl>",
      to: recipients,
      subject: `${netProfit < 0 ? "🔴 Loss" : "⚠️ Low margin"}: Order ${orderName} (${marginPercent.toFixed(1)}%)`,
      html: alertEmailHtml({
        orderName,
        marginPercent,
        netProfit,
        revenue,
        cogs,
        transactionFee,
        shippingCost,
        adSpend,
        reason,
        isHeld,
      }),
    });
    console.log(`[Email] Alert sent to ${recipients.join(", ")} for ${orderName}`);
  } catch (error) {
    console.error("[Email] Failed to send alert:", error);
  }
}

export async function sendWeeklySummaryEmail({
  to,
  shopDomain,
  weekStart,
  weekEnd,
  totalRevenue,
  totalNetProfit,
  avgMargin,
  orderCount,
  heldCount,
  lossCount,
  topLosses,
}: {
  to: string;
  shopDomain: string;
  weekStart: string;
  weekEnd: string;
  totalRevenue: number;
  totalNetProfit: number;
  avgMargin: number;
  orderCount: number;
  heldCount: number;
  lossCount: number;
  topLosses: Array<{ orderName: string; netProfit: number; marginPercent: number }>;
}) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[Email] No RESEND_API_KEY set. Skipping.");
    return;
  }

  const recipients = parseEmails(to);
  if (recipients.length === 0) return;

  try {
    await resend.emails.send({
      from: "ClearProfit <weekly@clearprofit.nl>",
      to: recipients,
      subject: `Weekly P&L: ${weekStart} – ${weekEnd} · $${totalNetProfit.toFixed(2)} net profit`,
      html: weeklyEmailHtml({
        shopDomain,
        weekStart,
        weekEnd,
        totalRevenue,
        totalNetProfit,
        avgMargin,
        orderCount,
        heldCount,
        lossCount,
        topLosses,
      }),
    });
    console.log(`[Email] Weekly summary sent to ${recipients.join(", ")} for ${shopDomain}`);
  } catch (error) {
    console.error("[Email] Failed to send weekly summary:", error);
  }
}
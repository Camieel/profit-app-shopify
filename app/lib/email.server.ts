// app/lib/email.server.ts
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendAlertEmail({
  to,
  orderName,
  marginPercent,
  netProfit,
  revenue,
  reason
}: {
  to: string;
  orderName: string;
  marginPercent: number;
  netProfit: number;
  revenue: number;
  reason: string;
}) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[Email] No RESEND_API_KEY found. Skipping email.");
    return;
  }

  try {
    await resend.emails.send({
      from: 'Profit Tracker <onboarding@resend.dev>', // Gebruik deze voor testen in Resend
      to,
      subject: `🚨 Profit Alert: Order ${orderName}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #d92d20;">Profit Alert for Order ${orderName}</h2>
          <p><strong>Reason:</strong> ${reason}</p>
          <div style="background-color: #f9fafb; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <ul style="list-style: none; padding: 0; margin: 0;">
              <li style="margin-bottom: 8px;"><strong>Margin:</strong> ${marginPercent.toFixed(1)}%</li>
              <li style="margin-bottom: 8px;"><strong>Net Profit:</strong> $${netProfit.toFixed(2)}</li>
              <li><strong>Revenue:</strong> $${revenue.toFixed(2)}</li>
            </ul>
          </div>
          <p style="color: #475467; font-size: 14px;">Check your Profit Tracker dashboard for full cost breakdowns.</p>
        </div>
      `
    });
    console.log(`[Email] Alert sent to ${to} for order ${orderName}`);
  } catch (error) {
    console.error("[Email] Failed to send alert:", error);
  }
}
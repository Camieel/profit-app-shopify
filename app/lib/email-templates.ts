export function alertEmailHtml({
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
  const isLoss = netProfit < 0;
  const accentColor = isLoss ? "#d92d20" : "#b54708";
  const badgeBg = isLoss ? "#fef3f2" : "#fffaeb";
  const badgeBorder = isLoss ? "#fecdca" : "#fedf89";
  const badgeText = isLoss ? "#b42318" : "#b54708";
  const label = isLoss ? "Loss" : "Low margin";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Profit Alert: ${orderName}</title>
</head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background-color:#111827;border-radius:12px 12px 0 0;padding:24px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-size:18px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">ClearProfit</span>
                  </td>
                  <td align="right">
                    <span style="display:inline-block;background-color:${badgeBg};border:1px solid ${badgeBorder};color:${badgeText};font-size:12px;font-weight:700;padding:4px 10px;border-radius:100px;">${label}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color:#ffffff;padding:32px;">
              <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:800;color:#111827;letter-spacing:-0.3px;">
                Order ${orderName} needs your attention
              </h1>
              <p style="margin:0 0 24px 0;font-size:15px;color:#6b7280;line-height:1.6;">
                ${reason}${isHeld ? " The fulfillment has been <strong>automatically held</strong> — go to your dashboard to release or cancel." : ""}
              </p>

              <!-- Margin highlight -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color:${badgeBg};border:1px solid ${badgeBorder};border-radius:8px;margin-bottom:24px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td>
                          <span style="font-size:13px;color:${badgeText};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Net margin</span><br>
                          <span style="font-size:32px;font-weight:800;color:${accentColor};">${marginPercent.toFixed(1)}%</span>
                        </td>
                        <td align="right">
                          <span style="font-size:13px;color:${badgeText};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Net profit</span><br>
                          <span style="font-size:32px;font-weight:800;color:${accentColor};">$${netProfit.toFixed(2)}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Cost breakdown -->
              <p style="margin:0 0 12px 0;font-size:13px;font-weight:700;color:#111827;text-transform:uppercase;letter-spacing:0.08em;">Cost breakdown</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                ${[
                  { label: "Revenue", value: revenue, positive: true },
                  { label: "Cost of goods (COGS)", value: -cogs, positive: false },
                  { label: "Transaction fees", value: -transactionFee, positive: false },
                  { label: "Shipping cost", value: -shippingCost, positive: false },
                  { label: "Ad spend (allocated)", value: -adSpend, positive: false },
                ].map((row, i) => `
                <tr style="background-color:${i % 2 === 0 ? "#ffffff" : "#f9fafb"};">
                  <td style="padding:12px 16px;font-size:14px;color:#374151;border-bottom:1px solid #e5e7eb;">${row.label}</td>
                  <td style="padding:12px 16px;font-size:14px;font-weight:600;color:${row.positive ? "#111827" : "#6b7280"};text-align:right;border-bottom:1px solid #e5e7eb;">${row.positive ? "" : "−"}$${Math.abs(row.value).toFixed(2)}</td>
                </tr>`).join("")}
                <tr style="background-color:#f0fdf8;">
                  <td style="padding:14px 16px;font-size:14px;font-weight:700;color:#111827;">Net profit</td>
                  <td style="padding:14px 16px;font-size:14px;font-weight:800;color:${isLoss ? "#d92d20" : "#008060"};text-align:right;">$${netProfit.toFixed(2)}</td>
                </tr>
              </table>

              ${isHeld ? `
              <!-- Hold notice -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;margin-top:24px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <p style="margin:0;font-size:14px;color:#1e40af;">
                      <strong>🛑 Fulfillment is on hold.</strong> This order will not ship until you release it. Go to your dashboard to review and decide.
                    </p>
                  </td>
                </tr>
              </table>` : ""}

              <!-- CTA -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
                <tr>
                  <td>
                    <a href="https://profit-app-shopify-production.up.railway.app/app" style="display:inline-block;background-color:#00a67e;color:#ffffff;font-size:14px;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;">View in dashboard →</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 12px 12px;padding:20px 32px;">
              <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
                You're receiving this because you set up profit alerts in ClearProfit.<br>
                Manage your alert settings in <a href="https://profit-app-shopify-production.up.railway.app/app/settings" style="color:#00a67e;text-decoration:none;">Settings</a>.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function weeklyEmailHtml({
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
  const isProfitable = totalNetProfit >= 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weekly P&L — ${weekStart} to ${weekEnd}</title>
</head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background-color:#111827;border-radius:12px 12px 0 0;padding:24px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-size:18px;font-weight:800;color:#ffffff;">ClearProfit</span><br>
                    <span style="font-size:13px;color:#9ca3af;">Weekly P&L — ${weekStart} to ${weekEnd}</span>
                  </td>
                  <td align="right">
                    <span style="font-size:12px;color:#6b7280;">${shopDomain}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color:#ffffff;padding:32px;">
              <h1 style="margin:0 0 24px 0;font-size:20px;font-weight:800;color:#111827;">
                Your week at a glance
              </h1>

              <!-- Stats grid -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr>
                  <td width="50%" style="padding-right:8px;padding-bottom:12px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <span style="font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Revenue</span><br>
                          <span style="font-size:24px;font-weight:800;color:#111827;">$${totalRevenue.toFixed(2)}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td width="50%" style="padding-left:8px;padding-bottom:12px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:${isProfitable ? "#f0fdf8" : "#fef2f2"};border:1px solid ${isProfitable ? "#b3e8d8" : "#fecaca"};border-radius:8px;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <span style="font-size:12px;color:${isProfitable ? "#047857" : "#b91c1c"};font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Net Profit</span><br>
                          <span style="font-size:24px;font-weight:800;color:${isProfitable ? "#008060" : "#d92d20"};">$${totalNetProfit.toFixed(2)}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td width="50%" style="padding-right:8px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <span style="font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Avg Margin</span><br>
                          <span style="font-size:24px;font-weight:800;color:${avgMargin >= 0 ? "#111827" : "#d92d20"};">${avgMargin.toFixed(1)}%</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td width="50%" style="padding-left:8px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <span style="font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Orders</span><br>
                          <span style="font-size:24px;font-weight:800;color:#111827;">${orderCount}</span>
                          ${heldCount > 0 ? `<span style="font-size:12px;color:#b54708;margin-left:8px;">${heldCount} held</span>` : ""}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              ${topLosses.length > 0 ? `
              <!-- Top losses -->
              <p style="margin:0 0 12px 0;font-size:13px;font-weight:700;color:#111827;text-transform:uppercase;letter-spacing:0.08em;">
                Loss-making orders this week (${lossCount} total)
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:24px;">
                <tr style="background-color:#f9fafb;">
                  <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#6b7280;border-bottom:1px solid #e5e7eb;">Order</td>
                  <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#6b7280;border-bottom:1px solid #e5e7eb;text-align:right;">Margin</td>
                  <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#6b7280;border-bottom:1px solid #e5e7eb;text-align:right;">Net Profit</td>
                </tr>
                ${topLosses.map((o, i) => `
                <tr style="background-color:${i % 2 === 0 ? "#ffffff" : "#fef2f2"};">
                  <td style="padding:12px 16px;font-size:14px;font-weight:600;color:#111827;${i < topLosses.length - 1 ? "border-bottom:1px solid #e5e7eb;" : ""}">${o.orderName}</td>
                  <td style="padding:12px 16px;font-size:14px;font-weight:600;color:#d92d20;text-align:right;${i < topLosses.length - 1 ? "border-bottom:1px solid #e5e7eb;" : ""}">${o.marginPercent.toFixed(1)}%</td>
                  <td style="padding:12px 16px;font-size:14px;font-weight:600;color:#d92d20;text-align:right;${i < topLosses.length - 1 ? "border-bottom:1px solid #e5e7eb;" : ""}">$${o.netProfit.toFixed(2)}</td>
                </tr>`).join("")}
              </table>` : `
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0fdf8;border:1px solid #b3e8d8;border-radius:8px;margin-bottom:24px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <p style="margin:0;font-size:14px;color:#047857;font-weight:600;">✓ No loss-making orders this week. Great work!</p>
                  </td>
                </tr>
              </table>`}

              <!-- CTA -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <a href="https://profit-app-shopify-production.up.railway.app/app" style="display:inline-block;background-color:#00a67e;color:#ffffff;font-size:14px;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;">View full dashboard →</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 12px 12px;padding:20px 32px;">
              <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
                Weekly summary from ClearProfit. Sent every Monday for the previous week.<br>
                Manage your settings at <a href="https://profit-app-shopify-production.up.railway.app/app/settings" style="color:#00a67e;text-decoration:none;">clearprofit settings</a>.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
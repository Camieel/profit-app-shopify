// app/routes/connect.error.tsx
// Shown in the popup tab after failed OAuth.

import { useSearchParams } from "react-router";

const ERROR_MESSAGES: Record<string, string> = {
  meta_auth_failed: "Meta authentication failed — please try again.",
  meta_token_failed: "Could not retrieve Meta access token.",
  meta_no_accounts: "No Meta ad accounts found for this user.",
  meta_config_missing: "Server configuration error — contact support.",
  google_auth_failed: "Google authentication failed — please try again.",
  google_token_failed: "Could not retrieve Google access token.",
  google_no_accounts: "No Google Ads accounts found.",
  google_config_missing: "Server configuration error — contact support.",
  tiktok_auth_failed: "TikTok authentication failed — please try again.",
  tiktok_no_accounts: "No TikTok ad accounts found.",
  tiktok_config_missing: "Server configuration error — contact support.",
};

export default function ConnectError() {
  const [params] = useSearchParams();
  const code = params.get("error") ?? "unknown";
  const message = ERROR_MESSAGES[code] ?? "An unexpected error occurred.";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Connection failed</title>
        <style>{`
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex; align-items: center; justify-content: center;
            min-height: 100vh; background: #f9fafb; color: #111827;
          }
          .card {
            background: white; border-radius: 12px; padding: 40px 48px;
            text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            max-width: 400px; width: 100%;
          }
          .icon { font-size: 48px; margin-bottom: 16px; }
          h1 { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
          p { font-size: 14px; color: #6b7280; line-height: 1.5; margin-bottom: 8px; }
          code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
          button {
            margin-top: 16px; background: #111827; color: white;
            border: none; padding: 10px 20px; border-radius: 8px;
            font-size: 14px; cursor: pointer;
          }
        `}</style>
      </head>
      <body>
        <div className="card">
          <div className="icon">❌</div>
          <h1>Connection failed</h1>
          <p>{message}</p>
          <p><code>{code}</code></p>
          <button onClick={() => window.close()}>Close</button>
        </div>
      </body>
    </html>
  );
}
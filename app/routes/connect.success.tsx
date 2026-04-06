// app/routes/connect.success.tsx
// Shown in the popup tab after successful OAuth.
// Does NOT reload parent — reloading resets React state (e.g. onboarding step).
// User sees confirmation and closes manually or it auto-closes.

export default function ConnectSuccess() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Connected</title>
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
          p { font-size: 14px; color: #6b7280; line-height: 1.5; margin-bottom: 20px; }
          .hint { font-size: 13px; color: #9ca3af; }
        `}</style>
        <script dangerouslySetInnerHTML={{ __html: `
          // Close popup after short delay — parent window is NOT reloaded
          // to preserve React state (e.g. onboarding step).
          // User clicks "Refresh connection status" in the parent instead.
          setTimeout(function() { window.close(); }, 2000);
        `}} />
      </head>
      <body>
        <div className="card">
          <div className="icon">✅</div>
          <h1>Connected successfully</h1>
          <p>This window will close automatically.</p>
          <p className="hint">Go back to the app and click<br/><strong>"Refresh connection status"</strong> to confirm.</p>
        </div>
      </body>
    </html>
  );
}
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useFetcher } from "react-router";
import { useState, useCallback } from "react";
import {
  Page, Text, BlockStack, InlineStack, Button, Banner, Modal,
  DropZone, List, Divider, IndexTable, useIndexResourceState,
  Tabs, TextField, Select, Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── Types (unchanged) ─────────────────────────────────────────────────────────
interface Expense { id: string; name: string; amount: number; currency: string; interval: string; startDate: string; endDate: string | null; isActive: boolean; [key: string]: unknown; }
interface ImportResult { updated: number; errors: string[]; }
interface LoaderData { expenses: Expense[]; monthlyCost: number; yearlyCost: number; shopCurrency: string; }

const INTERVAL_OPTIONS = [{ label: "Monthly", value: "monthly" }, { label: "Weekly", value: "weekly" }, { label: "Yearly", value: "yearly" }, { label: "One-time", value: "one_time" }];
function intervalLabel(interval: string) { return INTERVAL_OPTIONS.find((o) => o.value === interval)?.label ?? interval; }
export function toMonthly(amount: number, interval: string): number {
  switch (interval) { case "weekly": return (amount * 52) / 12; case "yearly": return amount / 12; case "one_time": return 0; default: return amount; }
}

// ── Loader (unchanged) ────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const expenses = await db.expense.findMany({ where: { shop: session.shop }, orderBy: { createdAt: "desc" } });
  const activeExpenses = expenses.filter((e) => e.isActive);
  const monthlyCost = activeExpenses.reduce((s, e) => s + toMonthly(e.amount, e.interval), 0);
  return json({ expenses: expenses.map((e) => ({ id: e.id, name: e.name, amount: e.amount, currency: e.currency, interval: e.interval, startDate: e.startDate instanceof Date ? e.startDate.toISOString() : String(e.startDate), endDate: e.endDate instanceof Date ? e.endDate.toISOString() : e.endDate ? String(e.endDate) : null, isActive: e.isActive })), monthlyCost, yearlyCost: monthlyCost * 12, shopCurrency: "EUR" });
};

// ── Action (unchanged) ────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  if (intent === "create" || intent === "update") {
    const name = formData.get("name") as string; const amount = parseFloat(formData.get("amount") as string); const interval = formData.get("interval") as string; const currency = (formData.get("currency") as string) || "EUR"; const startDate = new Date(formData.get("startDate") as string);
    if (!name || isNaN(amount) || amount < 0) return json({ error: "Invalid input" }, { status: 400 });
    if (intent === "create") { await db.expense.create({ data: { shop: session.shop, name, amount, currency, interval, startDate, isActive: true } }); }
    else { const id = formData.get("id") as string; await db.expense.update({ where: { id }, data: { name, amount, currency, interval, startDate } }); }
    return json({ success: true });
  }
  if (intent === "toggle") { const id = formData.get("id") as string; const current = await db.expense.findUnique({ where: { id } }); if (!current) return json({ error: "Not found" }, { status: 404 }); await db.expense.update({ where: { id }, data: { isActive: !current.isActive } }); return json({ success: true }); }
  if (intent === "delete") { await db.expense.delete({ where: { id: formData.get("id") as string } }); return json({ success: true }); }
  if (intent === "csvImport") {
    const csvData = formData.get("csvData") as string; const shop = session.shop;
    const lines = csvData.split("\n").map((l) => l.trim()).filter(Boolean);
    const dataLines = lines[0]?.toLowerCase().includes("name") ? lines.slice(1) : lines;
    const result: ImportResult = { updated: 0, errors: [] };
    for (const line of dataLines) {
      const parts = line.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
      if (parts.length < 3) { result.errors.push(`Invalid line: "${line}"`); continue; }
      const [name, amountRaw, interval, currency = "EUR"] = parts; const amount = parseFloat(amountRaw);
      if (!name) { result.errors.push(`Missing name: "${line}"`); continue; }
      if (isNaN(amount) || amount < 0) { result.errors.push(`Invalid amount "${amountRaw}" for "${name}"`); continue; }
      if (!["monthly","weekly","yearly","one_time"].includes(interval.toLowerCase())) { result.errors.push(`Invalid interval "${interval}" for "${name}"`); continue; }
      await db.expense.create({ data: { shop, name, amount, currency: currency.toUpperCase(), interval: interval.toLowerCase(), startDate: new Date(), isActive: true } });
      result.updated++;
    }
    return json({ success: true, result });
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
  children: React.ReactNode; variant?: "default"|"success"|"danger"|"warning"|"info"|"neutral"; size?: "sm"|"md";
}) {
  const colors: Record<string, { bg: string; color: string; border: string }> = {
    default: { bg: "#f1f5f9", color: "#475569", border: "#e2e8f0" },
    success: { bg: tokens.profitBg, color: tokens.profit, border: tokens.profitBorder },
    danger:  { bg: tokens.lossBg,   color: tokens.loss,   border: tokens.lossBorder },
    warning: { bg: tokens.warningBg,color: tokens.warning, border: tokens.warningBorder },
    info:    { bg: "#eff6ff", color: "#2563eb", border: "#bfdbfe" },
    neutral: { bg: "#f8fafc", color: tokens.textMuted, border: tokens.border },
  };
  const c = colors[variant];
  return <span style={{ display: "inline-flex", alignItems: "center", padding: size === "sm" ? "2px 8px" : "3px 10px", borderRadius: "100px", fontSize: size === "sm" ? "11px" : "12px", fontWeight: 600, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>{children}</span>;
}

function fmt(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(amount);
}

// ── Modals (Polaris — kept as-is for forms) ───────────────────────────────────
function ExpenseModal({ expense, shopCurrency, onClose, onSave, isSaving }: { expense: Expense | null; shopCurrency: string; onClose: () => void; onSave: (data: Record<string, string>) => void; isSaving: boolean }) {
  const isEdit = !!expense;
  const [name, setName] = useState(expense?.name ?? "");
  const [amount, setAmount] = useState(expense ? String(expense.amount) : "");
  const [interval, setInterval] = useState(expense?.interval ?? "monthly");
  const [currency, setCurrency] = useState(expense?.currency ?? shopCurrency);
  const [startDate, setStartDate] = useState(expense?.startDate ? (expense.startDate as string).split("T")[0] : new Date().toISOString().split("T")[0]);
  return (
    <Modal open onClose={onClose} title={isEdit ? "Edit expense" : "Add expense"}
      primaryAction={{ content: "Save", onAction: () => onSave({ intent: isEdit ? "update" : "create", id: expense?.id ?? "", name, amount, interval, currency, startDate }), loading: isSaving, disabled: !name || !amount }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}>
      <Modal.Section>
        <BlockStack gap="400">
          <TextField label="Expense name" value={name} onChange={setName} autoComplete="off" placeholder="Shopify subscription, Warehouse rent..." />
          <InlineStack gap="400">
            <Box width="50%"><TextField label="Amount" type="number" value={amount} onChange={setAmount} autoComplete="off" prefix={currency} /></Box>
            <Box width="50%"><Select label="Interval" options={INTERVAL_OPTIONS} value={interval} onChange={setInterval} /></Box>
          </InlineStack>
          <TextField label="Start date" type="date" value={startDate} onChange={setStartDate} autoComplete="off" helpText="The date this expense began or will begin" />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function DeleteConfirmModal({ expense, onClose, onConfirm, isDeleting }: { expense: Expense | null; onClose: () => void; onConfirm: (id: string) => void; isDeleting: boolean }) {
  if (!expense) return null;
  return (
    <Modal open onClose={onClose} title="Remove this expense from profit calculations?"
      primaryAction={{ content: "Remove expense", destructive: true, onAction: () => onConfirm(expense.id), loading: isDeleting }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}>
      <Modal.Section>
        <Text as="p"><strong>{expense.name}</strong> will no longer be deducted from your net profit. This cannot be undone.</Text>
      </Modal.Section>
    </Modal>
  );
}

function CsvImportModal({ open, onClose, shopCurrency }: { open: boolean; onClose: () => void; shopCurrency: string }) {
  const fetcher = useFetcher();
  const [csvText, setCsvText] = useState(""); const [fileName, setFileName] = useState<string | null>(null); const [fileError, setFileError] = useState<string | null>(null);
  const isSaving = fetcher.state === "submitting";
  const importResult = (fetcher.data as any)?.result as ImportResult | null;
  const handleDrop = useCallback((_: File[], accepted: File[]) => {
    setFileError(null); const file = accepted[0]; if (!file) return;
    if (!file.name.endsWith(".csv")) { setFileError("Only .csv files are supported."); return; }
    setFileName(file.name); const reader = new FileReader();
    reader.onload = (e) => setCsvText((e.target?.result as string) ?? ""); reader.readAsText(file);
  }, []);
  const handleDownloadTemplate = () => {
    const blob = new Blob(["Name,Amount,Interval,Currency\nShopify subscription,39,monthly,EUR\nWarehouse rent,1200,yearly,EUR\n"], { type: "text/csv" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "expenses-import-template.csv"; a.click(); URL.revokeObjectURL(url);
  };
  const handleClose = () => { setCsvText(""); setFileName(null); setFileError(null); onClose(); };
  return (
    <Modal open={open} onClose={handleClose} title="Import expenses from CSV"
      primaryAction={{ content: "Import", onAction: () => fetcher.submit({ intent: "csvImport", csvData: csvText }, { method: "POST" }), loading: isSaving, disabled: !csvText.trim() || isSaving }}
      secondaryActions={[{ content: "Close", onAction: handleClose }]}>
      <Modal.Section>
        <BlockStack gap="400">
          <Banner tone="info"><p>CSV columns: <strong>Name, Amount, Interval, Currency</strong> (Currency optional).</p></Banner>
          <Button variant="plain" onClick={handleDownloadTemplate}>Download CSV template</Button>
          <Divider />
          <DropZone accept=".csv" type="file" onDrop={handleDrop} label="Upload CSV file">
            {fileName ? (<Box padding="400"><InlineStack gap="200" blockAlign="center"><Text as="p" tone="success">✓ {fileName} loaded</Text><Button variant="plain" onClick={() => { setFileName(null); setCsvText(""); }}>Remove</Button></InlineStack></Box>) : (<DropZone.FileUpload actionTitle="Upload CSV" actionHint="or paste below" />)}
          </DropZone>
          {fileError && <Text as="p" tone="critical">{fileError}</Text>}
          <TextField label="Or paste CSV data directly" multiline={5} value={csvText} onChange={(val) => { setCsvText(val); setFileName(null); }} autoComplete="off" placeholder={"Name,Amount,Interval\nShopify subscription,39,monthly"} />
        </BlockStack>
      </Modal.Section>
      {importResult && (
        <Modal.Section>
          <BlockStack gap="300">
            <Text variant="headingSm" as="h3">Import results</Text>
            <Banner tone={importResult.errors.length > 0 ? "warning" : "success"} title={`${importResult.updated} expense${importResult.updated !== 1 ? "s" : ""} added to profit calculations`}>
              {importResult.updated > 0 && <p>These costs will now be deducted from your net profit automatically.</p>}
            </Banner>
            {importResult.errors.length > 0 && (<BlockStack gap="100"><Text as="p" tone="critical">{`Errors (${importResult.errors.length}):`}</Text><List type="bullet">{importResult.errors.slice(0, 5).map((e, i) => <List.Item key={i}>{e}</List.Item>)}</List></BlockStack>)}
          </BlockStack>
        </Modal.Section>
      )}
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ExpensesPage() {
  const { expenses, monthlyCost, yearlyCost, shopCurrency } = useLoaderData() as LoaderData;
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting" || navigation.state === "loading";
  const [modalExpense, setModalExpense] = useState<Expense | null | "new">(null);
  const [expenseToDelete, setExpenseToDelete] = useState<Expense | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [selectedTab, setSelectedTab] = useState(0);
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(expenses);

  const filteredExpenses = expenses.filter((e) => { if (selectedTab === 1) return e.isActive; if (selectedTab === 2) return !e.isActive; return true; });
  const sortedExpenses = [...filteredExpenses].sort((a, b) => toMonthly(b.amount, b.interval) - toMonthly(a.amount, a.interval));
  const largestExpense = sortedExpenses.find((e) => e.interval !== "one_time" && e.isActive) ?? null;

  const topInsight = monthlyCost > 2000
    ? { title: "Your fixed costs are eating into your profit", message: `You're spending ${fmt(monthlyCost, shopCurrency)}/month on fixed expenses.`, severity: "critical" as const, buttonLabel: "Reduce your biggest costs", onAction: () => setSelectedTab(1) }
    : expenses.length === 0
    ? { title: "No expenses tracked yet", message: "Add recurring costs to get accurate net profit figures.", severity: "warning" as const, buttonLabel: "Add your first expense", onAction: () => setModalExpense("new") }
    : null;

  const isHighOverhead = monthlyCost > 1000;

  const promotedBulkActions = selectedResources.length > 0 ? [
    { content: `Pause ${selectedResources.length}`, onAction: () => { for (const id of selectedResources) { const e = expenses.find((ex) => ex.id === id); if (e?.isActive) submit({ intent: "toggle", id }, { method: "POST" }); } clearSelection(); } },
    { content: `Resume ${selectedResources.length}`, onAction: () => { for (const id of selectedResources) { const e = expenses.find((ex) => ex.id === id); if (!e?.isActive) submit({ intent: "toggle", id }, { method: "POST" }); } clearSelection(); } },
  ] : [];

  const rowMarkup = sortedExpenses.map((expense, index) => {
    const monthlyAmount = toMonthly(expense.amount, expense.interval);
    const isHighCost = monthlyAmount > 500;
    return (
      <IndexTable.Row id={expense.id} key={expense.id} selected={selectedResources.includes(expense.id)} position={index} tone={isHighCost && expense.isActive ? "critical" : undefined} onClick={() => setModalExpense(expense)}>
        <IndexTable.Cell>
          <div>
            <p style={{ margin: 0, fontSize: "14px", fontWeight: 600, color: tokens.text, cursor: "pointer" }}>{expense.name}</p>
            <p style={{ margin: "1px 0 0", fontSize: "11px", color: tokens.textMuted }}>Click to edit</p>
          </div>
        </IndexTable.Cell>
        <IndexTable.Cell><span style={{ fontSize: "13px" }}>{fmt(expense.amount, expense.currency)}</span></IndexTable.Cell>
        <IndexTable.Cell><DBadge variant="info" size="sm">{intervalLabel(expense.interval)}</DBadge></IndexTable.Cell>
        <IndexTable.Cell><span style={{ fontSize: "13px", fontWeight: 600 }}>{expense.interval !== "one_time" ? fmt(monthlyAmount, expense.currency) + "/mo" : "—"}</span></IndexTable.Cell>
        <IndexTable.Cell><span style={{ fontSize: "12px", color: tokens.textMuted }}>{new Date(expense.startDate as string).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span></IndexTable.Cell>
        <IndexTable.Cell><DBadge variant={expense.isActive ? "success" : "neutral"} size="sm">{expense.isActive ? "Active" : "Paused"}</DBadge></IndexTable.Cell>
        <IndexTable.Cell>
          <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
            <button onClick={() => submit({ intent: "toggle", id: expense.id }, { method: "POST" })} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: tokens.textMuted, fontWeight: 500, textDecoration: "underline", padding: 0 }}>
              {expense.isActive ? "Pause" : "Resume"}
            </button>
            <button onClick={() => setExpenseToDelete(expense)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: tokens.loss, fontWeight: 500, textDecoration: "underline", padding: 0 }}>
              Delete
            </button>
          </div>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page title="Recurring Expenses" primaryAction={{ content: "Add expense", onAction: () => setModalExpense("new") }} secondaryActions={[{ content: "Import CSV", onAction: () => setCsvOpen(true) }]}>
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

        {/* Alert / insight */}
        {topInsight && (
          <div style={{ padding: "16px 20px", borderRadius: "10px", background: topInsight.severity === "critical" ? tokens.lossBg : tokens.warningBg, border: `1px solid ${topInsight.severity === "critical" ? tokens.lossBorder : tokens.warningBorder}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
            <div>
              <p style={{ margin: "0 0 4px", fontSize: "14px", fontWeight: 700, color: topInsight.severity === "critical" ? tokens.loss : tokens.warning }}>{topInsight.title}</p>
              <p style={{ margin: "0 0 4px", fontSize: "13px", color: topInsight.severity === "critical" ? tokens.loss : tokens.warning, opacity: 0.85 }}>{topInsight.message}</p>
              {largestExpense && topInsight.severity === "critical" && (
                <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>
                  Biggest: {largestExpense.name} ({fmt(toMonthly(largestExpense.amount, largestExpense.interval), shopCurrency)}/mo)
                </p>
              )}
            </div>
            <button onClick={topInsight.onAction} style={{ padding: "7px 16px", borderRadius: "8px", background: topInsight.severity === "critical" ? tokens.loss : tokens.warning, color: "#fff", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 600, flexShrink: 0 }}>
              {topInsight.buttonLabel}
            </button>
          </div>
        )}

        {isHighOverhead && !topInsight && (
          <Banner tone="warning">
            <p>Fixed costs at {fmt(monthlyCost, shopCurrency)}/month are relatively high — they reduce your profit margin on every order.</p>
          </Banner>
        )}

        {/* KPI strip */}
        <DCard>
          <div style={{ display: "flex" }}>
            {[
              { label: "Monthly overhead", value: fmt(monthlyCost, shopCurrency), sub: "Fixed monthly burn", critical: monthlyCost > 0 },
              { label: "Yearly overhead", value: fmt(yearlyCost, shopCurrency), sub: "Annual fixed costs", critical: false },
              { label: "Active expenses", value: String(expenses.filter((e) => e.isActive).length), sub: expenses.filter((e) => !e.isActive).length > 0 ? `${expenses.filter((e) => !e.isActive).length} paused` : "All active", critical: false },
            ].map((m, i, arr) => (
              <div key={m.label} style={{ flex: "1 1 0", padding: "18px 24px", borderRight: i < arr.length - 1 ? `1px solid ${tokens.border}` : undefined }}>
                <p style={{ margin: "0 0 4px", fontSize: "11px", fontWeight: 600, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{m.label}</p>
                <p style={{ margin: "0 0 2px", fontSize: "24px", fontWeight: 700, letterSpacing: "-0.02em", color: m.critical ? tokens.loss : tokens.text }}>{m.value}</p>
                <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>{m.sub}</p>
              </div>
            ))}
          </div>
        </DCard>

        {/* Table */}
        <DCard>
          <Tabs tabs={[{ id: "all", content: "All" }, { id: "active", content: "Active" }, { id: "paused", content: "Paused" }]} selected={selectedTab} onSelect={setSelectedTab}>
            <IndexTable
              resourceName={{ singular: "expense", plural: "expenses" }}
              itemCount={sortedExpenses.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              promotedBulkActions={promotedBulkActions}
              headings={[{ title: "Name" }, { title: "Amount" }, { title: "Interval" }, { title: "Monthly equiv." }, { title: "Start date" }, { title: "Status" }, { title: "Actions", alignment: "end" }]}
              emptyState={
                selectedTab === 2 ? (<div style={{ padding: "32px", textAlign: "center" }}><p style={{ color: tokens.textMuted }}>All expenses are currently active.</p></div>) :
                expenses.length === 0 ? (
                  <div style={{ padding: "40px 20px", textAlign: "center" }}>
                    <p style={{ margin: "0 0 8px", fontSize: "15px", fontWeight: 600, color: tokens.text }}>No fixed costs tracked</p>
                    <p style={{ margin: "0 0 16px", fontSize: "13px", color: tokens.textMuted }}>Add recurring costs like subscriptions, rent, and agency fees to get accurate net profit.</p>
                    <button onClick={() => setModalExpense("new")} style={{ padding: "8px 20px", borderRadius: "8px", background: tokens.text, color: "#fff", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 600, marginRight: "8px" }}>Add first expense</button>
                    <button onClick={() => setCsvOpen(true)} style={{ padding: "8px 20px", borderRadius: "8px", background: "transparent", color: tokens.textMuted, border: `1px solid ${tokens.border}`, cursor: "pointer", fontSize: "13px", fontWeight: 500 }}>Import CSV</button>
                  </div>
                ) : (<div style={{ padding: "32px", textAlign: "center" }}><p style={{ color: tokens.textMuted }}>No expenses in this view.</p></div>)
              }
            >
              {rowMarkup}
            </IndexTable>
          </Tabs>
        </DCard>

        <div style={{ padding: "10px 16px", borderRadius: "8px", background: "#f8fafc", border: `1px solid ${tokens.border}` }}>
          <p style={{ margin: 0, fontSize: "12px", color: tokens.textMuted }}>Expenses are deducted from your Net Profit on the dashboard. Sorted by monthly impact — largest costs first.</p>
        </div>
      </div>

      {modalExpense !== null && (<ExpenseModal key={modalExpense === "new" ? "new" : (modalExpense as Expense).id} expense={modalExpense === "new" ? null : modalExpense as Expense} shopCurrency={shopCurrency} onClose={() => setModalExpense(null)} onSave={(data) => { submit(data, { method: "POST" }); setModalExpense(null); }} isSaving={isSaving} />)}
      <DeleteConfirmModal expense={expenseToDelete} onClose={() => setExpenseToDelete(null)} onConfirm={(id) => { submit({ intent: "delete", id }, { method: "POST" }); setExpenseToDelete(null); }} isDeleting={isSaving} />
      <CsvImportModal open={csvOpen} onClose={() => setCsvOpen(false)} shopCurrency={shopCurrency} />
    </Page>
  );
}
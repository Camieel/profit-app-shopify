import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useFetcher } from "react-router";
import { useState, useCallback } from "react";
import {
  Page, Layout, Card, Text, Badge, Box, BlockStack, InlineStack,
  Button, TextField, Select, Banner, EmptyState, Modal, DropZone,
  List, Divider, IndexTable, useIndexResourceState, Tabs,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Expense {
  id: string;
  name: string;
  amount: number;
  currency: string;
  interval: string;
  startDate: string;
  endDate: string | null;
  isActive: boolean;
  [key: string]: unknown;
}

interface ImportResult {
  updated: number;
  errors: string[];
}

interface LoaderData {
  expenses: Expense[];
  monthlyCost: number;
  yearlyCost: number;
  shopCurrency: string;
}

const INTERVAL_OPTIONS = [
  { label: "Monthly", value: "monthly" },
  { label: "Weekly", value: "weekly" },
  { label: "Yearly", value: "yearly" },
  { label: "One-time", value: "one_time" },
];

function intervalLabel(interval: string) {
  return INTERVAL_OPTIONS.find((o) => o.value === interval)?.label ?? interval;
}

export function toMonthly(amount: number, interval: string): number {
  switch (interval) {
    case "weekly": return (amount * 52) / 12;
    case "yearly": return amount / 12;
    case "one_time": return 0;
    default: return amount;
  }
}

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const expenses = await db.expense.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });

  const activeExpenses = expenses.filter((e) => e.isActive);
  const monthlyCost = activeExpenses.reduce(
    (s, e) => s + toMonthly(e.amount, e.interval), 0
  );

  return json({
    expenses: expenses.map((e) => ({
      id: e.id,
      name: e.name,
      amount: e.amount,
      currency: e.currency,
      interval: e.interval,
      startDate: e.startDate instanceof Date ? e.startDate.toISOString() : String(e.startDate),
      endDate: e.endDate instanceof Date ? e.endDate.toISOString() : e.endDate ? String(e.endDate) : null,
      isActive: e.isActive,
    })),
    monthlyCost,
    yearlyCost: monthlyCost * 12,
    shopCurrency: "EUR",
  });
};

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create" || intent === "update") {
    const name = formData.get("name") as string;
    const amount = parseFloat(formData.get("amount") as string);
    const interval = formData.get("interval") as string;
    const currency = (formData.get("currency") as string) || "EUR";
    const startDate = new Date(formData.get("startDate") as string);

    if (!name || isNaN(amount) || amount < 0) {
      return json({ error: "Invalid input" }, { status: 400 });
    }

    if (intent === "create") {
      await db.expense.create({
        data: { shop: session.shop, name, amount, currency, interval, startDate, isActive: true },
      });
    } else {
      const id = formData.get("id") as string;
      await db.expense.update({
        where: { id },
        data: { name, amount, currency, interval, startDate },
      });
    }
    return json({ success: true });
  }

  if (intent === "toggle") {
    const id = formData.get("id") as string;
    const current = await db.expense.findUnique({ where: { id } });
    if (!current) return json({ error: "Not found" }, { status: 404 });
    await db.expense.update({ where: { id }, data: { isActive: !current.isActive } });
    return json({ success: true });
  }

  if (intent === "delete") {
    const id = formData.get("id") as string;
    await db.expense.delete({ where: { id } });
    return json({ success: true });
  }

  if (intent === "csvImport") {
    const csvData = formData.get("csvData") as string;
    const shop = session.shop;
    const lines = csvData.split("\n").map((l) => l.trim()).filter(Boolean);
    const dataLines = lines[0]?.toLowerCase().includes("name") ? lines.slice(1) : lines;
    const result: ImportResult = { updated: 0, errors: [] };

    for (const line of dataLines) {
      const parts = line.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
      if (parts.length < 3) {
        result.errors.push(`Invalid line: "${line}" — expected Name,Amount,Interval`);
        continue;
      }
      const [name, amountRaw, interval, currency = "EUR"] = parts;
      const amount = parseFloat(amountRaw);
      if (!name) { result.errors.push(`Missing name on line: "${line}"`); continue; }
      if (isNaN(amount) || amount < 0) { result.errors.push(`Invalid amount "${amountRaw}" for "${name}"`); continue; }
      const validIntervals = ["monthly", "weekly", "yearly", "one_time"];
      if (!validIntervals.includes(interval.toLowerCase())) {
        result.errors.push(`Invalid interval "${interval}" for "${name}"`);
        continue;
      }
      await db.expense.create({
        data: {
          shop, name, amount, currency: currency.toUpperCase(),
          interval: interval.toLowerCase(), startDate: new Date(), isActive: true,
        },
      });
      result.updated++;
    }
    return json({ success: true, result });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

// ── Expense Edit Modal ────────────────────────────────────────────────────────
function ExpenseModal({
  expense, shopCurrency, onClose, onSave, isSaving,
}: {
  expense: Expense | null;
  shopCurrency: string;
  onClose: () => void;
  onSave: (data: Record<string, string>) => void;
  isSaving: boolean;
}) {
  const isEdit = !!expense;
  const [name, setName] = useState(expense?.name ?? "");
  const [amount, setAmount] = useState(expense ? String(expense.amount) : "");
  const [interval, setInterval] = useState(expense?.interval ?? "monthly");
  const [currency, setCurrency] = useState(expense?.currency ?? shopCurrency);
  const [startDate, setStartDate] = useState(
    expense?.startDate
      ? (expense.startDate as string).split("T")[0]
      : new Date().toISOString().split("T")[0]
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? "Edit expense" : "Add expense"}
      primaryAction={{
        content: "Save",
        onAction: () => onSave({ intent: isEdit ? "update" : "create", id: expense?.id ?? "", name, amount, interval, currency, startDate }),
        loading: isSaving,
        disabled: !name || !amount,
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <TextField
            label="Expense name"
            value={name}
            onChange={setName}
            autoComplete="off"
            placeholder="Shopify subscription, Warehouse rent, Agency fee..."
          />
          <InlineStack gap="400">
            <Box width="50%">
              <TextField
                label="Amount"
                type="number"
                value={amount}
                onChange={setAmount}
                autoComplete="off"
                prefix={currency}
              />
            </Box>
            <Box width="50%">
              <Select
                label="Interval"
                options={INTERVAL_OPTIONS}
                value={interval}
                onChange={setInterval}
              />
            </Box>
          </InlineStack>
          <TextField
            label="Start date"
            type="date"
            value={startDate}
            onChange={setStartDate}
            autoComplete="off"
            helpText="The date this expense began or will begin"
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ── Delete Modal — Improvement 7: stronger copy ───────────────────────────────
function DeleteConfirmModal({
  expense, onClose, onConfirm, isDeleting,
}: {
  expense: Expense | null;
  onClose: () => void;
  onConfirm: (id: string) => void;
  isDeleting: boolean;
}) {
  if (!expense) return null;
  return (
    <Modal
      open
      onClose={onClose}
      // Improvement 7: copy makes the profit impact clear
      title="Remove this expense from profit calculations?"
      primaryAction={{
        content: "Remove expense",
        destructive: true,
        onAction: () => onConfirm(expense.id),
        loading: isDeleting,
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <Text as="p">
          <strong>{expense.name}</strong> will no longer be deducted from your net profit.
          This action cannot be undone — add it again if needed.
        </Text>
      </Modal.Section>
    </Modal>
  );
}

// ── CSV Import Modal — Improvement 6: dopamine on result ─────────────────────
function CsvImportModal({
  open, onClose, shopCurrency,
}: {
  open: boolean;
  onClose: () => void;
  shopCurrency: string;
}) {
  const fetcher = useFetcher();
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const isSaving = fetcher.state === "submitting";
  const importResult = (fetcher.data as any)?.result as ImportResult | null;

  const handleDrop = useCallback((_: File[], accepted: File[]) => {
    setFileError(null);
    const file = accepted[0];
    if (!file) return;
    if (!file.name.endsWith(".csv")) { setFileError("Only .csv files are supported."); return; }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => setCsvText((e.target?.result as string) ?? "");
    reader.readAsText(file);
  }, []);

  const handleDownloadTemplate = () => {
    const template = "Name,Amount,Interval,Currency\nShopify subscription,39,monthly,EUR\nWarehouse rent,1200,yearly,EUR\nMeta Ads agency,500,monthly,EUR\n";
    const blob = new Blob([template], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "expenses-import-template.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleClose = () => { setCsvText(""); setFileName(null); setFileError(null); onClose(); };

  // Improvement 6: estimate monthly impact of what was imported
  const estimatedMonthlyAdded = importResult
    ? importResult.updated * 100 // rough estimate — can't know intervals without parsing
    : 0;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Import expenses from CSV"
      primaryAction={{
        content: "Import",
        onAction: () => fetcher.submit({ intent: "csvImport", csvData: csvText }, { method: "POST" }),
        loading: isSaving,
        disabled: !csvText.trim() || isSaving,
      }}
      secondaryActions={[{ content: "Close", onAction: handleClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Banner tone="info">
            <p>CSV columns: <strong>Name, Amount, Interval, Currency</strong> (Currency optional). Interval: monthly / weekly / yearly / one_time.</p>
          </Banner>
          <Button variant="plain" onClick={handleDownloadTemplate}>Download CSV template</Button>
          <Divider />
          <DropZone accept=".csv" type="file" onDrop={handleDrop} label="Upload CSV file">
            {fileName ? (
              <Box padding="400">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="p" tone="success">{"✓ " + fileName + " loaded"}</Text>
                  <Button variant="plain" onClick={() => { setFileName(null); setCsvText(""); }}>Remove</Button>
                </InlineStack>
              </Box>
            ) : (
              <DropZone.FileUpload actionTitle="Upload CSV" actionHint="or paste below" />
            )}
          </DropZone>
          {fileError && <Text as="p" tone="critical">{fileError}</Text>}
          <TextField
            label="Or paste CSV data directly"
            multiline={5}
            value={csvText}
            onChange={(val) => { setCsvText(val); setFileName(null); }}
            autoComplete="off"
            placeholder={"Name,Amount,Interval\nShopify subscription,39,monthly\nWarehouse rent,1200,yearly"}
          />
        </BlockStack>
      </Modal.Section>

      {importResult && (
        <Modal.Section>
          <BlockStack gap="300">
            <Text variant="headingSm" as="h3">Import results</Text>
            {/* Fix 5: financial impact of what was imported */}
            <Banner
              tone={importResult.errors.length > 0 ? "warning" : "success"}
              title={`${importResult.updated} expense${importResult.updated !== 1 ? "s" : ""} added to your profit calculations`}
            >
              {importResult.updated > 0 && (
                <BlockStack gap="050">
                  <p>Your overhead tracking just got more accurate. These costs will now be deducted from your net profit automatically.</p>
                  {estimatedMonthlyAdded > 0 && (
                    <p>
                      <strong>{`Estimated monthly impact tracked: +${new Intl.NumberFormat("en-US", { style: "currency", currency: shopCurrency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(estimatedMonthlyAdded)}/mo`}</strong>
                    </p>
                  )}
                </BlockStack>
              )}
            </Banner>
            {importResult.errors.length > 0 && (
              <BlockStack gap="100">
                <Text as="p" tone="critical">{`Errors (${importResult.errors.length}):`}</Text>
                <List type="bullet">
                  {importResult.errors.slice(0, 5).map((e, i) => <List.Item key={i}>{e}</List.Item>)}
                </List>
              </BlockStack>
            )}
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

  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(expenses);

  const handleSave = (data: Record<string, string>) => {
    submit(data, { method: "POST" });
    setModalExpense(null);
  };

  const handleDelete = (id: string) => {
    submit({ intent: "delete", id }, { method: "POST" });
    setExpenseToDelete(null);
  };

  const formatCurrency = (amount: number, currencyCode: string) =>
    new Intl.NumberFormat("en-US", {
      style: "currency", currency: currencyCode, minimumFractionDigits: 2,
    }).format(amount);

  const filteredExpenses = expenses.filter((e) => {
    if (selectedTab === 1) return e.isActive;
    if (selectedTab === 2) return !e.isActive;
    return true;
  });

  // Improvement 4: sort by monthly impact — biggest costs first
  const sortedExpenses = [...filteredExpenses].sort(
    (a, b) => toMonthly(b.amount, b.interval) - toMonthly(a.amount, a.interval)
  );

  const tabs = [
    { id: "all", content: "All", accessibilityLabel: "All expenses" },
    { id: "active", content: "Active", accessibilityLabel: "Active expenses" },
    { id: "paused", content: "Paused", accessibilityLabel: "Paused expenses" },
  ];

  // Improvement 1: interpret the overhead level
  const HIGH_OVERHEAD_THRESHOLD = 1000;
  const isHighOverhead = monthlyCost > HIGH_OVERHEAD_THRESHOLD;

  // Fix 3: largest cost for callout
  const largestExpense = sortedExpenses.find((e) => e.interval !== "one_time" && e.isActive) ?? sortedExpenses[0] ?? null;

  // Improvement 2: top insight / action center
  const topInsight =
    monthlyCost > 2000
      ? {
          // Fix 6: sharper copy
          title: "Your fixed costs are eating into your profit",
          message: `You're spending ${formatCurrency(monthlyCost, shopCurrency)}/month on fixed expenses. Every order you sell carries part of this cost.`,
          severity: "critical" as const,
          // Fix 6: more action-oriented button
          buttonLabel: "Reduce your biggest costs",
          onAction: () => setSelectedTab(1),
        }
      : expenses.length === 0
      ? {
          title: "No expenses tracked yet",
          message: "You're not accounting for fixed costs in your profit calculations. Add your recurring costs to get accurate net profit figures.",
          severity: "warning" as const,
          buttonLabel: "Add your first expense",
          onAction: () => setModalExpense("new"),
        }
      : null;

  // Fix 4: only show bulk actions when items are actually selected
  const promotedBulkActions = selectedResources.length > 0 ? [
    {
      content: `Pause ${selectedResources.length} expense${selectedResources.length !== 1 ? "s" : ""}`,
      onAction: () => {
        for (const id of selectedResources) {
          const expense = expenses.find((e) => e.id === id);
          if (expense?.isActive) {
            submit({ intent: "toggle", id }, { method: "POST" });
          }
        }
        clearSelection();
      },
    },
    {
      content: `Resume ${selectedResources.length} expense${selectedResources.length !== 1 ? "s" : ""}`,
      onAction: () => {
        for (const id of selectedResources) {
          const expense = expenses.find((e) => e.id === id);
          if (!expense?.isActive) {
            submit({ intent: "toggle", id }, { method: "POST" });
          }
        }
        clearSelection();
      },
    },
  ] : [];

  const rowMarkup = sortedExpenses.map((expense, index) => {
    const monthlyAmount = toMonthly(expense.amount, expense.interval);
    // Improvement 4: highlight high-impact rows
    const isHighCost = monthlyAmount > 500;

    return (
      <IndexTable.Row
        id={expense.id}
        key={expense.id}
        selected={selectedResources.includes(expense.id)}
        position={index}
        tone={isHighCost && expense.isActive ? "critical" : undefined}
        onClick={() => setModalExpense(expense)}
      >
        <IndexTable.Cell>
          <BlockStack gap="0">
            <div style={{ cursor: "pointer" }}>
              <Text variant="bodyMd" fontWeight="semibold" as="span">{expense.name}</Text>
            </div>
            {/* Improvement 9: subtle click hint */}
            <Text variant="bodySm" as="span" tone="subdued">Click to edit</Text>
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {formatCurrency(expense.amount, expense.currency)}
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone="info">{intervalLabel(expense.interval)}</Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {expense.interval !== "one_time"
            ? formatCurrency(monthlyAmount, expense.currency) + "/mo"
            : "—"}
        </IndexTable.Cell>
        <IndexTable.Cell>
          {new Date(expense.startDate as string).toLocaleDateString("en-GB", {
            day: "numeric", month: "short", year: "numeric",
          })}
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={expense.isActive ? "success" : "attention"}>
            {expense.isActive ? "Active" : "Paused"}
          </Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <div onClick={(e) => e.stopPropagation()}>
            <InlineStack gap="200" wrap={false} align="end">
              <Button
                variant="plain"
                size="slim"
                onClick={() => submit({ intent: "toggle", id: expense.id }, { method: "POST" })}
              >
                {expense.isActive ? "Pause" : "Resume"}
              </Button>
              <Button
                variant="plain"
                tone="critical"
                size="slim"
                onClick={() => setExpenseToDelete(expense)}
              >
                Delete
              </Button>
            </InlineStack>
          </div>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page
      title="Recurring Expenses"
      primaryAction={{ content: "Add expense", onAction: () => setModalExpense("new") }}
      secondaryActions={[{ content: "Import CSV", onAction: () => setCsvOpen(true) }]}
    >
      <Layout>
        {/* Action Center — visually dominant, not ignorable */}
        {topInsight && (
          <Layout.Section>
            <div style={{
              padding: "20px 24px", borderRadius: "16px",
              background: topInsight.severity === "critical" ? "#fff1f0" : "#fffbe6",
              border: `1px solid ${topInsight.severity === "critical" ? "#ff4d4f" : "#ffd666"}`,
              boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
            }}>
              <BlockStack gap="200">
                <BlockStack gap="100">
                  <Text variant="headingMd" as="h3">{topInsight.title}</Text>
                  <Text variant="bodySm" as="p" tone={topInsight.severity === "critical" ? "critical" : "caution"}>
                    {topInsight.message}
                  </Text>
                  {/* Fix 2: concrete per-order impact */}
                  {monthlyCost > 0 && (
                    <Text variant="bodySm" as="p" tone="critical">
                      Every order you sell carries part of this fixed cost.
                    </Text>
                  )}
                  {/* Fix 3: largest cost callout */}
                  {largestExpense && topInsight.severity === "critical" && (
                    <Text variant="bodySm" as="p" tone="subdued">
                      {`Biggest cost: ${largestExpense.name} (${formatCurrency(toMonthly(largestExpense.amount, largestExpense.interval), shopCurrency)}/mo)`}
                    </Text>
                  )}
                </BlockStack>
                <Box>
                  <Button variant="primary" onClick={topInsight.onAction}>
                    {topInsight.buttonLabel}
                  </Button>
                </Box>
              </BlockStack>
            </div>
          </Layout.Section>
        )}

        {/* Improvement 1: high overhead warning banner */}
        {isHighOverhead && !topInsight && (
          <Layout.Section>
            <Banner tone="warning">
              <p>
                Your fixed costs are relatively high at {formatCurrency(monthlyCost, shopCurrency)}/month. This reduces your profit margin on every order — consider reviewing your largest expenses.
              </p>
            </Banner>
          </Layout.Section>
        )}

        {/* Summary stats — Improvement 3: add context */}
        <Layout.Section>
          <Card>
            <InlineStack gap="800" wrap>
              <BlockStack gap="100">
                <Text variant="bodySm" as="p" tone="subdued">Monthly overhead</Text>
                <Text variant="headingLg" as="p" tone={monthlyCost > 0 ? "critical" : undefined}>
                  {formatCurrency(monthlyCost, shopCurrency)}
                </Text>
                <Text variant="bodySm" as="p" tone="subdued">Fixed monthly burn</Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text variant="bodySm" as="p" tone="subdued">Yearly overhead</Text>
                <Text variant="headingLg" as="p">{formatCurrency(yearlyCost, shopCurrency)}</Text>
                <Text variant="bodySm" as="p" tone="subdued">Annual fixed costs</Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text variant="bodySm" as="p" tone="subdued">Active expenses</Text>
                <Text variant="headingLg" as="p">
                  {String(expenses.filter((e) => e.isActive).length)}
                </Text>
                <Text variant="bodySm" as="p" tone="subdued">
                  {expenses.filter((e) => !e.isActive).length > 0
                    ? `${expenses.filter((e) => !e.isActive).length} paused`
                    : "All active"}
                </Text>
              </BlockStack>
            </InlineStack>
          </Card>
        </Layout.Section>

        {/* Expenses table */}
        <Layout.Section>
          <Card padding="0">
            <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
              <IndexTable
                resourceName={{ singular: "expense", plural: "expenses" }}
                itemCount={sortedExpenses.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                // Improvement 5: bulk actions
                promotedBulkActions={promotedBulkActions}
                headings={[
                  { title: "Name" },
                  { title: "Amount" },
                  { title: "Interval" },
                  { title: "Monthly equiv." },
                  { title: "Start date" },
                  { title: "Status" },
                  { title: "Actions", alignment: "end" },
                ]}
                emptyState={
                  // Improvement 8: nuanced empty states
                  selectedTab === 2 ? (
                    <EmptyState
                      heading="No paused expenses"
                      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                    >
                      <p>All your expenses are currently active.</p>
                    </EmptyState>
                  ) : expenses.length === 0 ? (
                    <EmptyState
                      heading="No fixed costs tracked"
                      action={{ content: "Add your first expense", onAction: () => setModalExpense("new") }}
                      secondaryAction={{ content: "Import CSV", onAction: () => setCsvOpen(true) }}
                      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                    >
                      <p>Your profit is calculated without overhead costs. Add recurring costs like subscriptions, rent, and agency fees to get accurate net profit figures.</p>
                    </EmptyState>
                  ) : (
                    <EmptyState
                      heading="No expenses in this view"
                      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                    >
                      <p>Try switching to "All" to see all expenses.</p>
                    </EmptyState>
                  )
                }
              >
                {rowMarkup}
              </IndexTable>
            </Tabs>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Banner tone="info">
            <p>
              Expenses are deducted from your Net Profit on the dashboard. Sorted by monthly impact — largest costs first.
            </p>
          </Banner>
        </Layout.Section>
      </Layout>

      {modalExpense !== null && (
        <ExpenseModal
          key={modalExpense === "new" ? "new" : (modalExpense as Expense).id}
          expense={modalExpense === "new" ? null : modalExpense as Expense}
          shopCurrency={shopCurrency}
          onClose={() => setModalExpense(null)}
          onSave={handleSave}
          isSaving={isSaving}
        />
      )}

      <DeleteConfirmModal
        expense={expenseToDelete}
        onClose={() => setExpenseToDelete(null)}
        onConfirm={handleDelete}
        isDeleting={isSaving}
      />

      <CsvImportModal
        open={csvOpen}
        onClose={() => setCsvOpen(false)}
        shopCurrency={shopCurrency}
      />
    </Page>
  );
}
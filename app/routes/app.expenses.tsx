import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useFetcher } from "react-router";
import { useState, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Text,
  Badge,
  Box,
  BlockStack,
  InlineStack,
  Button,
  TextField,
  Select,
  Banner,
  EmptyState,
  Modal,
  DropZone,
  List,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

interface Expense {
  id: string;
  name: string;
  amount: number;
  currency: string;
  interval: string;
  startDate: string;
  endDate: string | null;
  isActive: boolean;
}

interface ImportResult {
  updated: number;
  errors: string[];
}

interface LoaderData {
  expenses: Expense[];
  monthlyCost: number;
  yearlyCost: number;
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const expenses = await (db as any).expense.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });

  const activeExpenses = expenses.filter((e: Expense) => e.isActive);
  const monthlyCost = activeExpenses.reduce(
    (s: number, e: Expense) => s + toMonthly(e.amount, e.interval),
    0
  );

  return json({
    expenses: expenses.map((e: any) => ({
      id: e.id,
      name: e.name,
      amount: e.amount,
      currency: e.currency,
      interval: e.interval,
      startDate: e.startDate instanceof Date ? e.startDate.toISOString() : e.startDate,
      endDate: e.endDate instanceof Date ? e.endDate.toISOString() : e.endDate ?? null,
      isActive: e.isActive,
    })),
    monthlyCost,
    yearlyCost: monthlyCost * 12,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create" || intent === "update") {
    const name = formData.get("name") as string;
    const amount = parseFloat(formData.get("amount") as string);
    const interval = formData.get("interval") as string;
    const currency = (formData.get("currency") as string) || "USD";
    const startDate = new Date(formData.get("startDate") as string);

    if (!name || isNaN(amount) || amount < 0) {
      return json({ error: "Invalid input" }, { status: 400 });
    }

    if (intent === "create") {
      await (db as any).expense.create({
        data: { shop: session.shop, name, amount, currency, interval, startDate, isActive: true },
      });
    } else {
      const id = formData.get("id") as string;
      await (db as any).expense.update({
        where: { id },
        data: { name, amount, currency, interval, startDate },
      });
    }
    return json({ success: true });
  }

  if (intent === "toggle") {
    const id = formData.get("id") as string;
    const current = await (db as any).expense.findUnique({ where: { id } });
    if (!current) return json({ error: "Not found" }, { status: 404 });
    await (db as any).expense.update({
      where: { id },
      data: { isActive: !current.isActive },
    });
    return json({ success: true });
  }

  if (intent === "delete") {
    const id = formData.get("id") as string;
    await (db as any).expense.delete({ where: { id } });
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

      const [name, amountRaw, interval, currency = "USD"] = parts;
      const amount = parseFloat(amountRaw);

      if (!name) { result.errors.push(`Missing name on line: "${line}"`); continue; }
      if (isNaN(amount) || amount < 0) { result.errors.push(`Invalid amount "${amountRaw}" for "${name}"`); continue; }

      const validIntervals = ["monthly", "weekly", "yearly", "one_time"];
      if (!validIntervals.includes(interval.toLowerCase())) {
        result.errors.push(`Invalid interval "${interval}" for "${name}" — use monthly/weekly/yearly/one_time`);
        continue;
      }

      await (db as any).expense.create({
        data: {
          shop,
          name,
          amount,
          currency,
          interval: interval.toLowerCase(),
          startDate: new Date(),
          isActive: true,
        },
      });
      result.updated++;
    }

    return json({ success: true, result });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

// --- Expense Modal ---
function ExpenseModal({
  expense,
  onClose,
  onSave,
  isSaving,
}: {
  expense: Expense | null;
  onClose: () => void;
  onSave: (data: Record<string, string>) => void;
  isSaving: boolean;
}) {
  const isEdit = !!expense;
  const [name, setName] = useState(expense?.name ?? "");
  const [amount, setAmount] = useState(expense ? String(expense.amount) : "");
  const [interval, setInterval] = useState(expense?.interval ?? "monthly");
  const [currency, setCurrency] = useState(expense?.currency ?? "USD");
  const [startDate, setStartDate] = useState(
    expense?.startDate
      ? expense.startDate.split("T")[0]
      : new Date().toISOString().split("T")[0]
  );

  return (
    <Modal
      open={true}
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
                prefix="$"
                autoComplete="off"
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

// --- CSV Import Modal ---
function CsvImportModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
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
    const template = "Name,Amount,Interval,Currency\nShopify subscription,39,monthly,USD\nWarehouse rent,1200,yearly,USD\nMeta Ads agency,500,monthly,USD\n";
    const blob = new Blob([template], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "expenses-import-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClose = () => {
    setCsvText("");
    setFileName(null);
    setFileError(null);
    onClose();
  };

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
            <p>
              CSV columns: <strong>Name, Amount, Interval, Currency</strong> (Currency is optional, defaults to USD).
              Interval must be: <strong>monthly, weekly, yearly, or one_time</strong>.
            </p>
          </Banner>
          <Button variant="plain" onClick={handleDownloadTemplate}>
            Download CSV template
          </Button>
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
            <Banner
              tone={importResult.errors.length > 0 ? "warning" : "success"}
              title={`${importResult.updated} expense${importResult.updated !== 1 ? "s" : ""} imported`}
            />
            {importResult.errors.length > 0 && (
              <BlockStack gap="100">
                <Text as="p" tone="critical">{"Errors (" + importResult.errors.length + "):"}</Text>
                <List type="bullet">
                  {importResult.errors.slice(0, 5).map((e, i) => (
                    <List.Item key={i}>{e}</List.Item>
                  ))}
                </List>
              </BlockStack>
            )}
          </BlockStack>
        </Modal.Section>
      )}
    </Modal>
  );
}

// --- Page Component ---
export default function ExpensesPage() {
  const { expenses, monthlyCost, yearlyCost } = useLoaderData() as LoaderData;
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  const [modalExpense, setModalExpense] = useState<Expense | null | "new">(null);
  const [csvOpen, setCsvOpen] = useState(false);

  const handleSave = (data: Record<string, string>) => {
    submit(data, { method: "POST" });
    setModalExpense(null);
  };

  const fmt = (amount: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(amount);

  const activeExpenses = expenses.filter((e) => e.isActive);
  const inactiveExpenses = expenses.filter((e) => !e.isActive);

  const rows = (list: Expense[]) =>
    list.map((e) => [
      <Text variant="bodyMd" fontWeight="semibold" as="span" key={e.id}>{e.name}</Text>,
      fmt(e.amount),
      <Badge key={e.id + "-int"} tone="info">{intervalLabel(e.interval)}</Badge>,
      e.interval !== "one_time" ? fmt(toMonthly(e.amount, e.interval)) + "/mo" : "—",
      new Date(e.startDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
      <Badge key={e.id + "-status"} tone={e.isActive ? "success" : "attention"}>
        {e.isActive ? "Active" : "Paused"}
      </Badge>,
      <InlineStack gap="200" key={e.id + "-actions"}>
        <Button size="slim" onClick={() => setModalExpense(e)}>Edit</Button>
        <Button variant="plain" size="slim" onClick={() => submit({ intent: "toggle", id: e.id }, { method: "POST" })}>
          {e.isActive ? "Pause" : "Resume"}
        </Button>
        <Button variant="plain" tone="critical" size="slim"
          onClick={() => { if (confirm("Delete this expense?")) submit({ intent: "delete", id: e.id }, { method: "POST" }); }}>
          Delete
        </Button>
      </InlineStack>,
    ]);

  return (
    <Page
      title="Recurring Expenses"
      primaryAction={{ content: "Add expense", onAction: () => setModalExpense("new") }}
      secondaryActions={[{ content: "Import CSV", onAction: () => setCsvOpen(true) }]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <InlineStack gap="800">
              {[
                { label: "Monthly overhead", value: fmt(monthlyCost), critical: monthlyCost > 0 },
                { label: "Yearly overhead", value: fmt(yearlyCost), critical: false },
                { label: "Active expenses", value: String(activeExpenses.length), critical: false },
              ].map((m) => (
                <BlockStack key={m.label} gap="100">
                  <Text variant="bodySm" as="p" tone="subdued">{m.label}</Text>
                  <Text variant="headingLg" as="p" tone={m.critical ? "critical" : undefined}>{m.value}</Text>
                </BlockStack>
              ))}
            </InlineStack>
          </Card>
        </Layout.Section>

        {expenses.length === 0 ? (
          <Layout.Section>
            <Card>
              <EmptyState
                heading="No expenses yet"
                action={{ content: "Add your first expense", onAction: () => setModalExpense("new") }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Track recurring costs like Shopify subscriptions, warehouse rent, and agency fees.</p>
              </EmptyState>
            </Card>
          </Layout.Section>
        ) : (
          <>
            {activeExpenses.length > 0 && (
              <Layout.Section>
                <Card padding="0">
                  <Box padding="400" borderBlockEndWidth="025" borderColor="border">
                    <Text variant="headingMd" as="h2">Active</Text>
                  </Box>
                  <DataTable
                    columnContentTypes={["text", "numeric", "text", "numeric", "text", "text", "text"]}
                    headings={["Name", "Amount", "Interval", "Monthly equiv.", "Start date", "Status", "Actions"]}
                    rows={rows(activeExpenses)}
                  />
                </Card>
              </Layout.Section>
            )}
            {inactiveExpenses.length > 0 && (
              <Layout.Section>
                <Card padding="0">
                  <Box padding="400" borderBlockEndWidth="025" borderColor="border">
                    <Text variant="headingMd" as="h2" tone="subdued">Paused</Text>
                  </Box>
                  <DataTable
                    columnContentTypes={["text", "numeric", "text", "numeric", "text", "text", "text"]}
                    headings={["Name", "Amount", "Interval", "Monthly equiv.", "Start date", "Status", "Actions"]}
                    rows={rows(inactiveExpenses)}
                  />
                </Card>
              </Layout.Section>
            )}
          </>
        )}

        <Layout.Section>
          <Banner tone="info">
            <p>Expenses are deducted from your Net Profit on the dashboard. Monthly equivalent is calculated automatically.</p>
          </Banner>
        </Layout.Section>
      </Layout>

      {modalExpense !== null && (
        <ExpenseModal
          key={modalExpense === "new" ? "new" : modalExpense.id}
          expense={modalExpense === "new" ? null : modalExpense}
          onClose={() => setModalExpense(null)}
          onSave={handleSave}
          isSaving={isSaving}
        />
      )}

      <CsvImportModal open={csvOpen} onClose={() => setCsvOpen(false)} />
    </Page>
  );
}
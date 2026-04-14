// app/routes/app.cogs.tsx
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useLoaderData, useNavigation, useSubmit, useFetcher, useSearchParams,
} from "react-router";
import { useState, useCallback, useRef, useEffect } from "react";
import {
  Page, Layout, Text, Badge, Box, BlockStack, InlineStack,
  Button, Banner, EmptyState, Modal, DropZone, List,
  Divider, IndexTable, useIndexResourceState, Filters,
  Pagination, Select, TextField,
} from "@shopify/polaris";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────
interface VariantRow {
  id: string;
  shopifyVariantId: string;
  title: string;
  sku: string | null;
  price: number | null;
  costPerItem: number | null;
  customCost: number | null;
  effectiveCost: number | null;
  productTitle: string;
  productId: string;
  shopifyProductId: string;
  [key: string]: unknown;
}

interface ImportResult {
  updated: number;
  notFound: string[];
  errors: string[];
  missingBefore: number;
  missingAfter: number;
}

interface LoaderData {
  variants: VariantRow[];
  totalVariants: number;
  missingCogsCount: number;
  cogsCoveragePercent: number;
  totalFilteredVariants: number;
  page: number;
  pageSize: number;
  totalPages: number;
  search: string;
  filter: string;
  shop: string;
}

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const filter = url.searchParams.get("filter") || "all";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSizeParam = parseInt(url.searchParams.get("pageSize") || "25", 10);
  const pageSize = [25, 50, 100].includes(pageSizeParam) ? pageSizeParam : 25;

  const variantWhere: Prisma.ProductVariantWhereInput = { product: { shop } };
  if (search) {
    variantWhere.OR = [
      { sku: { contains: search, mode: "insensitive" } },
      { product: { title: { contains: search, mode: "insensitive" } } },
    ];
  }
  if (filter === "missing") variantWhere.effectiveCost = null;

  const [totalVariants, totalFilteredVariants, allMissingCount] = await Promise.all([
    db.productVariant.count({ where: { product: { shop } } }),
    db.productVariant.count({ where: variantWhere }),
    db.productVariant.count({ where: { product: { shop }, effectiveCost: null } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalFilteredVariants / pageSize));
  const currentPage = Math.min(page, totalPages);

  const variants = await db.productVariant.findMany({
    where: variantWhere,
    select: {
      id: true, shopifyVariantId: true, title: true, sku: true,
      price: true, costPerItem: true, customCost: true, effectiveCost: true,
      product: { select: { id: true, title: true, shopifyProductId: true } },
    },
    orderBy: [{ effectiveCost: "asc" }, { product: { title: "asc" } }],
    skip: (currentPage - 1) * pageSize,
    take: pageSize,
  });

  return json({
    variants: variants.map((v) => ({
      id: v.id, shopifyVariantId: v.shopifyVariantId, title: v.title, sku: v.sku,
      price: v.price, costPerItem: v.costPerItem, customCost: v.customCost, effectiveCost: v.effectiveCost,
      productTitle: v.product.title, productId: v.product.id,
      shopifyProductId: v.product.shopifyProductId,
    })),
    totalVariants, missingCogsCount: allMissingCount,
    cogsCoveragePercent: totalVariants > 0
      ? Math.round(((totalVariants - allMissingCount) / totalVariants) * 100) : 100,
    totalFilteredVariants, page: currentPage, pageSize, totalPages, search, filter, shop,
  });
};

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "updateCost") {
    const variantId = formData.get("variantId") as string;
    const customCostRaw = formData.get("customCost") as string;
    const customCost = customCostRaw ? parseFloat(customCostRaw) : null;
    const variant = await db.productVariant.findUnique({ where: { id: variantId } });
    if (!variant) return json({ error: "Variant not found" }, { status: 404 });
    await db.productVariant.update({
      where: { id: variantId },
      data: { customCost, effectiveCost: customCost ?? variant.costPerItem ?? null },
    });
    return json({ success: true });
  }

  if (intent === "bulkUpdateCosts") {
    const variantIds = JSON.parse(formData.get("variantIds") as string) as string[];
    const customCost = parseFloat(formData.get("cost") as string);
    const onlyMissing = formData.get("onlyMissing") === "true";
    if (isNaN(customCost) || customCost < 0) return json({ error: "Invalid cost" }, { status: 400 });
    const whereClause: Prisma.ProductVariantWhereInput = { id: { in: variantIds } };
    if (onlyMissing) whereClause.effectiveCost = null;
    await db.productVariant.updateMany({ where: whereClause, data: { customCost, effectiveCost: customCost } });
    return json({ success: true });
  }

  if (intent === "bulkImport") {
    const csvData = formData.get("csvData") as string;
    const shop = formData.get("shop") as string;
    const missingBefore = await db.productVariant.count({ where: { product: { shop }, effectiveCost: null } });
    const lines = csvData.split("\n").map((l) => l.trim()).filter(Boolean);
    const dataLines = lines[0]?.toLowerCase().includes("sku") ? lines.slice(1) : lines;
    const result: ImportResult = { updated: 0, notFound: [], errors: [], missingBefore, missingAfter: 0 };
    const allVariants = await db.productVariant.findMany({
      where: { product: { shop } },
      select: { id: true, sku: true, shopifyVariantId: true },
    });
    const bySku = new Map<string, string>();
    const byVariantId = new Map<string, string>();
    for (const v of allVariants) {
      if (v.sku) bySku.set(v.sku.toLowerCase().trim(), v.id);
      const plainId = v.shopifyVariantId.replace("gid://shopify/ProductVariant/", "");
      byVariantId.set(plainId, v.id);
      byVariantId.set(v.shopifyVariantId, v.id);
    }
    const updates: { id: string; cost: number }[] = [];
    for (const line of dataLines) {
      const parts = line.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
      if (parts.length < 2) { result.errors.push(`Invalid line: "${line}"`); continue; }
      const cost = parseFloat(parts[1]);
      if (isNaN(cost) || cost < 0) { result.errors.push(`Invalid cost for "${parts[0]}"`); continue; }
      const id = bySku.get(parts[0].toLowerCase()) ?? byVariantId.get(parts[0]) ?? null;
      if (!id) { result.notFound.push(parts[0]); continue; }
      updates.push({ id, cost });
    }
    for (let i = 0; i < updates.length; i += 25) {
      await Promise.all(updates.slice(i, i + 25).map(({ id, cost }) =>
        db.productVariant.update({ where: { id }, data: { customCost: cost, effectiveCost: cost } })
      ));
      result.updated += Math.min(25, updates.length - i);
    }
    result.missingAfter = await db.productVariant.count({ where: { product: { shop }, effectiveCost: null } });
    return json({ success: true, result });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

// ── Design tokens (same as dashboard) ────────────────────────────────────────
const tokens = {
  profit: "#16a34a", profitBg: "#f0fdf4", profitBorder: "#bbf7d0",
  loss: "#dc2626", lossBg: "#fef2f2", lossBorder: "#fecaca",
  warning: "#d97706", warningBg: "#fffbeb", warningBorder: "#fde68a",
  border: "#e2e8f0", cardBg: "#ffffff",
  text: "#0f172a", textMuted: "#64748b",
};

function DCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: tokens.cardBg, border: `1px solid ${tokens.border}`, borderRadius: "12px", overflow: "hidden", ...style }}>
      {children}
    </div>
  );
}

function DBadge({ children, variant = "default", size = "md" }: {
  children: React.ReactNode;
  variant?: "default" | "success" | "danger" | "warning" | "info";
  size?: "sm" | "md";
}) {
  const colors: Record<string, { bg: string; color: string; border: string }> = {
    default: { bg: "#f1f5f9", color: "#475569", border: "#e2e8f0" },
    success: { bg: tokens.profitBg, color: tokens.profit, border: tokens.profitBorder },
    danger:  { bg: tokens.lossBg, color: tokens.loss, border: tokens.lossBorder },
    warning: { bg: tokens.warningBg, color: tokens.warning, border: tokens.warningBorder },
    info:    { bg: "#eff6ff", color: "#2563eb", border: "#bfdbfe" },
  };
  const c = colors[variant];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: size === "sm" ? "2px 8px" : "3px 10px", borderRadius: "100px",
      fontSize: size === "sm" ? "11px" : "12px", fontWeight: 600,
      background: c.bg, color: c.color, border: `1px solid ${c.border}`,
    }}>
      {children}
    </span>
  );
}

// ── Inline cost input ─────────────────────────────────────────────────────────
function InlineCostInput({ variant }: { variant: VariantRow }) {
  const fetcher = useFetcher();
  const [value, setValue] = useState(variant.customCost != null ? String(variant.customCost) : "");
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    setValue(variant.customCost != null ? String(variant.customCost) : "");
  }, [variant.customCost]);

  useEffect(() => {
    if (fetcher.state === "idle" && justSaved) {
      const t = setTimeout(() => setJustSaved(false), 2000);
      return () => clearTimeout(t);
    }
  }, [fetcher.state, justSaved]);

  const handleBlur = () => {
    const currentValue = variant.customCost != null ? String(variant.customCost) : "";
    if (value !== currentValue) {
      fetcher.submit(
        { intent: "updateCost", variantId: variant.id, customCost: value },
        { method: "POST" }
      );
      setJustSaved(true);
    }
  };

  const isSaving = fetcher.state !== "idle";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
      <div style={{ maxWidth: "120px" }}>
        <TextField
          label="Cost" labelHidden
          type="number" prefix="$"
          placeholder={variant.costPerItem != null ? `${variant.costPerItem.toFixed(2)} (from Shopify)` : "Enter cost…"}
          value={value}
          onChange={setValue}
          onBlur={handleBlur}
          autoComplete="off"
          disabled={isSaving}
          size="slim"
        />
      </div>
      {isSaving && <span style={{ fontSize: "12px", color: tokens.textMuted }}>Saving…</span>}
      {!isSaving && justSaved && <span style={{ fontSize: "12px", color: tokens.profit, fontWeight: 600 }}>✓ Saved</span>}
    </div>
  );
}

// ── Bulk cost modal ───────────────────────────────────────────────────────────
function BulkCostModal({ open, onClose, selectedCount, variantIds }: {
  open: boolean; onClose: () => void; selectedCount: number; variantIds: string[];
}) {
  const submit = useSubmit();
  const [cost, setCost] = useState("");
  const [validFrom, setValidFrom] = useState(new Date().toISOString().split("T")[0]);
  const [onlyMissing, setOnlyMissing] = useState(false);

  const handleApply = () => {
    if (!cost || isNaN(parseFloat(cost))) return;
    submit(
      { intent: "bulkUpdateCosts", variantIds: JSON.stringify(variantIds), cost, onlyMissing: String(onlyMissing) },
      { method: "POST" }
    );
    onClose(); setCost("");
  };

  return (
    <Modal
      open={open} onClose={onClose}
      title={`Set cost for ${String(selectedCount)} variant${selectedCount !== 1 ? "s" : ""}`}
      primaryAction={{ content: "Apply", onAction: handleApply, disabled: !cost }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <TextField
            label="Cost per item" type="number" prefix="$"
            value={cost} onChange={setCost} autoComplete="off" placeholder="12.50"
          />
          <TextField
            label="Valid from" type="date" value={validFrom} onChange={setValidFrom}
            autoComplete="off"
            helpText="Informational only — retroactive recalculation is a future feature."
          />
          <BlockStack gap="200">
            <Text variant="bodySm" as="p" fontWeight="semibold">Apply to:</Text>
            <InlineStack gap="300">
              <Button variant={!onlyMissing ? "primary" : "plain"} onClick={() => setOnlyMissing(false)} size="slim">
                All {String(selectedCount)} selected
              </Button>
              <Button variant={onlyMissing ? "primary" : "plain"} onClick={() => setOnlyMissing(true)} size="slim">
                Only missing COGS
              </Button>
            </InlineStack>
          </BlockStack>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ── CSV import modal ──────────────────────────────────────────────────────────
function ImportModal({ open, onClose, shop, totalVariants }: {
  open: boolean; onClose: () => void; shop: string; totalVariants: number;
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
    const blob = new Blob(["SKU or Variant ID,Cost\nMY-SKU-001,9.99\n123456789,24.50\n"], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "cogs-import-template.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleClose = () => { setCsvText(""); setFileName(null); setFileError(null); onClose(); };
  const accuracyBefore = importResult ? Math.round(((totalVariants - importResult.missingBefore) / totalVariants) * 100) : null;
  const accuracyAfter = importResult ? Math.round(((totalVariants - importResult.missingAfter) / totalVariants) * 100) : null;

  return (
    <Modal
      open={open} onClose={handleClose} title="Bulk import COGS from CSV"
      primaryAction={{
        content: "Import",
        onAction: () => fetcher.submit({ intent: "bulkImport", csvData: csvText, shop }, { method: "POST" }),
        loading: isSaving, disabled: !csvText.trim() || isSaving,
      }}
      secondaryActions={[{ content: "Close", onAction: handleClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Banner tone="info">
            <p>Two columns: <strong>SKU or Variant ID</strong> and <strong>Cost</strong>.</p>
          </Banner>
          <Button variant="plain" onClick={handleDownloadTemplate}>Download CSV template</Button>
          <Divider />
          <DropZone accept=".csv" type="file" onDrop={handleDrop} label="Upload CSV file">
            {fileName ? (
              <Box padding="400">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="p" tone="success">✓ {fileName} loaded</Text>
                  <Button variant="plain" onClick={() => { setFileName(null); setCsvText(""); }}>Remove</Button>
                </InlineStack>
              </Box>
            ) : (
              <DropZone.FileUpload actionTitle="Upload CSV" actionHint="or paste below" />
            )}
          </DropZone>
          {fileError && <Text as="p" tone="critical">{fileError}</Text>}
          <TextField
            label="Or paste CSV data directly" multiline={6}
            value={csvText}
            onChange={(val) => { setCsvText(val); setFileName(null); }}
            autoComplete="off"
            placeholder={"SKU or Variant ID,Cost\nMY-SKU-001,9.99"}
          />
        </BlockStack>
      </Modal.Section>
      {importResult && (
        <Modal.Section>
          <BlockStack gap="300">
            <Text variant="headingSm" as="h3">Import results</Text>
            <Banner
              tone={importResult.errors.length > 0 || importResult.notFound.length > 0 ? "warning" : "success"}
              title={`${importResult.updated} variant${importResult.updated !== 1 ? "s" : ""} updated`}
            >
              {accuracyBefore !== null && accuracyAfter !== null && accuracyAfter > accuracyBefore && (
                <BlockStack gap="100">
                  <Text as="p">{`Missing COGS: ${importResult.missingBefore} → ${importResult.missingAfter}`}</Text>
                  <Text as="p">{`Profit accuracy: ${accuracyBefore}% → ${accuracyAfter}%`}</Text>
                </BlockStack>
              )}
            </Banner>
            {importResult.notFound.length > 0 && (
              <BlockStack gap="100">
                <Text as="p" tone="caution">{`Not found (${importResult.notFound.length}):`}</Text>
                <List type="bullet">
                  {importResult.notFound.slice(0, 10).map((id) => <List.Item key={id}>{id}</List.Item>)}
                  {importResult.notFound.length > 10 && <List.Item>{`…and ${importResult.notFound.length - 10} more`}</List.Item>}
                </List>
              </BlockStack>
            )}
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
export default function CogsPage() {
  const {
    variants, totalVariants, missingCogsCount, cogsCoveragePercent,
    totalFilteredVariants, page, pageSize, totalPages, search, filter, shop,
  } = useLoaderData() as LoaderData;

  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [searchValue, setSearchValue] = useState(search);
  const [importOpen, setImportOpen] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const isLoading = navigation.state === "loading";

  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(variants);

  const updateParam = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value && value !== "all") next.set(key, value); else next.delete(key);
    if (key !== "page") next.set("page", "1");
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchValue(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => updateParam("search", value), 500);
  }, [updateParam]);

  const coverageIsHealthy = cogsCoveragePercent >= 95;
  const getShopifyProductUrl = (shopifyProductId: string) =>
    `https://${shop}/admin/products/${shopifyProductId.replace("gid://shopify/Product/", "")}`;

  const appliedFilters = filter === "missing" ? [{
    key: "filter", label: "Missing COGS only",
    onRemove: () => updateParam("filter", "all"),
  }] : [];

  const promotedBulkActions = [{
    content: `Set cost for ${selectedResources.length} variant${selectedResources.length !== 1 ? "s" : ""}`,
    onAction: () => setBulkModalOpen(true),
  }];

  const rowMarkup = variants.map((variant, index) => (
    <IndexTable.Row
      id={variant.id} key={variant.id}
      selected={selectedResources.includes(variant.id)}
      position={index}
      tone={variant.effectiveCost === null ? "critical" : undefined}
    >
      <IndexTable.Cell>
        <a
          href={getShopifyProductUrl(variant.shopifyProductId)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ fontSize: "13px", fontWeight: 600, color: "#2563eb", textDecoration: "none" }}
          onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
          onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
        >
          {variant.productTitle} ↗
        </a>
        {variant.title !== "Default Title" && (
          <p style={{ margin: "2px 0 0", fontSize: "12px", color: tokens.textMuted }}>{variant.title}</p>
        )}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <span style={{ fontSize: "13px", color: tokens.textMuted, fontFamily: "monospace" }}>
          {variant.sku || "—"}
        </span>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {variant.price != null
          ? <span style={{ fontSize: "13px", color: tokens.text }}>${variant.price.toFixed(2)}</span>
          : <span style={{ fontSize: "13px", color: tokens.textMuted }}>—</span>}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {variant.costPerItem != null
          ? <span style={{ fontSize: "13px", color: tokens.textMuted, fontStyle: "italic" }}>${variant.costPerItem.toFixed(2)}</span>
          : (
          <span
            title="No cost per item set in Shopify. Go to Shopify Admin → Products → variant → Cost per item, or enter your cost in the 'Your Cost' column."
            style={{ fontSize: "13px", color: tokens.textMuted, cursor: "help" }}
          >—</span>
        )}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineCostInput variant={variant} />
      </IndexTable.Cell>
      <IndexTable.Cell>
        {variant.effectiveCost != null
          ? <span style={{ fontSize: "14px", fontWeight: 700, color: tokens.text }}>${variant.effectiveCost.toFixed(2)}</span>
          : <DBadge variant="danger" size="sm">Missing</DBadge>}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {(() => {
          if (variant.price == null || variant.effectiveCost == null) return <span style={{ color: tokens.textMuted }}>—</span>;
          const margin = ((variant.price - variant.effectiveCost) / variant.price) * 100;
          const color = margin >= 40 ? tokens.profit : margin >= 20 ? "#D97706" : tokens.loss;
          return (
            <span style={{ fontSize: "13px", fontWeight: 600, color }}>
              {margin.toFixed(1)}%
            </span>
          );
        })()}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <>
    <style>{`
      /* Prevent Polaris bulk action bar from covering summary cards */
      .Polaris-IndexTable__BulkActionsWrapper { position: relative !important; }
      /* Gray background on read-only columns (Sell Price, From Shopify, Cost Used, Margin) */
      .Polaris-IndexTable__Table td:nth-child(4),
      .Polaris-IndexTable__Table td:nth-child(5),
      .Polaris-IndexTable__Table td:nth-child(7),
      .Polaris-IndexTable__Table td:nth-child(8) {
        background-color: #F8FAFC !important;
      }
      /* Subtle hover on editable column */
      .Polaris-IndexTable__Table td:nth-child(6):hover {
        background-color: #EFF6FF !important;
      }
    `}</style>
    <Page
      title="Product Cost Prices"
      backAction={{ content: "Settings", url: "/app/settings" }}
      primaryAction={{ content: "Import CSV", onAction: () => setImportOpen(true) }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

        {/* ── Page intro ──────────────────────────────────────────────── */}
        <div style={{
          padding: "16px 20px", borderRadius: "10px",
          background: "#EFF6FF", border: "1px solid #BFDBFE",
          display: "flex", gap: "16px", alignItems: "flex-start",
        }}>
          <span style={{ fontSize: "20px", flexShrink: 0, marginTop: "1px" }}>💡</span>
          <div>
            <p style={{ margin: "0 0 4px", fontSize: "14px", fontWeight: 700, color: "#1E3A8A" }}>
              Set your cost prices here so ClearProfit can calculate accurate profit
            </p>
            <p style={{ margin: "0 0 10px", fontSize: "13px", color: "#1E40AF", lineHeight: "1.5" }}>
              We automatically sync the cost per item you set in Shopify. If your real cost is different
              (e.g. you include packaging or import duties), enter it in the <strong>Your Cost</strong> column — it overrides the Shopify value.
              The <strong>Cost Used</strong> column always shows which value ClearProfit actually deducts from profit.
            </p>
            <details style={{ cursor: "pointer" }}>
              <summary style={{ fontSize: "12px", fontWeight: 600, color: "#2563EB", userSelect: "none", listStyle: "none", display: "flex", alignItems: "center", gap: "4px" }}>
                <span>▶ How does cost syncing work?</span>
              </summary>
              <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
                {[
                  ["🔵 Shopify cost", "Set in Shopify Admin → Products → variant → Cost per item. Synced automatically. Read-only here."],
                  ["✏️ Your Cost", "Enter here when your real cost differs — includes packaging, duties, storage. This overrides the Shopify value."],
                  ["✅ Cost Used", "The value ClearProfit uses in profit calculations. Priority: Your Cost → Shopify cost → (missing)."],
                  ["📊 Margin", "Gross margin based on selling price vs cost. Before transaction fees and ad spend."],
                ].map(([label, desc]) => (
                  <div key={label as string} style={{ display: "flex", gap: "8px", fontSize: "12px", color: "#1E40AF" }}>
                    <span style={{ fontWeight: 700, flexShrink: 0, minWidth: "110px" }}>{label as string}</span>
                    <span style={{ opacity: 0.85 }}>{desc as string}</span>
                  </div>
                ))}
              </div>
            </details>
          </div>
        </div>

        {/* Coverage summary — kept outside IndexTable scroll context so bulk action bar doesn't cover it */}
        <div id="cogs-summary">
        <DCard>
          <div style={{ padding: "20px 24px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr", gap: "32px", alignItems: "start" }}>
              {/* Total variants */}
              <div>
                <p style={{ margin: "0 0 4px", fontSize: "12px", fontWeight: 500, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Total variants</p>
                <p style={{ margin: 0, fontSize: "28px", fontWeight: 700, color: tokens.text, letterSpacing: "-0.02em" }}>{totalVariants}</p>
              </div>
              {/* Missing */}
              <div>
                <p style={{ margin: "0 0 4px", fontSize: "12px", fontWeight: 500, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Missing cost data</p>
                <p style={{ margin: 0, fontSize: "28px", fontWeight: 700, letterSpacing: "-0.02em", color: missingCogsCount > 0 ? tokens.loss : tokens.profit }}>
                  {missingCogsCount}
                </p>
              </div>
              {/* Coverage bar */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                  <p style={{ margin: 0, fontSize: "12px", fontWeight: 500, color: tokens.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>COGS coverage</p>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <p style={{ margin: 0, fontSize: "22px", fontWeight: 700, color: coverageIsHealthy ? tokens.profit : tokens.loss, letterSpacing: "-0.02em" }}>
                      {cogsCoveragePercent}%
                    </p>
                    <DBadge variant={coverageIsHealthy ? "success" : "danger"} size="sm">
                      {coverageIsHealthy ? "Healthy" : "Incomplete"}
                    </DBadge>
                  </div>
                </div>
                <div style={{ height: "8px", borderRadius: "4px", background: "#e2e8f0", overflow: "hidden" }}>
                  <div style={{
                    height: "100%", width: `${cogsCoveragePercent}%`,
                    background: coverageIsHealthy ? tokens.profit : tokens.loss,
                    borderRadius: "4px", transition: "width 0.4s ease",
                  }} />
                </div>
                <p style={{ margin: "4px 0 0", fontSize: "12px", color: tokens.textMuted }}>Target: 95%+</p>
              </div>
            </div>
          </div>
        </DCard>
        </div>

        {/* Alert bar when missing */}
        {missingCogsCount > 0 && (
          <div style={{
            padding: "14px 20px", borderRadius: "10px",
            background: tokens.lossBg, border: `1px solid ${tokens.lossBorder}`,
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px",
          }}>
            <div>
              <p style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: tokens.loss }}>
                {missingCogsCount} variant{missingCogsCount !== 1 ? "s" : ""} missing cost data
              </p>
              <p style={{ margin: "2px 0 0", fontSize: "13px", color: tokens.loss, opacity: 0.8 }}>
                Profit is overstated until this is fixed
              </p>
            </div>
            {/* Quiet segmented filter toggle */}
            <div style={{ display: "flex", borderRadius: "8px", border: `1px solid ${tokens.border}`, overflow: "hidden", flexShrink: 0 }}>
              <button
                onClick={() => updateParam("filter", "all")}
                style={{ padding: "6px 14px", background: filter !== "missing" ? tokens.text : "#f8fafc", color: filter !== "missing" ? "#fff" : tokens.textMuted, border: "none", cursor: "pointer", fontSize: "12px", fontWeight: 600, borderRight: `1px solid ${tokens.border}` }}
              >All</button>
              <button
                onClick={() => updateParam("filter", "missing")}
                style={{ padding: "6px 14px", background: filter === "missing" ? tokens.loss : "#f8fafc", color: filter === "missing" ? "#fff" : tokens.textMuted, border: "none", cursor: "pointer", fontSize: "12px", fontWeight: 600 }}
              >Missing only</button>
            </div>
          </div>
        )}

        {/* Table */}
        <DCard>
          {filter === "missing" && (
            <div style={{ padding: "8px 16px", borderBottom: `1px solid ${tokens.border}`, background: tokens.warningBg }}>
              <span style={{ fontSize: "12px", color: tokens.warning, fontWeight: 500 }}>⚠ Filtered: showing missing COGS only</span>
            </div>
          )}

          <div style={{ padding: "16px" }}>
            <Filters
              queryValue={searchValue}
              filters={[]}
              appliedFilters={appliedFilters}
              onQueryChange={handleSearchChange}
              onQueryClear={() => handleSearchChange("")}
              onClearAll={() => { updateParam("filter", "all"); setSearchValue(""); }}
              queryPlaceholder="Search by product name or SKU…"
            />
          </div>

          {/* Column legend */}
          <div style={{ padding: "8px 16px 6px", display: "flex", gap: "16px", alignItems: "center", borderBottom: `1px solid ${tokens.border}` }}>
            <span style={{ fontSize: "11px", color: tokens.textMuted, display: "flex", alignItems: "center", gap: "4px" }}>
              <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", background: "#F8FAFC", border: "1px solid #E2E8F0" }} />
              🔒 Auto-synced from Shopify — read-only
            </span>
            <span style={{ fontSize: "11px", color: tokens.textMuted }}>·</span>
            <span style={{ fontSize: "11px", color: tokens.textMuted, display: "flex", alignItems: "center", gap: "4px" }}>
              <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", background: "#FFFFFF", border: "1px solid #E2E8F0" }} />
              ✏️ Your Cost — enter your value here
            </span>
          </div>

          <div style={{ opacity: isLoading ? 0.6 : 1, transition: "opacity 0.2s" }}>
            <IndexTable
              resourceName={{ singular: "variant", plural: "variants" }}
              itemCount={variants.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              promotedBulkActions={promotedBulkActions}
              headings={[
                { title: "Product & Variant" },
                { title: "SKU" },
                { title: "Sell Price 🔒" },
                { title: "From Shopify 🔒" },
                { title: "Your Cost ✏️" },
                { title: "Cost Used 🔒" },
                { title: "Margin 🔒" },
              ]}
              emptyState={
                filter === "missing" && missingCogsCount === 0 ? (
                  <EmptyState
                    heading="All product costs are complete 🎉"
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <p>Your profit calculations are fully accurate.</p>
                  </EmptyState>
                ) : (
                  <EmptyState
                    heading="No products match"
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <p>Try adjusting your filters.</p>
                  </EmptyState>
                )
              }
            >
              {rowMarkup}
            </IndexTable>
          </div>

          {/* Pagination footer */}
          <div style={{
            padding: "12px 16px", borderTop: `1px solid ${tokens.border}`,
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <Select
              label="Per page" labelInline
              options={[{ label: "25", value: "25" }, { label: "50", value: "50" }, { label: "100", value: "100" }]}
              value={String(pageSize)}
              onChange={(val) => updateParam("pageSize", val)}
            />
            {totalPages > 1 && (
              <Pagination
                hasPrevious={page > 1}
                onPrevious={() => updateParam("page", String(page - 1))}
                hasNext={page < totalPages}
                onNext={() => updateParam("page", String(page + 1))}
                label={`Page ${page} of ${totalPages} · ${totalFilteredVariants} variants`}
              />
            )}
          </div>
        </DCard>

      </div>

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} shop={shop} totalVariants={totalVariants} />
      <BulkCostModal
        open={bulkModalOpen}
        onClose={() => { setBulkModalOpen(false); clearSelection(); }}
        selectedCount={selectedResources.length}
        variantIds={selectedResources}
      />
    </Page>
    </>
  );
}
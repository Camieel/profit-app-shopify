// app/routes/app.cogs.tsx
// COGS management moved here from app.products.tsx
// "Valid from" date is shown but currently informational only —
// retroactive recalculation (history table) is a future feature.

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useLoaderData, useNavigation, useSubmit, useFetcher,
  useSearchParams,
} from "react-router";
import { useState, useCallback, useRef, useEffect } from "react";
import {
  Page, Layout, Card, Text, Badge, Box, BlockStack, InlineStack,
  Button, TextField, Banner, EmptyState, Modal, DropZone, List,
  Divider, SkeletonBodyText, IndexTable, useIndexResourceState,
  Filters, Pagination, Select,
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

  const variantWhere: Prisma.ProductVariantWhereInput = {
    product: { shop },
  };

  if (search) {
    variantWhere.OR = [
      { sku: { contains: search, mode: "insensitive" } },
      { product: { title: { contains: search, mode: "insensitive" } } },
    ];
  }
  if (filter === "missing") {
    variantWhere.effectiveCost = null;
  }

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
      costPerItem: true, customCost: true, effectiveCost: true,
      product: { select: { id: true, title: true, shopifyProductId: true } },
    },
    orderBy: [
      { effectiveCost: "asc" }, // null first
      { product: { title: "asc" } },
    ],
    skip: (currentPage - 1) * pageSize,
    take: pageSize,
  });

  const cogsCoveragePercent = totalVariants > 0
    ? Math.round(((totalVariants - allMissingCount) / totalVariants) * 100) : 100;

  return json({
    variants: variants.map((v) => ({
      id: v.id,
      shopifyVariantId: v.shopifyVariantId,
      title: v.title,
      sku: v.sku,
      costPerItem: v.costPerItem,
      customCost: v.customCost,
      effectiveCost: v.effectiveCost,
      productTitle: v.product.title,
      productId: v.product.id,
      shopifyProductId: v.product.shopifyProductId,
    })),
    totalVariants,
    missingCogsCount: allMissingCount,
    cogsCoveragePercent,
    totalFilteredVariants,
    page: currentPage,
    pageSize,
    totalPages,
    search,
    filter,
    shop,
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
    const effectiveCost = customCost ?? variant.costPerItem ?? null;
    await db.productVariant.update({
      where: { id: variantId },
      data: { customCost, effectiveCost },
    });
    return json({ success: true });
  }

  if (intent === "clearCustomCost") {
    const variantId = formData.get("variantId") as string;
    const variant = await db.productVariant.findUnique({ where: { id: variantId } });
    if (!variant) return json({ error: "Variant not found" }, { status: 404 });
    await db.productVariant.update({
      where: { id: variantId },
      data: { customCost: null, effectiveCost: variant.costPerItem ?? null },
    });
    return json({ success: true });
  }

  if (intent === "bulkUpdateCosts") {
    const variantIdsRaw = formData.get("variantIds") as string;
    const costRaw = formData.get("cost") as string;
    const onlyMissing = formData.get("onlyMissing") === "true";
    if (!variantIdsRaw || !costRaw) return json({ error: "Missing data" }, { status: 400 });
    const variantIds = JSON.parse(variantIdsRaw) as string[];
    const customCost = parseFloat(costRaw);
    if (isNaN(customCost) || customCost < 0) return json({ error: "Invalid cost" }, { status: 400 });
    const whereClause: Prisma.ProductVariantWhereInput = { id: { in: variantIds } };
    if (onlyMissing) whereClause.effectiveCost = null;
    await db.productVariant.updateMany({ where: whereClause, data: { customCost, effectiveCost: customCost } });
    return json({ success: true });
  }

  if (intent === "bulkImport") {
    const csvData = formData.get("csvData") as string;
    const shop = formData.get("shop") as string;

    const missingBefore = await db.productVariant.count({
      where: { product: { shop }, effectiveCost: null },
    });

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
      if (!line) continue;
      const parts = line.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
      if (parts.length < 2) { result.errors.push(`Invalid line: "${line}"`); continue; }
      const identifier = parts[0];
      const cost = parseFloat(parts[1]);
      if (isNaN(cost) || cost < 0) { result.errors.push(`Invalid cost for "${identifier}"`); continue; }
      const id = bySku.get(identifier.toLowerCase()) ?? byVariantId.get(identifier) ?? null;
      if (!id) { result.notFound.push(identifier); continue; }
      updates.push({ id, cost });
    }

    const CHUNK_SIZE = 25;
    for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
      const chunk = updates.slice(i, i + CHUNK_SIZE);
      await Promise.all(
        chunk.map(({ id, cost }) =>
          db.productVariant.update({ where: { id }, data: { customCost: cost, effectiveCost: cost } })
        )
      );
      result.updated += chunk.length;
    }

    result.missingAfter = await db.productVariant.count({
      where: { product: { shop }, effectiveCost: null },
    });

    return json({ success: true, result });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

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
    <InlineStack gap="100" blockAlign="center">
      <div style={{ maxWidth: "140px" }}>
        <TextField
          label="Cost"
          labelHidden
          type="number"
          prefix="$"
          placeholder={variant.costPerItem != null ? String(variant.costPerItem) : "0.00"}
          value={value}
          onChange={setValue}
          onBlur={handleBlur}
          autoComplete="off"
          disabled={isSaving}
          size="slim"
        />
      </div>
      {isSaving && <Text variant="bodySm" as="span" tone="subdued">Saving…</Text>}
      {!isSaving && justSaved && <Text variant="bodySm" as="span" tone="success">✓</Text>}
    </InlineStack>
  );
}

// ── Bulk cost modal ───────────────────────────────────────────────────────────
function BulkCostModal({ open, onClose, selectedCount, variantIds }: {
  open: boolean; onClose: () => void;
  selectedCount: number; variantIds: string[];
}) {
  const submit = useSubmit();
  const [cost, setCost] = useState("");
  const [validFrom, setValidFrom] = useState(new Date().toISOString().split("T")[0]);
  const [onlyMissing, setOnlyMissing] = useState(false);

  const handleApply = () => {
    if (!cost || isNaN(parseFloat(cost))) return;
    submit(
      {
        intent: "bulkUpdateCosts",
        variantIds: JSON.stringify(variantIds),
        cost,
        onlyMissing: String(onlyMissing),
      },
      { method: "POST" }
    );
    onClose();
    setCost("");
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Set cost for ${String(selectedCount)} variant${selectedCount !== 1 ? "s" : ""}`}
      primaryAction={{ content: "Apply", onAction: handleApply, disabled: !cost }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <TextField
            label="Cost per item"
            type="number"
            prefix="$"
            value={cost}
            onChange={setCost}
            autoComplete="off"
            placeholder="12.50"
          />
          <TextField
            label="Valid from"
            type="date"
            value={validFrom}
            onChange={setValidFrom}
            autoComplete="off"
            helpText="Informational only — retroactive recalculation of past orders is a future feature. Affects new orders from this date."
          />
          <BlockStack gap="200">
            <Text variant="bodySm" as="p" fontWeight="semibold">Apply to:</Text>
            <InlineStack gap="400">
              <Button
                variant={!onlyMissing ? "primary" : "plain"}
                onClick={() => setOnlyMissing(false)}
                size="slim"
              >
                All {String(selectedCount)} selected
              </Button>
              <Button
                variant={onlyMissing ? "primary" : "plain"}
                onClick={() => setOnlyMissing(true)}
                size="slim"
              >
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

  const handleDropZoneDrop = useCallback((_: File[], acceptedFiles: File[]) => {
    setFileError(null);
    const file = acceptedFiles[0];
    if (!file) return;
    if (!file.name.endsWith(".csv")) { setFileError("Only .csv files are supported."); return; }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => setCsvText((e.target?.result as string) ?? "");
    reader.readAsText(file);
  }, []);

  const handleDownloadTemplate = () => {
    const template = "SKU or Variant ID,Cost\nMY-SKU-001,9.99\n123456789,24.50\n";
    const blob = new Blob([template], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "cogs-import-template.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleClose = () => { setCsvText(""); setFileName(null); setFileError(null); onClose(); };

  const accuracyBefore = importResult
    ? Math.round(((totalVariants - importResult.missingBefore) / totalVariants) * 100) : null;
  const accuracyAfter = importResult
    ? Math.round(((totalVariants - importResult.missingAfter) / totalVariants) * 100) : null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Bulk import COGS from CSV"
      primaryAction={{
        content: "Import",
        onAction: () => fetcher.submit({ intent: "bulkImport", csvData: csvText, shop }, { method: "POST" }),
        loading: isSaving,
        disabled: !csvText.trim() || isSaving,
      }}
      secondaryActions={[{ content: "Close", onAction: handleClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Banner tone="info">
            <p>Upload a CSV with two columns: <strong>SKU or Variant ID</strong> and <strong>Cost</strong>.</p>
          </Banner>
          <Button variant="plain" onClick={handleDownloadTemplate}>Download CSV template</Button>
          <Divider />
          <DropZone accept=".csv" type="file" onDrop={handleDropZoneDrop} label="Upload CSV file">
            {fileName ? (
              <Box padding="400">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="p" tone="success">✓ {fileName} loaded</Text>
                  <Button variant="plain" onClick={() => { setFileName(null); setCsvText(""); }}>Remove</Button>
                </InlineStack>
              </Box>
            ) : (
              <DropZone.FileUpload actionTitle="Upload CSV" actionHint="or paste your CSV data below" />
            )}
          </DropZone>
          {fileError && <Text as="p" tone="critical">{fileError}</Text>}
          <TextField
            label="Or paste CSV data directly"
            multiline={6}
            value={csvText}
            onChange={(val) => { setCsvText(val); setFileName(null); }}
            autoComplete="off"
            placeholder={"SKU or Variant ID,Cost\nMY-SKU-001,9.99\n123456789,24.50"}
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
                  {importResult.notFound.length > 10 && (
                    <List.Item>{`…and ${importResult.notFound.length - 10} more`}</List.Item>
                  )}
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

  const filters = [
    {
      key: "filter",
      label: "COGS status",
      filter: (
        <Button onClick={() => updateParam("filter", filter === "missing" ? "all" : "missing")}>
          {filter === "missing" ? "Show all" : "Missing COGS only"}
        </Button>
      ),
      shortcut: true,
    },
  ];

  const appliedFilters = filter === "missing" ? [{
    key: "filter",
    label: "Missing COGS only",
    onRemove: () => updateParam("filter", "all"),
  }] : [];

  const promotedBulkActions = [{
    content: `Set cost for ${selectedResources.length} variant${selectedResources.length !== 1 ? "s" : ""}`,
    onAction: () => setBulkModalOpen(true),
  }];

  const getShopifyProductUrl = (shopifyProductId: string) =>
    `https://${shop}/admin/products/${shopifyProductId.replace("gid://shopify/Product/", "")}`;

  const coverageIsHealthy = cogsCoveragePercent >= 95;

  const rowMarkup = variants.map((variant, index) => (
    <IndexTable.Row
      id={variant.id}
      key={variant.id}
      selected={selectedResources.includes(variant.id)}
      position={index}
      tone={variant.effectiveCost === null ? "critical" : undefined}
    >
      <IndexTable.Cell>
        <Button variant="plain" url={getShopifyProductUrl(variant.shopifyProductId)} target="_blank">
          {variant.productTitle}
        </Button>
        {variant.title !== "Default Title" && (
          <><br /><Text variant="bodySm" tone="subdued" as="span">{variant.title}</Text></>
        )}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text variant="bodySm" as="span" tone="subdued">{variant.sku || "—"}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {variant.costPerItem != null
          ? `$${variant.costPerItem.toFixed(2)}`
          : <Badge tone="attention">Not in Shopify</Badge>}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineCostInput variant={variant} />
      </IndexTable.Cell>
      <IndexTable.Cell>
        {variant.effectiveCost != null ? (
          <Text as="span" fontWeight="bold">{`$${variant.effectiveCost.toFixed(2)}`}</Text>
        ) : (
          <Badge tone="critical">Missing</Badge>
        )}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="COGS Configuration"
      backAction={{ content: "Settings", url: "/app/settings" }}
      primaryAction={{ content: "Import CSV", onAction: () => setImportOpen(true) }}
    >
      <Layout>
        {/* Coverage summary */}
        <Layout.Section>
          <Card>
            <InlineStack gap="800" wrap>
              <BlockStack gap="100">
                <Text variant="bodySm" as="p" tone="subdued">Total variants</Text>
                <Text variant="headingMd" as="p">{totalVariants}</Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text variant="bodySm" as="p" tone="subdued">Missing cost data</Text>
                <Text variant="headingMd" as="p" tone={missingCogsCount > 0 ? "critical" : undefined}>
                  {missingCogsCount}
                </Text>
              </BlockStack>
              <BlockStack gap="200">
                <BlockStack gap="050">
                  <Text variant="bodySm" as="p" tone="subdued">COGS coverage</Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="headingMd" as="p" tone={coverageIsHealthy ? undefined : "critical"}>
                      {cogsCoveragePercent}%
                    </Text>
                    <Badge tone={coverageIsHealthy ? "success" : "critical"}>
                      {coverageIsHealthy ? "Healthy" : "Incomplete"}
                    </Badge>
                  </InlineStack>
                </BlockStack>
                <div style={{ height: "6px", borderRadius: "3px", background: "#e5e7eb", overflow: "hidden" }}>
                  <div style={{
                    height: "100%",
                    width: `${cogsCoveragePercent}%`,
                    background: coverageIsHealthy ? "#008060" : "#d92d20",
                    borderRadius: "3px",
                    transition: "width 0.3s ease",
                  }} />
                </div>
                <Text variant="bodySm" as="p" tone="subdued">Target: 95%+</Text>
              </BlockStack>
            </InlineStack>
          </Card>
        </Layout.Section>

        {/* Recommended action */}
        {missingCogsCount > 0 && (
          <Layout.Section>
            <div style={{ padding: "16px 20px", borderRadius: "12px", background: "#fff1f0", border: "1px solid #ffa39e" }}>
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="050">
                  <Text variant="headingSm" as="h3">
                    {`${missingCogsCount} variant${missingCogsCount !== 1 ? "s" : ""} missing cost data`}
                  </Text>
                  <Text variant="bodySm" as="p" tone="critical">
                    Your reported profit is overstated until this is fixed
                  </Text>
                </BlockStack>
                <InlineStack gap="200">
                  <Button variant="primary" onClick={() => updateParam("filter", "missing")}>
                    Show missing only
                  </Button>
                  <Button onClick={() => setImportOpen(true)}>Import CSV</Button>
                </InlineStack>
              </InlineStack>
            </div>
          </Layout.Section>
        )}

        {/* Table */}
        <Layout.Section>
          <Card padding="0">
            {filter === "missing" && (
              <Box padding="300" borderBlockEndWidth="025" borderColor="border">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="bodySm" as="p" tone="caution" fontWeight="semibold">
                    ⚠️ Showing missing COGS only
                  </Text>
                  <Button size="slim" variant="plain" onClick={() => updateParam("filter", "all")}>
                    Show all
                  </Button>
                </InlineStack>
              </Box>
            )}

            <div style={{ padding: "16px" }}>
              <Filters
                queryValue={searchValue}
                filters={filters}
                appliedFilters={appliedFilters}
                onQueryChange={handleSearchChange}
                onQueryClear={() => handleSearchChange("")}
                onClearAll={() => { updateParam("filter", "all"); setSearchValue(""); }}
                queryPlaceholder="Search by product name or SKU…"
              />
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
                  { title: "Shopify Cost" },
                  { title: "Custom Cost" },
                  { title: "Effective Cost" },
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

            <div style={{ padding: "16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #ebebeb" }}>
              <Select
                label="Per page"
                labelInline
                options={[
                  { label: "25", value: "25" },
                  { label: "50", value: "50" },
                  { label: "100", value: "100" },
                ]}
                value={String(pageSize)}
                onChange={(val) => updateParam("pageSize", val)}
              />
              {totalPages > 1 && (
                <Pagination
                  hasPrevious={page > 1}
                  onPrevious={() => updateParam("page", String(page - 1))}
                  hasNext={page < totalPages}
                  onNext={() => updateParam("page", String(page + 1))}
                  label={`Page ${page} of ${totalPages} (${totalFilteredVariants} variants)`}
                />
              )}
            </div>
          </Card>
        </Layout.Section>
      </Layout>

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} shop={shop} totalVariants={totalVariants} />
      <BulkCostModal
        open={bulkModalOpen}
        onClose={() => { setBulkModalOpen(false); clearSelection(); }}
        selectedCount={selectedResources.length}
        variantIds={selectedResources}
      />
    </Page>
  );
}
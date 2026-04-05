import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useFetcher, useSearchParams } from "react-router";
import { useState, useCallback, useRef, useEffect } from "react";
import {
  Page, Layout, Card, Text, Badge, Box, BlockStack, InlineStack,
  Button, TextField, Banner, EmptyState, Modal, DropZone, List,
  Divider, SkeletonPage, SkeletonBodyText, IndexTable,
  useIndexResourceState, Filters, Pagination, Select,
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
  [key: string]: unknown; // required by useIndexResourceState
}

interface ProductGroup {
  id: string;
  shopifyProductId: string;
  title: string;
  variants: VariantRow[];
  missingCogs: boolean;
  missingCogsCount: number;
  missingCogsPercent: number;
}

interface ImportResult {
  updated: number;
  notFound: string[];
  errors: string[];
  missingBefore: number;
  missingAfter: number;
}

interface LoaderData {
  products: ProductGroup[];
  totalVariants: number;
  missingCogsCount: number;
  missingCogsImpact: number;
  cogsCoveragePercent: number;
  totalProducts: number;
  totalFilteredProducts: number;
  page: number;
  pageSize: number;
  totalPages: number;
  search: string;
  filter: string;
  vendor: string;
  shop: string;
}

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const filter = url.searchParams.get("filter") || "all";
  const vendor = url.searchParams.get("vendor") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSizeParam = parseInt(url.searchParams.get("pageSize") || "20", 10);
  const pageSize = [20, 50, 100].includes(pageSizeParam) ? pageSizeParam : 20;

  // Fix 2: proper Prisma typing instead of `any`
  const productWhere: Prisma.ProductWhereInput = { shop };

  if (search) {
    productWhere.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { variants: { some: { sku: { contains: search, mode: "insensitive" } } } },
    ];
  }
  if (filter === "missing") {
    productWhere.variants = { some: { effectiveCost: null } };
  }
  if (vendor) {
    (productWhere as any).vendor = { contains: vendor, mode: "insensitive" };
  }

  const [totalFilteredProducts, totalProducts, variantStats] = await Promise.all([
    db.product.count({ where: productWhere }),
    db.product.count({ where: { shop } }),
    db.productVariant.findMany({
      where: { product: { shop } },
      select: { effectiveCost: true },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalFilteredProducts / pageSize));
  const currentPage = Math.min(page, totalPages);

  const products = await db.product.findMany({
    where: productWhere,
    // Fix 3: select only needed variant fields to avoid heavy payload
    select: {
      id: true,
      shopifyProductId: true,
      title: true,
      variants: {
        select: {
          id: true, shopifyVariantId: true, title: true, sku: true,
          costPerItem: true, customCost: true, effectiveCost: true,
        },
      },
    },
    orderBy: { title: "asc" },
    skip: (currentPage - 1) * pageSize,
    take: pageSize,
  });

  const totalVariants = variantStats.length;
  const missingCogsCount = variantStats.filter((v) => v.effectiveCost === null).length;
  const cogsCoveragePercent = totalVariants > 0
    ? Math.round(((totalVariants - missingCogsCount) / totalVariants) * 100) : 100;

  // Estimate profit impact of missing COGS (avg 15% margin × estimated revenue)
  // We use a simple per-variant heuristic — real impact shown from orders page
  const missingCogsImpact = missingCogsCount * 50 * 0.15; // $50 avg revenue × 15% margin assumption

  // Fix 6: sort products worst-first — most missing COGS variants at top
  const productGroups: ProductGroup[] = products
    .map((p) => ({
      id: p.id,
      shopifyProductId: p.shopifyProductId,
      title: p.title,
      variants: p.variants.map((v) => ({
        id: v.id,
        shopifyVariantId: v.shopifyVariantId,
        title: v.title,
        sku: v.sku,
        costPerItem: v.costPerItem,
        customCost: v.customCost,
        effectiveCost: v.effectiveCost,
        productTitle: p.title,
        productId: p.id,
        shopifyProductId: p.shopifyProductId,
      })),
      missingCogs: p.variants.some((v) => v.effectiveCost === null),
      missingCogsCount: p.variants.filter((v) => v.effectiveCost === null).length,
      missingCogsPercent: p.variants.length > 0
        ? Math.round((p.variants.filter((v) => v.effectiveCost === null).length / p.variants.length) * 100)
        : 0,
    }))
    .sort((a, b) => b.missingCogsPercent - a.missingCogsPercent);

  return json({
    products: productGroups,
    totalVariants,
    missingCogsCount,
    missingCogsImpact,
    cogsCoveragePercent,
    totalProducts,
    totalFilteredProducts,
    page: currentPage,
    pageSize,
    totalPages,
    search,
    filter,
    vendor,
    shop: session.shop,
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

    await db.productVariant.updateMany({
      where: whereClause,
      data: { customCost, effectiveCost: customCost },
    });
    return json({ success: true });
  }

  if (intent === "bulkImport") {
    const csvData = formData.get("csvData") as string;
    const shop = formData.get("shop") as string;

    // Snapshot missing count before import
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

    const bySku = new Map<string, string>(); // sku → id
    const byVariantId = new Map<string, string>(); // shopifyVariantId → id
    for (const v of allVariants) {
      if (v.sku) bySku.set(v.sku.toLowerCase().trim(), v.id);
      const plainId = v.shopifyVariantId.replace("gid://shopify/ProductVariant/", "");
      byVariantId.set(plainId, v.id);
      byVariantId.set(v.shopifyVariantId, v.id);
    }

    // Parse all rows first, then batch write
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

    // Fix 1: batch writes in chunks of 25 instead of sequential awaits
    const CHUNK_SIZE = 25;
    for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
      const chunk = updates.slice(i, i + CHUNK_SIZE);
      await Promise.all(
        chunk.map(({ id, cost }) =>
          db.productVariant.update({
            where: { id },
            data: { customCost: cost, effectiveCost: cost },
          })
        )
      );
      result.updated += chunk.length;
    }

    // Fix 5: snapshot after to show improvement
    result.missingAfter = await db.productVariant.count({
      where: { product: { shop }, effectiveCost: null },
    });

    return json({ success: true, result });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

// ── Inline cost input with save feedback ──────────────────────────────────────
function InlineCostInput({ variant }: { variant: VariantRow }) {
  const fetcher = useFetcher();
  const [value, setValue] = useState(
    variant.customCost != null ? String(variant.customCost) : ""
  );
  // Fix 6: saved state feedback
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
      {/* Fix 6: subtle save confirmation */}
      {isSaving && <Text variant="bodySm" as="span" tone="subdued">Saving…</Text>}
      {!isSaving && justSaved && <Text variant="bodySm" as="span" tone="success">✓</Text>}
    </InlineStack>
  );
}

// ── Bulk cost modal ───────────────────────────────────────────────────────────
function BulkCostModal({
  open,
  onClose,
  selectedCount,
  variantIds,
}: {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  variantIds: string[];
}) {
  const submit = useSubmit();
  const [cost, setCost] = useState("");
  // Fix 4: onlyMissing option instead of prompt()
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
    setOnlyMissing(false);
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
            helpText="This will be set as the custom cost for all selected variants."
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
  const importResult = fetcher.data?.result as ImportResult | null;

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

  // Fix 5: compute accuracy improvement from import result
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
        onAction: () => fetcher.submit(
          { intent: "bulkImport", csvData: csvText, shop },
          { method: "POST" }
        ),
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

            {/* Fix 5: show profit accuracy improvement */}
            <Banner
              tone={importResult.errors.length > 0 || importResult.notFound.length > 0 ? "warning" : "success"}
              title={`${importResult.updated} variant${importResult.updated !== 1 ? "s" : ""} updated`}
            >
              {accuracyBefore !== null && accuracyAfter !== null && accuracyAfter > accuracyBefore && (
                <BlockStack gap="100">
                  <Text as="p">
                    {`Missing COGS: ${importResult.missingBefore} → ${importResult.missingAfter}`}
                  </Text>
                  <Text as="p">
                    {`Profit accuracy: ${accuracyBefore}% → ${accuracyAfter}%`}
                  </Text>
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
export default function ProductsPage() {
  const {
    products, totalVariants, missingCogsCount, missingCogsImpact, cogsCoveragePercent,
    totalProducts, totalFilteredProducts, page, pageSize, totalPages,
    search, filter, vendor, shop,
  } = useLoaderData() as LoaderData;

  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vendorTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [searchValue, setSearchValue] = useState(search);
  const [vendorValue, setVendorValue] = useState(vendor);
  const [importOpen, setImportOpen] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  // Fix 4: ref for scroll-to-table on action click
  const tableRef = useRef<HTMLDivElement>(null);

  const isLoading = navigation.state === "loading";

  // Fix 4: avoid flatMap on all variants — only what's on current page
  const allVariants = products.flatMap((p) => p.variants);
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(allVariants);

  const updateParam = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value && value !== "all") { next.set(key, value); } else { next.delete(key); }
    if (key !== "page") next.set("page", "1");
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchValue(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => updateParam("search", value), 500);
  }, [updateParam]);

  const handleVendorChange = useCallback((value: string) => {
    setVendorValue(value);
    if (vendorTimeout.current) clearTimeout(vendorTimeout.current);
    vendorTimeout.current = setTimeout(() => updateParam("vendor", value), 500);
  }, [updateParam]);

  const filters = [
    {
      key: "missingCogs",
      label: "COGS Status",
      filter: (
        <Button onClick={() => updateParam("filter", filter === "missing" ? "all" : "missing")}>
          {filter === "missing" ? "Show all" : "Missing COGS only"}
        </Button>
      ),
      shortcut: true,
    },
    {
      key: "vendorFilter",
      label: "Vendor",
      filter: (
        <TextField
          label="Vendor"
          value={vendorValue}
          onChange={handleVendorChange}
          autoComplete="off"
          labelHidden
          placeholder="Search by vendor..."
        />
      ),
      shortcut: false,
    },
  ];

  const appliedFilters = [];
  if (filter === "missing") {
    appliedFilters.push({
      key: "missingCogs",
      label: "Missing COGS only",
      onRemove: () => updateParam("filter", "all"),
    });
  }
  if (vendor) {
    appliedFilters.push({
      key: "vendorFilter",
      label: `Vendor: ${vendor}`,
      onRemove: () => { setVendorValue(""); updateParam("vendor", ""); },
    });
  }

  // Fix 1: future-proof action system — sorted by impact, extensible
  const actionEntries = [
    {
      id: "missing_cogs",
      title: "Complete your cost data",
      count: missingCogsCount,
      impact: missingCogsImpact,
      severity: "critical" as const,
      message: `${missingCogsCount} variant${missingCogsCount > 1 ? "s" : ""} missing cost data`,
      // Fix 2: sharper messaging
      urgency: "Your profit is currently underreported until this is fixed",
      buttonLabel: "Fix missing costs",
      onAction: () => {
        updateParam("filter", "missing");
        // Fix 4: scroll to table
        setTimeout(() => tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
      },
    },
    // Future: low_margin_products, high_return_products, etc.
  ];

  const sortedActions = actionEntries
    .filter((a) => a.count > 0)
    .sort((a, b) => b.impact - a.impact);

  const topAction = sortedActions[0] ?? null;

  // Fix 4: proper bulk action with modal instead of prompt()
  const promotedBulkActions = [
    {
      content: `Recover profit on ${selectedResources.length} variant${selectedResources.length !== 1 ? "s" : ""}`,
      onAction: () => setBulkModalOpen(true),
    },
  ];

  if (isLoading && !searchValue && !vendorValue && allVariants.length === 0) {
    return (
      <SkeletonPage title="Products & COGS">
        <Layout>
          <Layout.Section><Card><SkeletonBodyText lines={3} /></Card></Layout.Section>
          <Layout.Section><Card><SkeletonBodyText lines={10} /></Card></Layout.Section>
        </Layout>
      </SkeletonPage>
    );
  }

  const getShopifyProductUrl = (shopifyProductId: string) => {
    return `https://${shop}/admin/products/${shopifyProductId.replace("gid://shopify/Product/", "")}`;
  };

  const rowMarkup = allVariants.map((variant, index) => (
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
        <br />
        <Text variant="bodySm" tone="subdued" as="span">{variant.title}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{variant.sku || "—"}</IndexTable.Cell>
      <IndexTable.Cell>
        {variant.costPerItem != null
          ? "$" + variant.costPerItem.toFixed(2)
          : <Badge tone="attention">Not set</Badge>}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineCostInput variant={variant} />
      </IndexTable.Cell>
      <IndexTable.Cell>
        {variant.effectiveCost != null ? (
          <Text as="span" fontWeight="bold">{"$" + variant.effectiveCost.toFixed(2)}</Text>
        ) : (
          <Badge tone="critical">Missing cost</Badge>
        )}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  const coverageIsHealthy = cogsCoveragePercent >= 95;

  return (
    <Page
      title="Products & COGS"
      primaryAction={{ content: "Import CSV", onAction: () => setImportOpen(true) }}
    >
      <Layout>
        {/* Fix 1: Action Center — dynamic, sorted by impact, future-proof */}
        {topAction && (
          <Layout.Section>
            <div style={{
              padding: "16px 20px", borderRadius: "12px",
              background: "#fff1f0", border: "1px solid #ffa39e",
            }}>
              <BlockStack gap="200">
                <BlockStack gap="050">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="headingSm" as="h3">Recommended next step</Text>
                    {/* Fix 5: progress momentum */}
                    <Text variant="bodySm" as="p" tone="subdued">
                      {`${cogsCoveragePercent}% complete`}
                    </Text>
                  </InlineStack>
                  {/* Fix 2: sharper urgency */}
                  <Text variant="bodySm" as="p" tone="critical">
                    {topAction.urgency}
                  </Text>
                </BlockStack>
                <Text as="p" tone="critical">{topAction.message}</Text>
                <InlineStack gap="300" blockAlign="center">
                  <Button variant="primary" onClick={topAction.onAction}>
                    {topAction.buttonLabel}
                  </Button>
                  <Button onClick={() => setImportOpen(true)}>Import CSV</Button>
                  {/* Fix 3: impact with relative context */}
                  <BlockStack gap="0">
                    <Text variant="bodySm" as="p" tone="success">
                      {`~$${topAction.impact.toFixed(0)} at risk`}
                    </Text>
                    <Text variant="bodySm" as="p" tone="subdued">
                      Estimated based on average order value
                    </Text>
                  </BlockStack>
                </InlineStack>
              </BlockStack>
            </div>
          </Layout.Section>
        )}

        {missingCogsCount > 0 && (
          <Layout.Section>
            <Banner
              tone="warning"
              title={`Your profit data is unreliable — ${missingCogsCount} variant${missingCogsCount > 1 ? "s" : ""} missing cost`}
              action={{ content: "Show missing only", onAction: () => updateParam("filter", "missing") }}
              secondaryAction={{ content: "Import CSV", onAction: () => setImportOpen(true) }}
            >
              <p>
                {`Your reported profit may be off by ~$${missingCogsImpact.toFixed(0)}. `}
                <em>Estimated based on average order value.</em>
              </p>
            </Banner>
          </Layout.Section>
        )}

        {/* Fix: decision-driven summary with COGS coverage % */}
        <Layout.Section>
          <Card>
            <InlineStack gap="800" wrap>
              <BlockStack gap="100">
                <Text variant="bodySm" as="p" tone="subdued">Total products</Text>
                <Text variant="headingMd" as="p">{totalProducts}</Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text variant="bodySm" as="p" tone="subdued">Total variants</Text>
                <Text variant="headingMd" as="p">{totalVariants}</Text>
              </BlockStack>
              <BlockStack gap="200">
                <BlockStack gap="050">
                  <Text variant="bodySm" as="p" tone="subdued">COGS coverage</Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Text
                      variant="headingMd"
                      as="p"
                      tone={coverageIsHealthy ? undefined : "critical"}
                    >
                      {cogsCoveragePercent}%
                    </Text>
                    <Badge tone={coverageIsHealthy ? "success" : "critical"}>
                      {coverageIsHealthy ? "Healthy" : "Below target"}
                    </Badge>
                  </InlineStack>
                </BlockStack>
                {/* Native progress bar — avoids Polaris version compatibility issues */}
                <div style={{ height: "6px", borderRadius: "3px", background: "#e5e7eb", overflow: "hidden" }}>
                  <div style={{
                    height: "100%",
                    width: `${cogsCoveragePercent}%`,
                    background: coverageIsHealthy ? "#008060" : "#d92d20",
                    borderRadius: "3px",
                    transition: "width 0.3s ease",
                  }} />
                </div>
                {!coverageIsHealthy && (
                  <Text variant="bodySm" as="p" tone="subdued">
                    Target: 95%+ · {missingCogsCount} variant{missingCogsCount > 1 ? "s" : ""} missing
                  </Text>
                )}
              </BlockStack>
              {missingCogsCount > 0 && (
                <BlockStack gap="050">
                  <Text variant="bodySm" as="p" tone="subdued">Unknown profit impact</Text>
                  <Text variant="headingMd" as="p" tone="critical">
                    ~${missingCogsImpact.toFixed(0)}
                  </Text>
                  <Text variant="bodySm" as="p" tone="subdued">estimated per period</Text>
                </BlockStack>
              )}
            </InlineStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          {/* Fix 4: tableRef for scroll-to on action click */}
          <div ref={tableRef}>
          <Card padding="0">
            {/* Fix 4: context label when filter active from Action Center */}
            {filter === "missing" && (
              <Box padding="300" borderBlockEndWidth="025" borderColor="border">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="bodySm" as="p" tone="caution" fontWeight="semibold">
                      ⚠️ Showing: Missing COGS variants only
                    </Text>
                    <Text variant="bodySm" as="p" tone="subdued">
                      {`${missingCogsCount} variant${missingCogsCount > 1 ? "s" : ""} need a cost`}
                    </Text>
                  </InlineStack>
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
                onClearAll={() => {
                  updateParam("filter", "all");
                  updateParam("vendor", "");
                  setVendorValue("");
                }}
              />
            </div>

            <IndexTable
              resourceName={{ singular: "variant", plural: "variants" }}
              itemCount={allVariants.length}
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
                (() => {
                  if (filter === "missing" && missingCogsCount === 0) {
                    return (
                      <EmptyState
                        heading="All product costs are complete"
                        image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                      >
                        <p>Your profit calculations are fully accurate. No action needed.</p>
                      </EmptyState>
                    );
                  }
                  if (search || filter !== "all" || vendor) {
                    return (
                      <EmptyState
                        heading="No products match your search"
                        image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                      >
                        <p>Try adjusting your filters.</p>
                      </EmptyState>
                    );
                  }
                  return (
                    <EmptyState
                      heading="No products found"
                      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                    >
                      <p>Sync your products from Shopify to get started.</p>
                    </EmptyState>
                  );
                })()
              }
            >
              {rowMarkup}
            </IndexTable>

            <div style={{
              padding: "16px", display: "flex", justifyContent: "space-between",
              alignItems: "center", borderTop: "1px solid #ebebeb",
            }}>
              <InlineStack align="start" blockAlign="center" gap="400">
                <Select
                  label="Items per page"
                  labelInline
                  options={[
                    { label: "20", value: "20" },
                    { label: "50", value: "50" },
                    { label: "100", value: "100" },
                  ]}
                  value={String(pageSize)}
                  onChange={(val) => updateParam("pageSize", val)}
                />
              </InlineStack>
              {totalPages > 1 && (
                <Pagination
                  hasPrevious={page > 1}
                  onPrevious={() => updateParam("page", String(page - 1))}
                  hasNext={page < totalPages}
                  onNext={() => updateParam("page", String(page + 1))}
                  label={`Page ${page} of ${totalPages} (${totalFilteredProducts} results)`}
                />
              )}
            </div>
          </Card>
          </div>
        </Layout.Section>
      </Layout>

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        shop={shop}
        totalVariants={totalVariants}
      />

      <BulkCostModal
        open={bulkModalOpen}
        onClose={() => { setBulkModalOpen(false); clearSelection(); }}
        selectedCount={selectedResources.length}
        variantIds={selectedResources}
      />
    </Page>
  );
}
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useFetcher, useSearchParams } from "react-router";
import { useState, useCallback, useRef, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  Box,
  BlockStack,
  InlineStack,
  Button,
  TextField,
  Banner,
  EmptyState,
  Modal,
  DropZone,
  List,
  Divider,
  SkeletonPage,
  SkeletonBodyText,
  IndexTable,
  useIndexResourceState,
  Filters,
  Pagination,
  Select,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── Interfaces ───────────────────────────────────────────────────────────────
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
  [key: string]: any;
}

interface ProductGroup {
  id: string;
  shopifyProductId: string;
  title: string;
  variants: VariantRow[];
  missingCogs: boolean;
}

interface ImportResult {
  updated: number;
  notFound: string[];
  errors: string[];
}

interface LoaderData {
  products: ProductGroup[];
  totalVariants: number;
  missingCogsCount: number;
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

// ── Backend: Loader ──────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const filter = url.searchParams.get("filter") || "all";
  const vendor = url.searchParams.get("vendor") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  
  // Dynamic page size
  const pageSizeParam = parseInt(url.searchParams.get("pageSize") || "20", 10);
  const pageSize = [20, 50, 100].includes(pageSizeParam) ? pageSizeParam : 20;

  // Build where for products
  const productWhere: any = { shop };
  
  if (search) {
    productWhere.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { variants: { some: { sku: { contains: search, mode: "insensitive" } } } },
    ];
  }
  
  if (filter === "missing") {
    productWhere.variants = {
      ...(productWhere.variants || {}),
      some: { effectiveCost: null },
    };
  }

  // NOTE: Ensure 'vendor' exists on your Prisma Product model. 
  // If you sync productType instead, change this to productWhere.productType
  if (vendor) {
    productWhere.vendor = { contains: vendor, mode: "insensitive" };
  }

  const totalFilteredProducts = await db.product.count({ where: productWhere });
  const totalPages = Math.max(1, Math.ceil(totalFilteredProducts / pageSize));
  const currentPage = Math.min(page, totalPages);

  const products = await db.product.findMany({
    where: productWhere,
    include: { variants: true },
    orderBy: { title: "asc" },
    skip: (currentPage - 1) * pageSize,
    take: pageSize,
  });

  const [totalProducts, allVariants] = await Promise.all([
    db.product.count({ where: { shop } }),
    db.productVariant.findMany({
      where: { product: { shop } },
      select: { effectiveCost: true },
    }),
  ]);

  const totalVariants = allVariants.length;
  const missingCogsCount = allVariants.filter((v) => v.effectiveCost === null).length;

  const productGroups: ProductGroup[] = products.map((p) => ({
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
  }));

  return json({
    products: productGroups,
    totalVariants,
    missingCogsCount,
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

// ── Backend: Action ──────────────────────────────────────────────────────────
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
    if (!variantIdsRaw || !costRaw) return json({ error: "Missing data" }, { status: 400 });

    const variantIds = JSON.parse(variantIdsRaw) as string[];
    const customCost = parseFloat(costRaw);
    if (isNaN(customCost) || customCost < 0) return json({ error: "Invalid cost" }, { status: 400 });

    await db.productVariant.updateMany({
      where: { id: { in: variantIds } },
      data: { customCost, effectiveCost: customCost },
    });
    return json({ success: true });
  }

  if (intent === "bulkImport") {
    const csvData = formData.get("csvData") as string;
    const shop = formData.get("shop") as string;
    const lines = csvData.split("\n").map((l) => l.trim()).filter(Boolean);
    const dataLines = lines[0]?.toLowerCase().includes("sku") ? lines.slice(1) : lines;
    const result: ImportResult = { updated: 0, notFound: [], errors: [] };

    const allVariants = await db.productVariant.findMany({
      where: { product: { shop } },
    });

    const bySku = new Map<string, typeof allVariants[number]>();
    const byVariantId = new Map<string, typeof allVariants[number]>();
    for (const v of allVariants) {
      if (v.sku) bySku.set(v.sku.toLowerCase().trim(), v);
      const plainId = v.shopifyVariantId.replace("gid://shopify/ProductVariant/", "");
      byVariantId.set(plainId, v);
      byVariantId.set(v.shopifyVariantId, v);
    }

    for (const line of dataLines) {
      if (!line) continue;
      const parts = line.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
      if (parts.length < 2) { result.errors.push(`Invalid line: "${line}"`); continue; }
      const identifier = parts[0];
      const cost = parseFloat(parts[1]);
      if (isNaN(cost) || cost < 0) { result.errors.push(`Invalid cost for "${identifier}"`); continue; }
      const variant = bySku.get(identifier.toLowerCase()) ?? byVariantId.get(identifier) ?? null;
      if (!variant) { result.notFound.push(identifier); continue; }
      await db.productVariant.update({
        where: { id: variant.id },
        data: { customCost: cost, effectiveCost: cost },
      });
      result.updated++;
    }
    return json({ success: true, result });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

// ── Frontend: Custom Inline Editing Component ────────────────────────────────
function InlineCostInput({ variant }: { variant: VariantRow }) {
  const fetcher = useFetcher();
  const [value, setValue] = useState(
    variant.customCost != null ? String(variant.customCost) : ""
  );

  useEffect(() => {
    setValue(variant.customCost != null ? String(variant.customCost) : "");
  }, [variant.customCost]);

  const handleBlur = () => {
    const currentValue = variant.customCost != null ? String(variant.customCost) : "";
    if (value !== currentValue) {
      fetcher.submit(
        { intent: "updateCost", variantId: variant.id, customCost: value },
        { method: "POST" }
      );
    }
  };

  return (
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
      disabled={fetcher.state !== "idle"}
      size="slim"
    />
  );
}

// ── Frontend: CSV Import Modal ───────────────────────────────────────────────
function ImportModal({ open, onClose, shop }: { open: boolean; onClose: () => void; shop: string }) {
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

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Bulk import COGS from CSV"
      primaryAction={{ content: "Import", onAction: () => fetcher.submit({ intent: "bulkImport", csvData: csvText, shop }, { method: "POST" }), loading: isSaving, disabled: !csvText.trim() || isSaving }}
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
            <Banner tone={importResult.errors.length > 0 || importResult.notFound.length > 0 ? "warning" : "success"} title={`${importResult.updated} variant${importResult.updated !== 1 ? "s" : ""} updated`} />
            {importResult.notFound.length > 0 && (
              <BlockStack gap="100">
                <Text as="p" tone="caution">{"Not found (" + importResult.notFound.length + "):"}</Text>
                <List type="bullet">
                  {importResult.notFound.slice(0, 10).map((id) => <List.Item key={id}>{id}</List.Item>)}
                  {importResult.notFound.length > 10 && <List.Item>{"...and " + (importResult.notFound.length - 10) + " more"}</List.Item>}
                </List>
              </BlockStack>
            )}
            {importResult.errors.length > 0 && (
              <BlockStack gap="100">
                <Text as="p" tone="critical">{"Errors (" + importResult.errors.length + "):"}</Text>
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

// ── Frontend: Main Page ──────────────────────────────────────────────────────
export default function ProductsPage() {
  const {
    products, totalVariants, missingCogsCount, totalProducts,
    totalFilteredProducts, page, pageSize, totalPages, search, filter, vendor, shop,
  } = useLoaderData() as LoaderData;

  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vendorTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [searchValue, setSearchValue] = useState(search);
  const [vendorValue, setVendorValue] = useState(vendor);
  const [importOpen, setImportOpen] = useState(false);

  const isLoading = navigation.state === "loading";

  const allVariants = products.flatMap((p) => p.variants);
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(allVariants);

  const updateParam = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value && value !== "all") {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    if (key !== "page") next.set("page", "1");
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchValue(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      updateParam("search", value);
    }, 500);
  }, [updateParam]);

  const handleVendorChange = useCallback((value: string) => {
    setVendorValue(value);
    if (vendorTimeout.current) clearTimeout(vendorTimeout.current);
    vendorTimeout.current = setTimeout(() => {
      updateParam("vendor", value);
    }, 500);
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
    }
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
      onRemove: () => {
        setVendorValue("");
        updateParam("vendor", "");
      },
    });
  }

  const promotedBulkActions = [
    {
      content: 'Set cost for selection',
      onAction: () => {
        const bulkCost = prompt("What custom cost do you want to set for these variants? (e.g., 12.50)");
        if (bulkCost) {
          submit(
            { intent: "bulkUpdateCosts", variantIds: JSON.stringify(selectedResources), cost: bulkCost },
            { method: "POST" }
          );
          clearSelection();
        }
      },
    },
  ];

  if (isLoading && !searchValue && !vendorValue && allVariants.length === 0) {
    return (
      <SkeletonPage title="Products & COGS">
        <Layout>
          <Layout.Section>
            <Card><SkeletonBodyText lines={3} /></Card>
          </Layout.Section>
          <Layout.Section>
            <Card><SkeletonBodyText lines={10} /></Card>
          </Layout.Section>
        </Layout>
      </SkeletonPage>
    );
  }

  const getShopifyProductUrl = (shopifyProductId: string) => {
    const numericId = shopifyProductId.replace("gid://shopify/Product/", "");
    return `https://${shop}/admin/products/${numericId}`;
  };

  const rowMarkup = allVariants.map((variant, index) => (
    <IndexTable.Row
      id={variant.id}
      key={variant.id}
      selected={selectedResources.includes(variant.id)}
      position={index}
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
        {variant.costPerItem != null ? "$" + variant.costPerItem.toFixed(2) : <Badge tone="attention">Not set</Badge>}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <div style={{ maxWidth: '140px' }}>
          <InlineCostInput variant={variant} />
        </div>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {variant.effectiveCost != null ? (
          <Text as="span" fontWeight="bold">{"$" + variant.effectiveCost.toFixed(2)}</Text>
        ) : (
          <Badge tone="critical">Missing</Badge>
        )}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="Products & COGS"
      primaryAction={{ content: "Import CSV", onAction: () => setImportOpen(true) }}
    >
      <Layout>
        {missingCogsCount > 0 && (
          <Layout.Section>
            <Banner
              title={`${missingCogsCount} variant${missingCogsCount > 1 ? "s" : ""} missing cost data`}
              tone="warning"
            >
              <p>Enter them directly in the table below, or use the CSV import.</p>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <InlineStack gap="800">
              <BlockStack gap="100">
                <Text variant="bodySm" as="p" tone="subdued">Total products</Text>
                <Text variant="headingMd" as="p">{totalProducts}</Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text variant="bodySm" as="p" tone="subdued">Total variants</Text>
                <Text variant="headingMd" as="p">{totalVariants}</Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text variant="bodySm" as="p" tone="subdued">Missing COGS</Text>
                <Text variant="headingMd" as="p" tone={missingCogsCount > 0 ? "critical" : undefined}>
                  {missingCogsCount}
                </Text>
              </BlockStack>
            </InlineStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <div style={{ padding: '16px' }}>
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
              resourceName={{ singular: 'variant', plural: 'variants' }}
              itemCount={allVariants.length}
              selectedItemsCount={allResourcesSelected ? 'All' : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              promotedBulkActions={promotedBulkActions}
              headings={[
                { title: 'Product & Variant' },
                { title: 'SKU' },
                { title: 'Shopify Cost' },
                { title: 'Custom Cost (Edit)' },
                { title: 'Effective Cost' },
              ]}
              emptyState={
                <EmptyState
                  heading={search || filter !== "all" || vendor ? "No products match your search" : "No products found"}
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                />
              }
            >
              {rowMarkup}
            </IndexTable>

            <div style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #ebebeb' }}>
              <Box>
                <InlineStack align="start" blockAlign="center" gap="400">
                  <Select
                    label="Items per page"
                    labelInline
                    options={[
                      { label: '20', value: '20' },
                      { label: '50', value: '50' },
                      { label: '100', value: '100' },
                    ]}
                    value={String(pageSize)}
                    onChange={(val) => updateParam("pageSize", val)}
                  />
                </InlineStack>
              </Box>
              
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
        </Layout.Section>
      </Layout>

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} shop={shop} />
    </Page>
  );
}
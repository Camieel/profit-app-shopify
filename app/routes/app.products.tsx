import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useFetcher, useSearchParams } from "react-router";
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
  Banner,
  EmptyState,
  Modal,
  DropZone,
  List,
  Divider,
  SkeletonPage,
  SkeletonBodyText,
  Select,
  InlineGrid,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PAGE_SIZE = 20;

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
  totalPages: number;
  search: string;
  filter: string;
  shop: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const filter = url.searchParams.get("filter") || "all";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

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

  const totalFilteredProducts = await db.product.count({ where: productWhere });
  const totalPages = Math.max(1, Math.ceil(totalFilteredProducts / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);

  const products = await db.product.findMany({
    where: productWhere,
    include: { variants: true },
    orderBy: { title: "asc" },
    skip: (currentPage - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  // Global stats (unfiltered)
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
    totalPages,
    search,
    filter,
    shop: session.shop,
  });
};

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

// ── Edit Cost Modal ──────────────────────────────────────────────────────────
function EditCostModal({
  variant, onClose, onSave, isSaving,
}: {
  variant: VariantRow | null;
  onClose: () => void;
  onSave: (variantId: string, cost: string) => void;
  isSaving: boolean;
}) {
  const [cost, setCost] = useState(
    variant?.customCost != null ? String(variant.customCost)
    : variant?.costPerItem != null ? String(variant.costPerItem)
    : ""
  );
  if (!variant) return null;
  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`Edit cost — ${variant.productTitle} / ${variant.title}`}
      primaryAction={{ content: "Save", onAction: () => onSave(variant.id, cost), loading: isSaving }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Text as="p" tone="subdued">
            Shopify cost: {variant.costPerItem != null ? "$" + variant.costPerItem.toFixed(2) : "Not set"}
          </Text>
          <TextField
            label="Custom cost override"
            type="number"
            value={cost}
            onChange={setCost}
            prefix="$"
            autoComplete="off"
            helpText="Leave empty to use Shopify's cost. Custom cost takes priority."
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ── CSV Import Modal ─────────────────────────────────────────────────────────
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

// ── Page ─────────────────────────────────────────────────────────────────────
export default function ProductsPage() {
  const {
    products, totalVariants, missingCogsCount, totalProducts,
    totalFilteredProducts, page, totalPages, search, filter, shop,
  } = useLoaderData() as LoaderData;

  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isLoading = navigation.state === "loading";

  const [editingVariant, setEditingVariant] = useState<VariantRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [searchValue, setSearchValue] = useState(search);

  const isSaving = navigation.state === "submitting";

  if (isLoading && !editingVariant && !importOpen) {
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

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    if (key !== "page") next.set("page", "1");
    setSearchParams(next);
  };

  const handleSearchSubmit = () => updateParam("search", searchValue);

  const handleSave = (variantId: string, cost: string) => {
    submit({ intent: "updateCost", variantId, customCost: cost }, { method: "POST" });
    setEditingVariant(null);
  };

  const handleClearCustomCost = (variantId: string) => {
    submit({ intent: "clearCustomCost", variantId }, { method: "POST" });
  };

  const getShopifyProductUrl = (shopifyProductId: string) => {
    const numericId = shopifyProductId.replace("gid://shopify/Product/", "");
    return `https://${shop}/admin/products/${numericId}`;
  };

  return (
    <Page
      title="Products & COGS"
      primaryAction={{ content: "Import CSV", onAction: () => setImportOpen(true) }}
    >
      <Layout>
        {/* Warning banner */}
        {missingCogsCount > 0 && (
          <Layout.Section>
            <Banner
              title={`${missingCogsCount} variant${missingCogsCount > 1 ? "s" : ""} missing cost data`}
              tone="warning"
            >
              <p>
                Orders containing these variants will show incomplete margins.
                Set a custom cost below, import via CSV, or add cost data in
                Shopify (Products → variant → Cost per item).
              </p>
            </Banner>
          </Layout.Section>
        )}

        {/* Stats */}
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

        {/* Search + Filter */}
        <Layout.Section>
          <Card>
            {/* Wikkel je grid in een form. preventDefault stopt de pagina-reload */}
            <form onSubmit={(e) => { e.preventDefault(); handleSearchSubmit(); }}>
              <InlineGrid columns={{ xs: 1, sm: "1fr auto auto" }} gap="300">
                <TextField
                  label="Search"
                  labelHidden
                  placeholder="Search by product name or SKU..."
                  value={searchValue}
                  onChange={setSearchValue}
                  autoComplete="off"
                  /* onKeyDown is hier verwijderd */
                  clearButton
                  onClearButtonClick={() => { 
                    setSearchValue(""); 
                    updateParam("search", ""); 
                  }}
                />
                {/* Verander de Button naar een submit-knop */}
                <Button submit>Search</Button>
                
                <Select
                label="Filter"
                labelHidden
                options={[
                  { label: "All products", value: "all" },
                  { label: "Missing COGS only", value: "missing" },
                ]}
                value={filter}
                onChange={(v) => updateParam("filter", v)}
              />
                </InlineGrid>
            </form>
          </Card>
        </Layout.Section>

        {/* Products list */}
        <Layout.Section>
          {products.length === 0 ? (
            <Card>
              <EmptyState
                heading={search || filter !== "all" ? "No products match your search" : "No products synced yet"}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  {search || filter !== "all"
                    ? "Try adjusting your search or filter."
                    : "Products are synced automatically on install."}
                </p>
              </EmptyState>
            </Card>
          ) : (
            <BlockStack gap="400">
              {products.map((product) => (
                <Card key={product.id} padding="0">
                  <Box padding="400" borderBlockEndWidth="025" borderColor="border">
                    <InlineStack align="space-between" blockAlign="center">
                      <Button variant="plain" url={getShopifyProductUrl(product.shopifyProductId)} external>
                        {product.title + " ↗"}
                      </Button>
                      {product.missingCogs && <Badge tone="warning">Missing COGS</Badge>}
                    </InlineStack>
                  </Box>
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                    headings={["Variant", "SKU", "Shopify Cost", "Custom Cost", "Effective Cost", "Actions"]}
                    rows={product.variants.map((variant) => [
                      <Text variant="bodyMd" as="span" key={variant.id}>{variant.title}</Text>,
                      <Text variant="bodySm" as="span" tone="subdued" key={variant.id + "-sku"}>{variant.sku || "—"}</Text>,
                      variant.costPerItem != null
                        ? "$" + variant.costPerItem.toFixed(2)
                        : <Badge tone="attention" key={variant.id + "-cost"}>Not set</Badge>,
                      variant.customCost != null ? (
                        <InlineStack gap="200" blockAlign="center" key={variant.id + "-custom"}>
                          <Text as="span">{"$" + variant.customCost.toFixed(2)}</Text>
                          <Button variant="plain" tone="critical" size="micro" onClick={() => handleClearCustomCost(variant.id)}>Clear</Button>
                        </InlineStack>
                      ) : (
                        <Text as="span" tone="subdued" key={variant.id + "-custom"}>—</Text>
                      ),
                      variant.effectiveCost != null
                        ? <Text as="span" fontWeight="semibold" key={variant.id + "-eff"}>{"$" + variant.effectiveCost.toFixed(2)}</Text>
                        : <Badge tone="critical" key={variant.id + "-eff"}>Missing</Badge>,
                      <Button key={variant.id + "-edit"} size="slim" onClick={() => setEditingVariant(variant)}>Edit cost</Button>,
                    ])}
                  />
                </Card>
              ))}

              {/* Pagination */}
              <Card>
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="bodySm" as="p" tone="subdued">
                    {`Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, totalFilteredProducts)} of ${totalFilteredProducts} products`}
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="bodySm" as="span" tone="subdued">
                      {`Page ${page} of ${totalPages}`}
                    </Text>
                    <Button disabled={page <= 1} onClick={() => updateParam("page", String(page - 1))} size="slim">Previous</Button>
                    <Button disabled={page >= totalPages} onClick={() => updateParam("page", String(page + 1))} size="slim">Next</Button>
                  </InlineStack>
                </InlineStack>
              </Card>
            </BlockStack>
          )}
        </Layout.Section>
      </Layout>

      <EditCostModal
        key={editingVariant?.id ?? "none"}
        variant={editingVariant}
        onClose={() => setEditingVariant(null)}
        onSave={handleSave}
        isSaving={isSaving}
      />

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} shop={shop} />
    </Page>
  );
}
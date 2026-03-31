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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PAGE_SIZE = 20;

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
  [key: string]: any; // <- Deze regel lost de error op
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

// ── Backend: Loader ──────────────────────────────────────────────────────────
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

  // NIEUW: Bulk update actie voor de geselecteerde rijen in de IndexTable
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
  // Gebruik lokale state voor vlotte input, effect triggert opslaan
  const [value, setValue] = useState(
    variant.customCost != null ? String(variant.customCost) : 
    ""
  );

  // Zorg dat het veld update als data van buitenaf (bulk/import) verandert
  useEffect(() => {
    setValue(variant.customCost != null ? String(variant.customCost) : "");
  }, [variant.customCost]);

  const handleBlur = () => {
    const currentValue = variant.customCost != null ? String(variant.customCost) : "";
    // Sla alleen op als de waarde écht is veranderd
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
    totalFilteredProducts, page, totalPages, search, filter, shop,
  } = useLoaderData() as LoaderData;

  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [searchValue, setSearchValue] = useState(search);
  const [importOpen, setImportOpen] = useState(false);

  const isLoading = navigation.state === "loading";

  // 1. Data plat slaan voor de IndexTable (elke rij is een variant)
  const allVariants = products.flatMap((p) => p.variants);
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(allVariants);

  // 2. Auto-submit / Debounce voor zoeken
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

  // 3. Filters opzetten
  const filters = [
    {
      key: "missingCogs",
      label: "COGS Status",
      filter: (
        <Button onClick={() => updateParam("filter", filter === "missing" ? "all" : "missing")}>
          {filter === "missing" ? "Toon alles" : "Alleen missende COGS"}
        </Button>
      ),
      shortcut: true,
    },
  ];

  // 4. Bulk Actie
  const promotedBulkActions = [
    {
      content: 'Stel prijs in voor selectie',
      onAction: () => {
        const bulkCost = prompt("Welke inkoopprijs wil je instellen voor deze varianten? (bijv. 12.50)");
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

  // Render Skeleton tijdens het laden
  if (isLoading && !searchValue && allVariants.length === 0) {
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

  // Bouw de rijen voor de IndexTable
  const rowMarkup = allVariants.map((variant, index) => (
    <IndexTable.Row
      id={variant.id}
      key={variant.id}
      selected={selectedResources.includes(variant.id)}
      position={index}
    >
      <IndexTable.Cell>
        <Text variant="bodyMd" fontWeight="bold" as="span">{variant.productTitle}</Text>
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
              title={`${missingCogsCount} variant${missingCogsCount > 1 ? "en missen" : " mist"} inkoopprijzen`}
              tone="warning"
            >
              <p>Vul ze direct in de tabel hieronder in, of gebruik de CSV import.</p>
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

        <Layout.Section>
          <Card padding="0">
            <div style={{ padding: '16px' }}>
              <Filters
                queryValue={searchValue}
                filters={filters}
appliedFilters={
  filter === "missing" 
    ? [{ 
        key: "missingCogs", 
        label: "Alleen missende COGS",
        onRemove: () => updateParam("filter", "all") // <- Vertelt Polaris wat er gebeurt als je op het kruisje klikt
      }] 
    : []
}                onQueryChange={handleSearchChange}
                onQueryClear={() => handleSearchChange("")}
                onClearAll={() => updateParam("filter", "all")}
              />
            </div>

            <IndexTable
              resourceName={{ singular: 'variant', plural: 'varianten' }}
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
                  heading={search || filter !== "all" ? "Geen producten matchen met je zoekopdracht" : "Geen producten gevonden"}
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                />
              }
            >
              {rowMarkup}
            </IndexTable>

            {totalPages > 1 && (
              <div style={{ padding: '16px', display: 'flex', justifyContent: 'center', borderTop: '1px solid #ebebeb' }}>
                <Pagination
                  hasPrevious={page > 1}
                  onPrevious={() => updateParam("page", String(page - 1))}
                  hasNext={page < totalPages}
                  onNext={() => updateParam("page", String(page + 1))}
                  label={`Pagina ${page} van ${totalPages} (${totalFilteredProducts} resultaten)`}
                />
              </div>
            )}
          </Card>
        </Layout.Section>
      </Layout>

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} shop={shop} />
    </Page>
  );
}
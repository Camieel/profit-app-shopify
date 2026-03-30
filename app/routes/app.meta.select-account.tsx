import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  Button,
  ResourceList,
  ResourceItem,
  InlineStack,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

interface AdAccount {
  id: string;
  name: string;
  currency: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const accountsParam = url.searchParams.get("accounts");

  if (!accountsParam) return redirect("/app/settings");

  const accounts: AdAccount[] = JSON.parse(decodeURIComponent(accountsParam));
  return json({ accounts });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const accountId = formData.get("accountId") as string;
  const accountName = formData.get("accountName") as string;

  // Get pending token
  const pending = await (db as any).adIntegration.findUnique({
    where: { shop_platform: { shop: session.shop, platform: "meta_pending" } },
  });

  if (!pending) return redirect("/app/settings?error=session_expired");

  // Save real integration
  await (db as any).adIntegration.upsert({
    where: { shop_platform: { shop: session.shop, platform: "meta" } },
    update: {
      accessToken: pending.accessToken,
      accountId,
      accountName,
      isActive: true,
    },
    create: {
      shop: session.shop,
      platform: "meta",
      accessToken: pending.accessToken,
      accountId,
      accountName,
      isActive: true,
    },
  });

  // Clean up pending
  await (db as any).adIntegration.delete({
    where: { shop_platform: { shop: session.shop, platform: "meta_pending" } },
  });

  console.log(`[Meta OAuth] Account selected for ${session.shop}: ${accountName}`);

  return redirect("/app/settings?success=meta_connected");
};

export default function MetaSelectAccount() {
  const { accounts } = useLoaderData() as { accounts: AdAccount[] };
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <Page
      title="Select Meta Ad Account"
      backAction={{ content: "Settings", url: "/app/settings" }}
    >
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <BlockStack gap="0">
              <ResourceList
                resourceName={{ singular: "ad account", plural: "ad accounts" }}
                items={accounts}
                renderItem={(account: AdAccount) => (
                  <ResourceItem
                    id={account.id}
                    onClick={() => {}}
                    accessibilityLabel={account.name}
                  >
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text variant="bodyMd" fontWeight="semibold" as="p">
                          {account.name}
                        </Text>
                        <Text variant="bodySm" as="p" tone="subdued">
                          {account.id} · {account.currency}
                        </Text>
                      </BlockStack>
                      <Button
                        variant="primary"
                        size="slim"
                        loading={isSubmitting}
                        onClick={() =>
                          submit(
                            { accountId: account.id, accountName: account.name },
                            { method: "POST" }
                          )
                        }
                      >
                        Select
                      </Button>
                    </InlineStack>
                  </ResourceItem>
                )}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
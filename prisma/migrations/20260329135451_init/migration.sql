-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "paymentGateway" TEXT NOT NULL DEFAULT 'shopify_payments',
    "transactionFeePercent" DOUBLE PRECISION NOT NULL DEFAULT 2.9,
    "transactionFeeFixed" DOUBLE PRECISION NOT NULL DEFAULT 0.30,
    "shopifyExtraFeePercent" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "shippingMode" TEXT NOT NULL DEFAULT 'fixed',
    "defaultShippingCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "alertEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertMarginThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "alertProfitThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "holdEnabled" BOOLEAN NOT NULL DEFAULT false,
    "holdMarginThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "alertEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderName" TEXT NOT NULL,
    "totalPrice" DOUBLE PRECISION NOT NULL,
    "subtotalPrice" DOUBLE PRECISION NOT NULL,
    "totalTax" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalDiscounts" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "shippingRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "cogs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "transactionFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "shippingCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grossProfit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netProfit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "marginPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isHeld" BOOLEAN NOT NULL DEFAULT false,
    "heldReason" TEXT,
    "alertSent" BOOLEAN NOT NULL DEFAULT false,
    "cogsComplete" BOOLEAN NOT NULL DEFAULT true,
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "shopifyCreatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopifyVariantId" TEXT,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "quantity" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cogs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cogsFound" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyInventoryItemId" TEXT,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "costPerItem" DOUBLE PRECISION,
    "customCost" DOUBLE PRECISION,
    "effectiveCost" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shop_key" ON "Shop"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shop_shopifyOrderId_key" ON "Order"("shop", "shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_shop_shopifyProductId_key" ON "Product"("shop", "shopifyProductId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_productId_shopifyVariantId_key" ON "ProductVariant"("productId", "shopifyVariantId");

-- AddForeignKey
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("shop") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("shop") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("shop") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("shop") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

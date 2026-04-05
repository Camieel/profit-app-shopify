-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "adSpendAllocated" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "onboardingComplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paymentGateways" TEXT,
ADD COLUMN     "shippingRules" TEXT;

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "interval" TEXT NOT NULL DEFAULT 'monthly',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdIntegration" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdSpend" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdSpend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdIntegration_shop_platform_key" ON "AdIntegration"("shop", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "AdSpend_shop_platform_date_key" ON "AdSpend"("shop", "platform", "date");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("shop") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdIntegration" ADD CONSTRAINT "AdIntegration_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("shop") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSpend" ADD CONSTRAINT "AdSpend_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("shop") ON DELETE RESTRICT ON UPDATE CASCADE;

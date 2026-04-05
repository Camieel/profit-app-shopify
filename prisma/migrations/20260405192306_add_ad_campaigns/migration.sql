-- CreateTable
CREATE TABLE "AdCampaign" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignName" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdCampaign_shop_platform_date_idx" ON "AdCampaign"("shop", "platform", "date");

-- CreateIndex
CREATE INDEX "AdCampaign_shop_date_idx" ON "AdCampaign"("shop", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AdCampaign_shop_platform_campaignId_date_key" ON "AdCampaign"("shop", "platform", "campaignId", "date");

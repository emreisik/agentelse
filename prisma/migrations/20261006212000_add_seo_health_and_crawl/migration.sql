-- CreateTable
CREATE TABLE "SeoSite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "scope" JSONB,
    "scopeKey" TEXT,
    "origin" TEXT,
    "verifyToken" TEXT,
    "verifiedDomain" TEXT,
    "verifyMethod" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifyCheckedAt" TIMESTAMP(3),
    "verifyFailures" INTEGER NOT NULL DEFAULT 0,
    "settings" JSONB,
    "robotsStatus" INTEGER,
    "robotsVerdict" TEXT,
    "robotsHash" TEXT,
    "robotsBody" TEXT,
    "robotsPrevBody" TEXT,
    "robotsFetchedAt" TIMESTAMP(3),
    "robotsChangedAt" TIMESTAMP(3),
    "robotsFailures" INTEGER NOT NULL DEFAULT 0,
    "robotsRetryAt" TIMESTAMP(3),
    "httpRedirectsToHttps" BOOLEAN,
    "httpCheckedAt" TIMESTAMP(3),
    "sitemaps" JSONB,
    "sitemapsCheckedAt" TIMESTAMP(3),
    "sitemapBaselineAt" TIMESTAMP(3),
    "gscSitemapsAt" TIMESTAMP(3),
    "gscSitemapsNextAt" TIMESTAMP(3),
    "crawlLeaseUntil" TIMESTAMP(3),
    "crawlLeaseOwner" TEXT,
    "crawlNextAt" TIMESTAMP(3),
    "crawlPausedUntil" TIMESTAMP(3),
    "crawlThrottles" INTEGER NOT NULL DEFAULT 0,
    "crawlBlocked" BOOLEAN NOT NULL DEFAULT false,
    "fullCrawlDueAt" TIMESTAMP(3),
    "lastFullCrawlAt" TIMESTAMP(3),
    "regressionDueAt" TIMESTAMP(3),
    "lastRegressionAt" TIMESTAMP(3),
    "lastCrawlError" TEXT,
    "inspectDay" TEXT,
    "inspectCount" INTEGER NOT NULL DEFAULT 0,
    "inspectBudget" INTEGER NOT NULL DEFAULT 200,
    "inspectNextAt" TIMESTAMP(3),
    "inspectLastRunAt" TIMESTAMP(3),
    "inspectPausedUntil" TIMESTAMP(3),
    "inspectQueue" JSONB,
    "cwvCheckedAt" TIMESTAMP(3),
    "healthScore" INTEGER,
    "healthParts" JSONB,
    "healthComputedAt" TIMESTAMP(3),
    "healthDueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoCrawl" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "notModified" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "budget" INTEGER NOT NULL,
    "robotsHash" TEXT,
    "frontier" JSONB,
    "stats" JSONB,

    CONSTRAINT "SeoCrawl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoPage" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "urlHash" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "discoveredVia" TEXT NOT NULL,
    "lastCrawlId" TEXT,
    "status" INTEGER,
    "fetchError" TEXT,
    "contentType" TEXT,
    "finalUrl" TEXT,
    "redirectChain" JSONB,
    "robotsBlocked" BOOLEAN NOT NULL DEFAULT false,
    "canonical" TEXT,
    "robotsMeta" TEXT,
    "xRobotsTag" TEXT,
    "noindex" BOOLEAN NOT NULL DEFAULT false,
    "indexable" BOOLEAN,
    "title" TEXT,
    "metaDescription" TEXT,
    "h1" TEXT,
    "headings" JSONB,
    "lang" TEXT,
    "hreflang" JSONB,
    "schemaTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "schemaErrors" JSONB,
    "openGraph" JSONB,
    "assets" JSONB,
    "wordCount" INTEGER,
    "textHash" TEXT,
    "textSimhash" TEXT,
    "contentHash" TEXT,
    "inlinks" INTEGER NOT NULL DEFAULT 0,
    "outlinks" INTEGER NOT NULL DEFAULT 0,
    "depth" INTEGER,
    "imagesNoAlt" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER,
    "ttfbMs" INTEGER,
    "renderRisk" BOOLEAN NOT NULL DEFAULT false,
    "mixedContent" INTEGER NOT NULL DEFAULT 0,
    "etag" TEXT,
    "lastModified" TEXT,
    "issues" JSONB,
    "previous" JSONB,
    "lastGood" JSONB,
    "inSitemap" BOOLEAN NOT NULL DEFAULT false,
    "sitemapLastmod" TIMESTAMP(3),
    "sitemapFirstSeenAt" TIMESTAMP(3),
    "sitemapLastSeenAt" TIMESTAMP(3),
    "lastCrawledAt" TIMESTAMP(3),
    "lastChangedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "goneAt" TIMESTAMP(3),

    CONSTRAINT "SeoPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoLink" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fromPageId" TEXT NOT NULL,
    "toUrl" TEXT NOT NULL,
    "toUrlHash" TEXT NOT NULL,
    "anchor" TEXT,
    "nofollow" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SeoLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoCwv" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "formFactor" TEXT NOT NULL,
    "collectionPeriod" TEXT NOT NULL,
    "periodEnd" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "lcpP75" DOUBLE PRECISION,
    "inpP75" DOUBLE PRECISION,
    "clsP75" DOUBLE PRECISION,
    "fcpP75" DOUBLE PRECISION,
    "ttfbP75" DOUBLE PRECISION,
    "histogram" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoCwv_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchUpdate" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "url" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscUrlInspection" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "urlHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "inspectedAt" TIMESTAMP(3) NOT NULL,
    "inspectCount" INTEGER NOT NULL DEFAULT 1,
    "verdict" TEXT,
    "coverageState" TEXT,
    "indexingState" TEXT,
    "robotsTxtState" TEXT,
    "pageFetchState" TEXT,
    "googleCanonical" TEXT,
    "userCanonical" TEXT,
    "lastCrawlTime" TIMESTAMP(3),
    "crawledAs" TEXT,
    "sitemaps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "referringUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "richResults" JSONB,
    "previous" JSONB,
    "verdictChangedAt" TIMESTAMP(3),
    "sampleWeek" TEXT,

    CONSTRAINT "GscUrlInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscSitemap" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "type" TEXT,
    "isIndex" BOOLEAN NOT NULL DEFAULT false,
    "isPending" BOOLEAN NOT NULL DEFAULT false,
    "lastSubmitted" TIMESTAMP(3),
    "lastDownloaded" TIMESTAMP(3),
    "errors" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "submittedCount" INTEGER NOT NULL DEFAULT 0,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GscSitemap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscCoverageWeek" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "sampled" INTEGER NOT NULL,
    "indexed" INTEGER NOT NULL,
    "crawledNotIndexed" INTEGER NOT NULL,
    "point" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "population" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GscCoverageWeek_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeoSite_isMock_crawlNextAt_idx" ON "SeoSite"("isMock", "crawlNextAt");

-- CreateIndex
CREATE INDEX "SeoSite_isMock_inspectNextAt_idx" ON "SeoSite"("isMock", "inspectNextAt");

-- CreateIndex
CREATE INDEX "SeoSite_isMock_gscSitemapsNextAt_idx" ON "SeoSite"("isMock", "gscSitemapsNextAt");

-- CreateIndex
CREATE INDEX "SeoSite_isMock_healthDueAt_idx" ON "SeoSite"("isMock", "healthDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "SeoSite_projectId_isMock_key" ON "SeoSite"("projectId", "isMock");

-- CreateIndex
CREATE INDEX "SeoCrawl_projectId_startedAt_idx" ON "SeoCrawl"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "SeoCrawl_siteId_kind_status_idx" ON "SeoCrawl"("siteId", "kind", "status");

-- CreateIndex
CREATE INDEX "SeoPage_projectId_idx" ON "SeoPage"("projectId");

-- CreateIndex
CREATE INDEX "SeoPage_siteId_lastCrawlId_idx" ON "SeoPage"("siteId", "lastCrawlId");

-- CreateIndex
CREATE INDEX "SeoPage_siteId_inSitemap_idx" ON "SeoPage"("siteId", "inSitemap");

-- CreateIndex
CREATE UNIQUE INDEX "SeoPage_siteId_urlHash_key" ON "SeoPage"("siteId", "urlHash");

-- CreateIndex
CREATE INDEX "SeoLink_siteId_toUrlHash_idx" ON "SeoLink"("siteId", "toUrlHash");

-- CreateIndex
CREATE INDEX "SeoLink_fromPageId_idx" ON "SeoLink"("fromPageId");

-- CreateIndex
CREATE INDEX "SeoLink_projectId_idx" ON "SeoLink"("projectId");

-- CreateIndex
CREATE INDEX "SeoCwv_projectId_periodEnd_idx" ON "SeoCwv"("projectId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "SeoCwv_siteId_scope_target_formFactor_collectionPeriod_key" ON "SeoCwv"("siteId", "scope", "target", "formFactor", "collectionPeriod");

-- CreateIndex
CREATE UNIQUE INDEX "SearchUpdate_externalId_key" ON "SearchUpdate"("externalId");

-- CreateIndex
CREATE INDEX "SearchUpdate_startedAt_idx" ON "SearchUpdate"("startedAt");

-- CreateIndex
CREATE INDEX "GscUrlInspection_linkId_inspectedAt_idx" ON "GscUrlInspection"("linkId", "inspectedAt");

-- CreateIndex
CREATE INDEX "GscUrlInspection_linkId_sampleWeek_idx" ON "GscUrlInspection"("linkId", "sampleWeek");

-- CreateIndex
CREATE INDEX "GscUrlInspection_projectId_idx" ON "GscUrlInspection"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "GscUrlInspection_linkId_urlHash_key" ON "GscUrlInspection"("linkId", "urlHash");

-- CreateIndex
CREATE INDEX "GscSitemap_projectId_idx" ON "GscSitemap"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "GscSitemap_linkId_path_key" ON "GscSitemap"("linkId", "path");

-- CreateIndex
CREATE INDEX "GscCoverageWeek_projectId_idx" ON "GscCoverageWeek"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "GscCoverageWeek_linkId_weekStart_key" ON "GscCoverageWeek"("linkId", "weekStart");

-- AddForeignKey
ALTER TABLE "SeoCrawl" ADD CONSTRAINT "SeoCrawl_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "SeoSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoPage" ADD CONSTRAINT "SeoPage_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "SeoSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoLink" ADD CONSTRAINT "SeoLink_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "SeoSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoLink" ADD CONSTRAINT "SeoLink_fromPageId_fkey" FOREIGN KEY ("fromPageId") REFERENCES "SeoPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoCwv" ADD CONSTRAINT "SeoCwv_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "SeoSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscUrlInspection" ADD CONSTRAINT "GscUrlInspection_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscSitemap" ADD CONSTRAINT "GscSitemap_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscCoverageWeek" ADD CONSTRAINT "GscCoverageWeek_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;


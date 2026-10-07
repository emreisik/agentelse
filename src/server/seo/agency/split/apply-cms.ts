import "server-only";

import type { GscSplitTest, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { SPLIT_CMS_MAX_ARM } from "@/lib/seo/agency/split/assign";
import { applyTitlePattern, sameSite } from "@/lib/seo/agency/split/patterns";
import { parseSplitChange } from "@/lib/seo/agency/split/types";
import { loadApplyReady } from "@/server/seo/apply/offers";
import { proposeSeoChange } from "@/server/seo/apply/propose";
import { readCrawledPage } from "@/server/seo/actions/page-check";

import { changeIdsOf } from "./cms-items";
import { splitSiteScope } from "./population";

// Bölünmüş testin CMS yolu (SC-F8 üzerinden). SC-F8 kodunu içe aktaran TEK
// dosyadır. Yalnız TITLE_META testi, yalnız BİRİNCİL bağ ve en çok
// SPLIT_CMS_MAX_ARM sayfalı test kolu için; her sayfa için ayrı SeoChange +
// onay açılır, WordPress'e hiçbir yerden doğrudan yazılmaz. SC-F8'in günlük
// yazma sınırı büyük kolları günlere yayar. Bayrak (SEO_APPLY) kapalıyken
// loadApplyReady veritabanı okumadan false döner ve bu dosya sorgusuzdur.

const TITLE_MAX = 70;
const META_MAX = 160;
const NO_LIMIT = 10_000;
const CHANGE_STATUS_FAILED = new Set([
  "REJECTED",
  "EXPIRED",
  "FAILED",
  "UNDONE",
]);

export type CmsSkipReason =
  "NO_TITLE" | "TOO_LONG" | "REFUSED" | "OUT_OF_SCOPE" | "FAILED";
export type CmsItem = {
  pageId: string;
  changeId: string | null;
  skipped: CmsSkipReason | null;
};

// CMS düğmesi için: hazır mı (tek çağrı, liste başına bir kez).
export async function splitCmsReady(projectId: string): Promise<boolean> {
  return loadApplyReady(projectId);
}

type PatternContext = {
  title: string | null;
  h1: string | null;
  site: string;
  year: number;
};

// Desen null döndürdüyse neden: gereken belirteç boş mu, sonuç mu uzun.
function skipReasonOf(pattern: string, ctx: PatternContext): CmsSkipReason {
  return applyTitlePattern(pattern, ctx, NO_LIMIT) === null
    ? "NO_TITLE"
    : "TOO_LONG";
}

function siteNameOf(hosts: readonly string[]): string {
  const host = hosts[0] ?? "";
  return host.startsWith("www.") ? host.slice(4) : host;
}

export async function proposeSplitChanges(input: {
  projectId: string;
  userId: string;
  test: GscSplitTest;
  now: Date;
}): Promise<{ proposed: number; skipped: number; items: CmsItem[] }> {
  const { projectId, userId, test, now } = input;
  const none = { proposed: 0, skipped: 0, items: [] };
  if (test.changeKind !== "TITLE_META" || test.status !== "DRAFT") return none;
  if (test.testPages > SPLIT_CMS_MAX_ARM) return none;
  const change = parseSplitChange(test.change);
  if (!change.titlePattern && !change.metaPattern) return none;
  if (!(await loadApplyReady(projectId))) return none;

  const link = await prisma.gscSiteLink.findUnique({
    where: { id: test.linkId },
    select: { isPrimary: true, isSecondary: true },
  });
  if (!link || !link.isPrimary || link.isSecondary) return none;

  const scope = await splitSiteScope(projectId);
  const assigned = await prisma.gscSplitTestPage.findMany({
    where: { testId: test.id, arm: "TEST" },
    select: { pageId: true },
    orderBy: { pageId: "asc" },
    take: SPLIT_CMS_MAX_ARM + 1,
  });
  if (assigned.length > SPLIT_CMS_MAX_ARM) return none;
  const pages = await prisma.gscPage.findMany({
    where: {
      id: { in: assigned.map((row) => row.pageId) },
      linkId: test.linkId,
    },
    select: { id: true, url: true },
  });
  const urlOf = new Map(pages.map((page) => [page.id, page.url]));

  const site = scope ? siteNameOf(scope.hosts) : "";
  const items: CmsItem[] = [];
  for (const { pageId } of assigned) {
    const url = urlOf.get(pageId);
    const skip = (skipped: CmsSkipReason) =>
      items.push({ pageId, changeId: null, skipped });
    if (!url || !scope || !sameSite(url, scope.hosts)) {
      skip("OUT_OF_SCOPE");
      continue;
    }
    let crawled: Awaited<ReturnType<typeof readCrawledPage>> = null;
    try {
      crawled = await readCrawledPage(scope.siteId, url);
    } catch {
      crawled = null;
    }
    const ctx: PatternContext = {
      title: crawled?.snapshot.title ?? null,
      h1: crawled?.snapshot.h1 ?? null,
      site,
      year: now.getUTCFullYear(),
    };
    const title = change.titlePattern
      ? applyTitlePattern(change.titlePattern, ctx, TITLE_MAX)
      : null;
    const meta = change.metaPattern
      ? applyTitlePattern(change.metaPattern, ctx, META_MAX)
      : null;
    if (change.titlePattern && title === null) {
      skip(skipReasonOf(change.titlePattern, ctx));
      continue;
    }
    if (change.metaPattern && meta === null) {
      skip(skipReasonOf(change.metaPattern, ctx));
      continue;
    }
    try {
      const result = await proposeSeoChange({
        projectId,
        userId,
        kind: "TITLE_META",
        url,
        title,
        metaDescription: meta,
      });
      if (result.ok) {
        items.push({ pageId, changeId: result.changeId, skipped: null });
      } else {
        skip("REFUSED");
      }
    } catch {
      skip("REFUSED");
    }
  }

  const proposed = items.filter((item) => item.changeId !== null).length;
  const skipped = items.length - proposed;
  // Hiç öneri açılamadıysa test taslak kalır; kullanıcı elle uygulayabilir.
  if (proposed > 0) {
    const moved = await prisma.gscSplitTest.updateMany({
      where: { id: test.id, status: "DRAFT" },
      data: {
        cmsChanges: { v: 1, items } as unknown as Prisma.InputJsonValue,
        appliedVia: "CMS",
        status: "APPLIED",
        appliedAt: now,
        appliedByUserId: userId,
        nextCheckAt: new Date(now.getTime() + 3_600_000),
      },
    });
    if (moved.count !== 1) return { proposed: 0, skipped: items.length, items };
  }
  return { proposed, skipped, items };
}

export async function syncCmsChanges(
  test: GscSplitTest,
  now: Date,
): Promise<{
  total: number;
  verified: number;
  failed: number;
  waiting: number;
  failedIds: string[];
  allVerifiedAt: Date | null;
}> {
  // now imza uyumu içindir; durum satırlardan okunur, zamana bağlı karar yok.
  void now;
  const ids = changeIdsOf(test.cmsChanges);
  const total = ids.length;
  if (total === 0) {
    return {
      total: 0,
      verified: 0,
      failed: 0,
      waiting: 0,
      failedIds: [],
      allVerifiedAt: null,
    };
  }
  let rows: { id: string; status: string; verifiedAt: Date | null }[];
  try {
    rows = await prisma.seoChange.findMany({
      where: { id: { in: ids }, projectId: test.projectId },
      select: { id: true, status: true, verifiedAt: true },
    });
  } catch {
    // Tablo yoksa ya da okunamıyorsa CMS verisi yok sayılır; test APPLIED kalır.
    return {
      total,
      verified: 0,
      failed: 0,
      waiting: total,
      failedIds: [],
      allVerifiedAt: null,
    };
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  let verified = 0;
  const failedIds: string[] = [];
  let latest: Date | null = null;
  for (const id of ids) {
    const row = byId.get(id);
    // Satır silinmişse değişiklik yapılamaz.
    if (!row || CHANGE_STATUS_FAILED.has(row.status)) {
      failedIds.push(id);
    } else if (row.status === "VERIFIED") {
      verified += 1;
      if (row.verifiedAt && (!latest || row.verifiedAt > latest)) {
        latest = row.verifiedAt;
      }
    }
  }
  const failed = failedIds.length;
  const waiting = total - verified - failed;
  return {
    total,
    verified,
    failed,
    waiting,
    failedIds,
    // Bekleyen kalmadıysa son doğrulama anı (başarısızlar ölçümü engellemez).
    allVerifiedAt: waiting === 0 ? latest : null,
  };
}

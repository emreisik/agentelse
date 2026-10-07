import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { gscAgencyActiveFor, gscAgencyOn } from "@/lib/seo/agency/flags";
import {
  EMPTY_PAGE_GROUP_RULES,
  groupFor,
  parsePageGroupRules,
  previewGroups,
  type PageGroupPreview,
  type PageGroupRules,
} from "@/lib/seo/agency/page-groups";
import { gscRestrictedProjects, gscSyncAllowedFor } from "@/lib/seo/flags";
import { prisma } from "@/lib/prisma";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

// Sayfa grubu kuralları (SC-F9, docs/search-agency.md): kurallar site başına
// GscSiteSetting'te durur ve İKİ yerde uygulanır: (1) ekleme anında
// (upsertPages yeni sayfaya kuralın grubunu verir; API ve BigQuery yazımları
// doğru grupla doğar), (2) kural değişince mevcut GscPage.pageGroup'u yeniden
// yazan, kaldığı yerden devam eden iş. Kural düzenlemesi eski sayfalara birkaç
// dakikada yansır; bu aralıkta bulgular karışık grup görebilir (belgelenmiş).

export type PageGroupState = {
  rules: PageGroupRules;
  version: number;
  appliedVersion: number;
  applying: boolean;
  appliedWeek: string | null;
};

const EMPTY_STATE: PageGroupState = {
  rules: EMPTY_PAGE_GROUP_RULES,
  version: 0,
  appliedVersion: 0,
  applying: false,
  appliedWeek: null,
};

const MEMO_TTL_MS = 30_000;
const MEMO_MAX = 2_000;
const LEASE_MS = 5 * 60_000;
const READ_BATCH = 2_000;
const WRITE_BATCH = 1_000;
const PREVIEW_PAGES = 5_000;
const DEFAULT_BUDGET_MS = 20_000;
// Yeni bağ başlatılırken kalması gereken en az süre.
const MIN_LINK_BUDGET_MS = 2_000;

// Ekleme anı okuması için süreç içi 30 sn'lik not defteri; save() aynı
// süreçte siler (başka süreçler en geç 30 sn sonra görür).
const memo = new Map<string, { rules: PageGroupRules | null; at: number }>();

// upsertPages: yeni sayfalar doğru grupla eklensin. Bayrak kapalıyken veritabanına
// hiç gidilmez; kural yoksa null (çağıran normalizePageUrl().pageGroup'u korur).
export async function pageGroupRulesForLink(link: {
  id: string;
  projectId: string;
  siteUrl: string;
  isMock: boolean;
}): Promise<PageGroupRules | null> {
  if (!gscAgencyOn()) return null;
  const cached = memo.get(link.id);
  if (cached && Date.now() - cached.at < MEMO_TTL_MS) return cached.rules;
  const setting = await prisma.gscSiteSetting.findUnique({
    where: {
      projectId_siteUrl: { projectId: link.projectId, siteUrl: link.siteUrl },
    },
    select: { isMock: true, pageGroupRules: true },
  });
  const parsed =
    setting && setting.isMock === link.isMock
      ? parsePageGroupRules(setting.pageGroupRules)
      : null;
  const rules = parsed && parsed.rules.length > 0 ? parsed : null;
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(link.id, { rules, at: Date.now() });
  return rules;
}

function logFailure(scope: string, error: unknown): void {
  console.error(
    `[gsc-page-groups] ${scope} failed:`,
    error instanceof Error ? error.name : "error",
  );
}

async function read(
  projectId: string,
  siteUrl: string,
): Promise<PageGroupState> {
  if (!gscAgencyActiveFor(projectId)) return EMPTY_STATE;
  const setting = await prisma.gscSiteSetting.findUnique({
    where: { projectId_siteUrl: { projectId, siteUrl } },
    select: {
      isMock: true,
      pageGroupRules: true,
      rulesVersion: true,
      groupsAppliedVersion: true,
      groupsAppliedWeek: true,
    },
  });
  if (!setting || setting.isMock !== gscMockMode()) return EMPTY_STATE;
  return {
    rules: parsePageGroupRules(setting.pageGroupRules),
    version: setting.rulesVersion,
    appliedVersion: setting.groupsAppliedVersion,
    applying: setting.rulesVersion !== setting.groupsAppliedVersion,
    appliedWeek: setting.groupsAppliedWeek,
  };
}

async function listGroups(
  linkId: string,
  limit = 50,
): Promise<{ group: string; pages: number }[]> {
  const rows = await prisma.gscPage.groupBy({
    by: ["pageGroup"],
    where: { linkId, pageGroup: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { pageGroup: "desc" } },
    take: limit,
  });
  return rows.flatMap((row) =>
    row.pageGroup ? [{ group: row.pageGroup, pages: row._count._all }] : [],
  );
}

async function preview(input: {
  linkId: string;
  rules: PageGroupRules;
}): Promise<PageGroupPreview> {
  const pages = await prisma.gscPage.findMany({
    where: { linkId: input.linkId },
    select: { path: true, pageGroup: true },
    orderBy: [{ lastSeenWeek: "desc" }, { id: "asc" }],
    take: PREVIEW_PAGES,
  });
  return previewGroups(
    input.rules,
    pages.map((page) => ({ path: page.path, currentGroup: page.pageGroup })),
  );
}

async function save(input: {
  projectId: string;
  linkId: string;
  rules: PageGroupRules;
  userId: string;
}): Promise<{ ok: true; version: number } | { ok: false; message: string }> {
  const { projectId, linkId, rules, userId } = input;
  if (!gscAgencyActiveFor(projectId)) {
    return { ok: false, message: "Not available" };
  }
  const mock = gscMockMode();
  const link = await prisma.gscSiteLink.findFirst({
    where: {
      id: linkId,
      projectId,
      isMock: mock,
      OR: [{ isPrimary: true }, { isSecondary: true }],
    },
    select: { id: true, workspaceId: true, siteUrl: true },
  });
  if (!link) return { ok: false, message: "Site not found" };
  const existing = await prisma.gscSiteSetting.findUnique({
    where: { projectId_siteUrl: { projectId, siteUrl: link.siteUrl } },
    select: { id: true, isMock: true },
  });
  if (existing && existing.isMock !== mock) {
    return { ok: false, message: "This site already exists in another mode." };
  }
  const json = rules as unknown as Prisma.InputJsonValue;
  let version: number;
  try {
    if (existing) {
      const updated = await prisma.gscSiteSetting.update({
        where: { id: existing.id },
        data: {
          pageGroupRules: json,
          rulesVersion: { increment: 1 },
          groupsCursor: null,
        },
        select: { rulesVersion: true },
      });
      version = updated.rulesVersion;
    } else {
      const created = await prisma.gscSiteSetting.create({
        data: {
          workspaceId: link.workspaceId,
          projectId,
          siteUrl: link.siteUrl,
          isMock: mock,
          pageGroupRules: json,
          rulesVersion: 1,
        },
        select: { rulesVersion: true },
      });
      version = created.rulesVersion;
    }
  } catch (error) {
    logFailure("save", error);
    return { ok: false, message: "The rules couldn't be saved." };
  }
  memo.delete(link.id);
  try {
    await AuditLogRepository.record({
      workspaceId: link.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "gsc_page_groups.saved",
      entityType: "GscSiteSetting",
      entityId: link.id,
      metadata: { linkId: link.id, version },
    });
  } catch (error) {
    logFailure("audit", error);
  }
  return { ok: true, version };
}

// Mevcut sayfaları kurallara göre yeniden gruplar. Kilit (5 dk, CAS), anahtarlı
// sayfalama (id > imleç), yalnız değişen satırlar, 1000'lik tek UPDATE. İmleç
// ve bitiş yazımı başladığı kural sürümüne bağlıdır: pass sırasında save()
// sürümü artırırsa pass kendi partisini bitirir, geriye yazamaz ve bir sonraki
// regroupDue baştan başlar.
async function regroupLink(
  linkId: string,
  options: { budgetMs?: number; now?: Date } = {},
): Promise<{ updated: number; done: boolean }> {
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const now = options.now ?? new Date();
  const link = await prisma.gscSiteLink.findUnique({
    where: { id: linkId },
    select: {
      id: true,
      projectId: true,
      siteUrl: true,
      isMock: true,
      lastWeeklyWeek: true,
    },
  });
  if (!link) return { updated: 0, done: true };
  const setting = await prisma.gscSiteSetting.findUnique({
    where: {
      projectId_siteUrl: { projectId: link.projectId, siteUrl: link.siteUrl },
    },
    select: {
      id: true,
      isMock: true,
      pageGroupRules: true,
      rulesVersion: true,
      groupsCursor: true,
      groupsLeaseUntil: true,
    },
  });
  if (!setting || setting.isMock !== link.isMock) {
    return { updated: 0, done: true };
  }
  if (setting.groupsLeaseUntil && setting.groupsLeaseUntil > now) {
    return { updated: 0, done: false };
  }

  const owner = randomUUID();
  const claimed = await prisma.gscSiteSetting.updateMany({
    where: {
      id: setting.id,
      OR: [{ groupsLeaseUntil: null }, { groupsLeaseUntil: { lt: now } }],
    },
    data: {
      groupsLeaseUntil: new Date(now.getTime() + LEASE_MS),
      groupsLeaseOwner: owner,
    },
  });
  if (claimed.count === 0) return { updated: 0, done: false };

  const rules = parsePageGroupRules(setting.pageGroupRules);
  const version = setting.rulesVersion;
  let cursor = setting.groupsCursor;
  let updated = 0;
  const release = () =>
    prisma.gscSiteSetting.updateMany({
      where: { id: setting.id, groupsLeaseOwner: owner },
      data: { groupsLeaseUntil: null, groupsLeaseOwner: null },
    });

  try {
    for (;;) {
      if (Date.now() - startedAt >= budgetMs) {
        await release();
        return { updated, done: false };
      }
      const pages = await prisma.gscPage.findMany({
        where: { linkId, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: "asc" },
        take: READ_BATCH,
        select: { id: true, path: true, pageGroup: true },
      });
      const changes: [string, string][] = [];
      for (const page of pages) {
        const group = groupFor(rules, page.path);
        if (group !== page.pageGroup) changes.push([page.id, group]);
      }
      for (let at = 0; at < changes.length; at += WRITE_BATCH) {
        const values = changes
          .slice(at, at + WRITE_BATCH)
          .map(([id, group]) => Prisma.sql`(${id}::text, ${group}::text)`);
        await prisma.$executeRaw`
          UPDATE "GscPage" AS p
             SET "pageGroup" = v."g"
            FROM (VALUES ${Prisma.join(values)}) AS v("id", "g")
           WHERE p."id" = v."id"
             AND p."linkId" = ${linkId}
        `;
      }
      updated += changes.length;
      if (pages.length === 0) break;
      cursor = pages[pages.length - 1]?.id ?? cursor;
      // İmleç yalnız kural sürümü ve kilit hâlâ bizimse ilerler.
      const advanced = await prisma.gscSiteSetting.updateMany({
        where: {
          id: setting.id,
          groupsLeaseOwner: owner,
          rulesVersion: version,
        },
        data: { groupsCursor: cursor },
      });
      if (advanced.count === 0) {
        await release();
        return { updated, done: false };
      }
      if (pages.length < READ_BATCH) break;
    }
    const finished = await prisma.gscSiteSetting.updateMany({
      where: { id: setting.id, groupsLeaseOwner: owner, rulesVersion: version },
      data: {
        groupsAppliedVersion: version,
        groupsAppliedWeek: link.lastWeeklyWeek,
        groupsCursor: null,
        groupsLeaseUntil: null,
        groupsLeaseOwner: null,
      },
    });
    if (finished.count === 0) {
      await release();
      return { updated, done: false };
    }
    return { updated, done: true };
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}

type DueRow = { linkId: string; projectId: string };

// Tick: kural sürümü uygulanandan farklı olan (ya da kuralı olan sitede yeni
// haftalık veri geldiği için güvenlik ağı olarak bir kez daha bakılması
// gereken) ayarlar. Yeni bağ başlatmadan önce son tarih kontrol edilir.
async function regroupDue(
  limit = 2,
  now: Date = new Date(),
  deadlineAt?: number,
): Promise<number> {
  if (!gscAgencyOn()) return 0;
  const restricted = gscRestrictedProjects();
  if (restricted && restricted.length === 0) return 0;
  const mock = gscMockMode();
  const scope = restricted
    ? Prisma.sql`AND s."projectId" = ANY(${restricted}::text[])`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<DueRow[]>`
    SELECT l."id" AS "linkId", s."projectId" AS "projectId"
      FROM "GscSiteSetting" s
      JOIN "GscSiteLink" l
        ON l."projectId" = s."projectId"
       AND l."siteUrl" = s."siteUrl"
       AND l."isMock" = s."isMock"
     WHERE s."isMock" = ${mock}
       AND (l."isPrimary" OR l."isSecondary")
       AND (s."groupsLeaseUntil" IS NULL OR s."groupsLeaseUntil" < ${now})
       AND (
         s."rulesVersion" <> s."groupsAppliedVersion"
         OR (
           jsonb_array_length(COALESCE(s."pageGroupRules"->'rules', '[]'::jsonb)) > 0
           AND s."groupsAppliedWeek" IS DISTINCT FROM l."lastWeeklyWeek"
         )
       )
       ${scope}
     ORDER BY s."updatedAt" ASC
     LIMIT ${limit * 5}
  `;
  let handled = 0;
  for (const row of rows) {
    if (handled >= limit) break;
    if (!gscSyncAllowedFor(row.projectId)) continue;
    const remaining =
      deadlineAt === undefined ? DEFAULT_BUDGET_MS : deadlineAt - Date.now();
    if (remaining < MIN_LINK_BUDGET_MS) break;
    try {
      await regroupLink(row.linkId, {
        budgetMs: Math.min(DEFAULT_BUDGET_MS, remaining),
        now,
      });
    } catch (error) {
      logFailure("regroup", error);
    }
    handled += 1;
  }
  return handled;
}

export const GscPageGroups = {
  read,
  listGroups,
  preview,
  save,
  regroupLink,
  regroupDue,
};

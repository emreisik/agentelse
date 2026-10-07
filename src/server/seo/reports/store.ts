import "server-only";

import {
  Prisma,
  type GscSiteLink,
  type SeoReportState,
} from "@prisma/client";

import { readSummary, type ReportSummary } from "@/lib/module-flows/analytics/report";
import { prisma } from "@/lib/prisma";
import { dateToDayKey } from "@/lib/seo/dates";
import { seoContentPlanActiveFor } from "@/lib/seo/content-plan/flags";
import { GscFlags } from "@/lib/seo/flags";
import {
  SeoInsightFlags,
  seoInsightsAllowedFor,
} from "@/lib/seo/insight-flags";
import { isSeoReportKind, type SeoReportKind } from "@/lib/seo/reports/types";
import type {
  SeoReportListItem,
  SeoReportSnapshot,
  SeoReportView,
} from "@/lib/seo/reports/types";
import { readSeoReportSnapshot } from "@/lib/seo/reports/snapshot";
import { monthLabel, periodLabel } from "@/lib/seo/reports/text";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { seoChatHref } from "./chat";

// SEO raporlarının deposu (docs/search-reports.md "Depo"). DEĞİŞMEZLİK
// KURALI: SeoReport satırı yazıldıktan sonra hiçbir alanı değişmez; bu
// dosyada insertSeoReport tek yazıcıdır ve update / upsert yoktur. Sonradan
// gelen GSC/GA düzeltmeleri gönderilmiş raporu değiştirmez. Tek izinli değişiklik
// silmedir (GscSiteLink cascade'i ve SeoReportRetention). Rapor durumu
// (SeoReportState) ise zamanlayıcının çalışma belleğidir ve güncellenir.

export const REPORT_LEASE_MS = 600_000;

const PULSE_VISIBLE_DAYS = 14;
const DAY_MS = 86_400_000;
const DEFAULT_LIST_LIMIT = 40;

type LinkRef = Pick<GscSiteLink, "id" | "projectId" | "workspaceId" | "isMock">;

function prismaCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

// ---------------------------------------------------------------------------
// Rapor durumu ve kilit
// ---------------------------------------------------------------------------

export async function ensureReportState(link: LinkRef): Promise<SeoReportState> {
  try {
    return await prisma.seoReportState.upsert({
      where: { linkId: link.id },
      create: {
        linkId: link.id,
        workspaceId: link.workspaceId,
        projectId: link.projectId,
        isMock: link.isMock,
      },
      update: {},
    });
  } catch (error) {
    // İki süreç aynı anda oluşturdu: satır artık var.
    const existing = await prisma.seoReportState.findUnique({
      where: { linkId: link.id },
    });
    if (!existing) throw error;
    return existing;
  }
}

export async function claimReportLease(
  stateId: string,
  owner: string,
  now: Date,
): Promise<boolean> {
  const claimed = await prisma.seoReportState.updateMany({
    where: {
      id: stateId,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: {
      leaseUntil: new Date(now.getTime() + REPORT_LEASE_MS),
      leaseOwner: owner,
    },
  });
  return claimed.count === 1;
}

// Kilidi bırakır ve durum alanlarını tek güncellemede yazar. Kilit başkasına
// geçtiyse (süre doldu) hiçbir şey yazılmaz.
export async function releaseReportState(
  stateId: string,
  owner: string,
  data: Prisma.SeoReportStateUpdateManyMutationInput,
): Promise<void> {
  await prisma.seoReportState.updateMany({
    where: { id: stateId, leaseOwner: owner },
    data: { ...data, leaseUntil: null, leaseOwner: null },
  });
}

// ---------------------------------------------------------------------------
// Raporlar
// ---------------------------------------------------------------------------

function labelOf(
  kind: string,
  periodStart: Date,
  periodEnd: Date,
): string {
  const from = dateToDayKey(periodStart);
  if (kind === "MONTHLY" || kind === "ROADMAP") return monthLabel(from);
  return periodLabel(from, dateToDayKey(periodEnd));
}

export async function findSeoReport(
  linkId: string,
  kind: SeoReportKind,
  periodKey: string,
): Promise<{ id: string; commandId: string; periodLabel: string } | null> {
  const row = await prisma.seoReport.findUnique({
    where: { linkId_kind_periodKey: { linkId, kind, periodKey } },
    select: {
      id: true,
      commandId: true,
      kind: true,
      periodStart: true,
      periodEnd: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    commandId: row.commandId,
    periodLabel: labelOf(row.kind, row.periodStart, row.periodEnd),
  };
}

// TEK YAZICI. Birim anahtar (bağ, tür, dönem) ya da commandId çakışırsa
// (P2002), bağ aradan çekildiyse (P2003 / P2025) null döner.
export async function insertSeoReport(input: {
  link: LinkRef;
  snapshot: SeoReportSnapshot;
  narrative: ReportSummary | null;
  narrativeNote: string | null;
  language: string;
  commandId: string;
}): Promise<{ id: string } | null> {
  const { link, snapshot } = input;
  try {
    const row = await prisma.seoReport.create({
      data: {
        workspaceId: link.workspaceId,
        projectId: link.projectId,
        linkId: link.id,
        kind: snapshot.kind,
        periodKey: snapshot.periodKey,
        periodStart: new Date(`${snapshot.period.from}T00:00:00.000Z`),
        periodEnd: new Date(`${snapshot.period.to}T00:00:00.000Z`),
        finalThrough: snapshot.finalThrough,
        language: input.language,
        title: snapshot.title,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        narrative: input.narrative
          ? (input.narrative as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
        narrativeNote: input.narrativeNote,
        commandId: input.commandId,
        isMock: link.isMock,
      },
      select: { id: true },
    });
    return row;
  } catch (error) {
    const code = prismaCode(error);
    if (code === "P2002" || code === "P2003" || code === "P2025") return null;
    throw error;
  }
}

// Anlık görüntüdeki fırsat ve yol haritası öğelerinin SeoFinding kimlikleri.
function findingIdsOf(snapshot: SeoReportSnapshot): string[] {
  const ids = new Set<string>();
  for (const section of snapshot.sections) {
    if (section.type === "opportunities") {
      for (const item of section.items) ids.add(item.id);
    } else if (section.type === "roadmap") {
      for (const item of [...section.actions, ...section.techDebt]) {
        if (item.findingId) ids.add(item.findingId);
      }
    }
  }
  return [...ids];
}

// Bulgunun CANLI durumu (kabul / ret düğmeleri için); anlık görüntüden değil.
async function liveFindingStatus(
  projectId: string,
  snapshot: SeoReportSnapshot,
): Promise<Record<string, string> | null> {
  if (!SeoInsightFlags.userFacing() || !seoInsightsAllowedFor(projectId)) {
    return null;
  }
  const ids = findingIdsOf(snapshot);
  if (ids.length === 0) return {};
  const rows = await prisma.seoFinding.findMany({
    where: { id: { in: ids }, projectId, shadow: false },
    select: { id: true, status: true },
  });
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

export async function readSeoReportView(
  projectId: string,
  reportId: string,
): Promise<SeoReportView | null> {
  const row = await prisma.seoReport.findFirst({
    where: { id: reportId, projectId, isMock: gscMockMode() },
  });
  if (!row || !isSeoReportKind(row.kind)) return null;
  const snapshot = readSeoReportSnapshot(row.snapshot);
  if (!snapshot) return null;
  const [findingStatus, chatHref] = await Promise.all([
    liveFindingStatus(projectId, snapshot),
    seoChatHref(projectId),
  ]);
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    title: row.title,
    periodKey: row.periodKey,
    createdAt: row.createdAt.toISOString(),
    language: row.language,
    snapshot,
    narrative: readSummary(row.narrative),
    narrativeNote: row.narrativeNote,
    isMock: row.isMock,
    searchHref: GscFlags.searchPage()
      ? `/projects/${projectId}/arama?report=${row.id}#reports`
      : null,
    chatHref,
    findingStatus,
    contentPlanLive: seoContentPlanActiveFor(projectId),
  };
}

export async function listSeoReports(
  projectId: string,
  options: {
    limit?: number;
    kinds?: readonly SeoReportKind[];
    now?: Date;
  } = {},
): Promise<SeoReportListItem[]> {
  const now = options.now ?? new Date();
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIST_LIMIT)),
    200,
  );
  const pulseSince = new Date(now.getTime() - PULSE_VISIBLE_DAYS * DAY_MS);
  const kindFilter = options.kinds ? { kind: { in: [...options.kinds] } } : {};
  const rows = await prisma.seoReport.findMany({
    where: {
      projectId,
      isMock: gscMockMode(),
      ...kindFilter,
      // Nabız kartları yalnız son 14 günde arşivde görünür.
      OR: [{ kind: { not: "PULSE" } }, { createdAt: { gte: pulseSince } }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: {
      id: true,
      kind: true,
      title: true,
      periodKey: true,
      periodStart: true,
      periodEnd: true,
      createdAt: true,
      isMock: true,
    },
  });
  const items: SeoReportListItem[] = [];
  for (const row of rows) {
    if (!isSeoReportKind(row.kind)) continue;
    items.push({
      id: row.id,
      kind: row.kind,
      title: row.title,
      periodLabel: labelOf(row.kind, row.periodStart, row.periodEnd),
      periodKey: row.periodKey,
      createdAt: row.createdAt.toISOString(),
      isMock: row.isMock,
    });
  }
  return items;
}

export async function latestSeoReport(
  projectId: string,
  kind: SeoReportKind,
): Promise<SeoReportView | null> {
  const row = await prisma.seoReport.findFirst({
    where: { projectId, kind, isMock: gscMockMode() },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  return row ? readSeoReportView(projectId, row.id) : null;
}

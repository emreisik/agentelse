import "server-only";

import {
  parseStatusIncidents,
  type SearchUpdateKind,
} from "@/lib/seo/search-updates";
import {
  SeoFlags,
  seoGlobalWorkAllowedHere,
  seoMockMode,
} from "@/lib/seo/health-flags";
import { prisma } from "@/lib/prisma";
import { claimPeriodic } from "@/server/observability/periodic";
import statusIncidentsFixture from "@/server/integrations/search-console/__fixtures__/status-incidents.json";

// Google arama güncellemeleri takvimi (docs/search-health.md "Google
// güncellemeleri"): `search-updates-sync` tick adımı. Google Search Status
// Dashboard'un incidents.json akışı günde bir okunur ve SearchUpdate'e olay
// kimliğiyle (externalId) yazılır; operatörün elle girdiği (MANUAL)
// satırlara hiç dokunulmaz. Globaldir: geliştirme süreci (canlı DB
// paylaşılırken) hiç çalıştırmaz. Hata loglanır, tick'i düşürmez. Mock
// kipte fixture okunur.

export const STATUS_INCIDENTS_URL =
  "https://status.search.google.com/incidents.json";

const PERIODIC_KEY = "seo.search-updates";
const EVERY_MS = 24 * 3_600_000;
const TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;
const RECENT_LIMIT = 200;

export type SearchUpdateRow = {
  id: string;
  name: string;
  kind: string;
  source: string;
  startedAt: Date;
  endedAt: Date | null;
  url: string | null;
};

async function fetchIncidents(): Promise<unknown> {
  const res = await fetch(STATUS_INCIDENTS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Status dashboard answered HTTP ${res.status}`);
  }
  return (await res.json()) as unknown;
}

export const SearchUpdates = {
  async runDue(now: Date = new Date()): Promise<number> {
    if (!SeoFlags.health() || !seoGlobalWorkAllowedHere()) return 0;
    if (!(await claimPeriodic(PERIODIC_KEY, EVERY_MS, now))) return 0;
    try {
      const raw = seoMockMode()
        ? (statusIncidentsFixture as unknown)
        : await fetchIncidents();
      const updates = parseStatusIncidents(raw);
      let written = 0;
      for (const update of updates) {
        const data = {
          name: update.name,
          kind: update.kind,
          startedAt: update.startedAt,
          endedAt: update.endedAt,
          url: update.url,
        };
        // externalId yalnız akıştan gelen satırlarda doludur; MANUAL
        // satırların externalId'si null olduğundan bu yazım onlara değmez.
        const updated = await prisma.searchUpdate.updateMany({
          where: { externalId: update.externalId, source: "STATUS_DASHBOARD" },
          data,
        });
        if (updated.count === 0) {
          await prisma.searchUpdate
            .create({
              data: {
                ...data,
                externalId: update.externalId,
                source: "STATUS_DASHBOARD",
              },
            })
            .catch((error: unknown) => {
              console.warn(
                `[search-updates] incident ${update.externalId} could not be stored:`,
                error instanceof Error ? error.message : error,
              );
            });
        }
        written += 1;
      }
      return written;
    } catch (error) {
      console.error(
        "[search-updates] status dashboard could not be read:",
        error instanceof Error ? error.message : error,
      );
      return 0;
    }
  },

  // Son `days` günde başlayan, biten ya da hâlâ süren güncellemeler.
  async recent(now: Date, days: number): Promise<SearchUpdateRow[]> {
    const from = new Date(now.getTime() - days * DAY_MS);
    const rows = await prisma.searchUpdate.findMany({
      where: {
        OR: [
          { startedAt: { gte: from } },
          { endedAt: { gte: from } },
          { endedAt: null, startedAt: { lte: now } },
        ],
      },
      orderBy: { startedAt: "desc" },
      take: RECENT_LIMIT,
      select: {
        id: true,
        name: true,
        kind: true,
        source: true,
        startedAt: true,
        endedAt: true,
        url: true,
      },
    });
    return rows;
  },

  // Operatörün elle eklediği satır (Status Dashboard'da olmayan güncelleme).
  // Kimliği denetim kaydı için döner.
  async addManual(input: {
    name: string;
    kind: SearchUpdateKind;
    startedAt: Date;
    endedAt: Date | null;
    url: string | null;
    userId: string;
  }): Promise<{ id: string }> {
    const row = await prisma.searchUpdate.create({
      data: {
        externalId: null,
        name: input.name,
        kind: input.kind,
        source: "MANUAL",
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        url: input.url,
        createdByUserId: input.userId,
      },
      select: { id: true },
    });
    return { id: row.id };
  },

  // Yalnız MANUAL satırlar silinir; akıştan gelenler bir sonraki senkronda
  // geri yazılacağı için silinmez.
  async removeManual(id: string): Promise<boolean> {
    const removed = await prisma.searchUpdate.deleteMany({
      where: { id, source: "MANUAL" },
    });
    return removed.count === 1;
  },
};

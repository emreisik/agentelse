import "server-only";

import { prisma } from "@/lib/prisma";
import {
  SeoActionFlags,
  seoActionsGlobalWorkAllowedHere,
} from "@/lib/seo/action-flags";
import { ACTION_RETENTION_DAYS } from "@/lib/seo/actions/lifecycle";
import { TERMINAL_ACTION_STATUSES } from "@/lib/seo/actions/types";
import { claimPeriodic } from "@/server/observability/periodic";

import { forgetSeoActionsForLinks } from "./forget";

// SEO eylemlerinin saklaması (docs/search-actions.md "Saklama"): günde bir
// (`seo.actions-retention`), yalnız canlıda (geliştirme süreci canlı
// veritabanını paylaşırken hiç çalışmaz). Sırayla: 1) 36 aydır dokunulmayan
// terminal satırlar, 2) projesi silinmiş satırlar, 3) GscSiteLink'i kalmamış
// satırlar (öğrenmeleriyle birlikte; bağı W1 saklaması ya da proje silme
// götürmüş olabilir). SEO_ACTIONS sonradan kapatılsa da satır kaldığı sürece
// çalışır (36 ay sözü ve Google verisinin silinmesi bayrağa bağlı değildir);
// satır yoksa 24 saat boyunca yeniden bakılmaz.

const RETENTION_KEY = "seo.actions-retention";
const EVERY_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;
const DANGLING_BATCH = 500;

let memo: { checkedAt: number; exists: boolean } | null = null;

async function engaged(now: Date): Promise<boolean> {
  if (SeoActionFlags.loop()) return true;
  if (memo && now.getTime() - memo.checkedAt < EVERY_MS) return memo.exists;
  const row = await prisma.seoAction.findFirst({ select: { id: true } });
  memo = { checkedAt: now.getTime(), exists: row !== null };
  return memo.exists;
}

function report(scope: string, error: unknown): void {
  console.error(
    `[seo-actions-retention] ${scope}:`,
    error instanceof Error ? error.message : error,
  );
}

async function step(
  label: string,
  run: () => Promise<number>,
): Promise<number> {
  try {
    return await run();
  } catch (error) {
    report(`${label} failed`, error);
    return 0;
  }
}

export const SeoActionRetention = {
  async runDue(now: Date = new Date()): Promise<number> {
    if (!seoActionsGlobalWorkAllowedHere()) return 0;
    if (!(await engaged(now))) return 0;
    if (!(await claimPeriodic(RETENTION_KEY, EVERY_MS, now))) return 0;

    let deleted = 0;
    deleted += await step("old terminal rows", async () => {
      const result = await prisma.seoAction.deleteMany({
        where: {
          status: { in: [...TERMINAL_ACTION_STATUSES] },
          updatedAt: {
            lt: new Date(now.getTime() - ACTION_RETENTION_DAYS * DAY_MS),
          },
        },
      });
      return result.count;
    });
    deleted += await step(
      "deleted projects",
      () => prisma.$executeRaw`
        DELETE FROM "SeoAction" a
         WHERE NOT EXISTS (
           SELECT 1 FROM "Project" p WHERE p."id" = a."projectId"
         )
      `,
    );
    deleted += await step("dangling links", async () => {
      const rows = await prisma.$queryRaw<{ linkId: string }[]>`
        SELECT DISTINCT a."linkId" AS "linkId"
          FROM "SeoAction" a
         WHERE a."linkId" IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM "GscSiteLink" l WHERE l."id" = a."linkId"
           )
         LIMIT ${DANGLING_BATCH}
      `;
      const result = await forgetSeoActionsForLinks(
        rows.map((row) => row.linkId),
      );
      return result.actions + result.learnings;
    });
    return deleted;
  },

  // Testler için: "satır yok" önbelleğini sıfırlar.
  resetMemo(): void {
    memo = null;
  },
};

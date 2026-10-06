import "server-only";

import { Prisma, type AdsLaunch } from "@prisma/client";

import { AdsFlags } from "@/lib/ads/flags";
import {
  guardsOf,
  safetyThresholdMinor,
  type InsuranceGuards,
} from "@/lib/ads/insurance";
import { averageDailyMinor, parseLaunchSpec } from "@/lib/ads/launch-spec";
import { nameWithoutTag } from "@/lib/ads/operation-tag";
import { safeTimezone } from "@/lib/ads/sync-plan";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone, zonedDateTimeToUtc } from "@/lib/timezone";
import { AdsAlerts } from "@/server/ads/guard/alerts";
import type { SyncContext } from "@/server/ads/sync/context";
import {
  createSafetyRule,
  deleteSafetyRule,
  readSafetyRuleHistory,
  safetyRuleName,
  updateSafetyRule,
} from "@/server/integrations/meta/ad-rules";
import { withMetaCallContext } from "@/server/integrations/meta/call-context";
import { claimPeriodic } from "@/server/observability/periodic";
import { decryptSecret } from "@/server/security/crypto";

// Ad Rules sigortası (docs/meta-ads-plan.md §3.9, F7, META_ADS_RULES):
// Agentelse'in çalışan her lansman kampanyasına Meta'da bir SCHEDULE kuralı
// ("bugünkü harcama > 2 × günlük bütçe → PAUSE") kurulur; sunucumuz düşse de
// çalışır. Kural kimliği AdsLaunch.guards'tadır; eşik bütçeyle güncellenir;
// lansman bitince ya da Disconnect'te kural silinir. Kural yürütmeleri yapı
// senkronunda okunur ve RULE aktörlü AdsOperation olarak yazılır: drift
// sayılmaz, Ads sayfası "Paused by Agentelse safety rule" gösterir.

const EVERY_MS = 30 * 60_000;
const HISTORY_FALLBACK_MS = 24 * 60 * 60_000;
const BUDGET_OP_KINDS = ["UPDATE_CAMPAIGN", "UPDATE_ADSET"];

function budgetOf(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  const number = Number(
    record.dailyBudgetCents ?? record.proposedDailyBudgetCents ?? 0,
  );
  return Number.isFinite(number) ? number : 0;
}

async function tokenFor(
  workspaceId: string,
  adAccountExternalId: string,
): Promise<{ accountId: string; timezone: string; token: string } | null> {
  const account = await prisma.adsAccount.findFirst({
    where: { workspaceId, platform: "META", externalId: adAccountExternalId },
    select: { id: true, credentialId: true, timezoneName: true },
  });
  if (!account?.credentialId) return null;
  const credential = await prisma.integrationCredential.findUnique({
    where: { id: account.credentialId },
    select: { status: true, encryptedSecret: true },
  });
  if (
    !credential ||
    credential.status !== "ACTIVE" ||
    !credential.encryptedSecret
  ) {
    return null;
  }
  return {
    accountId: account.id,
    timezone: safeTimezone(account.timezoneName),
    token: decryptSecret(credential.encryptedSecret),
  };
}

// Kampanyanın bugünkü günlük bütçesi (CBO'da kampanya, ABO'da çalışan ad
// set'lerin toplamı; ayna boşsa lansmanın ortalaması) ve bugün yürürlükte
// olmuş en yüksek değer.
async function budgetsFor(
  launch: AdsLaunch,
  adsAccountId: string,
  timezone: string,
  now: Date,
): Promise<{
  current: number | null;
  highestToday: number | null;
  name: string;
  live: boolean;
}> {
  const objects = await prisma.adsObject.findMany({
    where: {
      adsAccountId,
      OR: [
        { externalId: launch.campaignExternalId! },
        { campaignExternalId: launch.campaignExternalId!, level: "ADSET" },
      ],
    },
  });
  const campaign = objects.find((row) => row.level === "CAMPAIGN");
  const adSets = objects.filter(
    (row) =>
      row.level === "ADSET" && !row.goneAt && row.configuredStatus === "ACTIVE",
  );
  const live = Boolean(
    campaign &&
    !campaign.goneAt &&
    (!campaign.endTime || campaign.endTime.getTime() > now.getTime()),
  );
  const own = campaign?.dailyBudgetMinor
    ? Number(campaign.dailyBudgetMinor)
    : 0;
  const children = adSets.reduce(
    (sum, row) => sum + Number(row.dailyBudgetMinor ?? 0),
    0,
  );
  const spec = parseLaunchSpec(launch.spec);
  const current =
    own || children || (spec ? averageDailyMinor(spec) : 0) || null;
  const dayStart = zonedDateTimeToUtc(
    `${dayKeyInTimezone(now, timezone)}T00:00`,
    timezone,
  );
  const ops = await prisma.adsOperation.findMany({
    where: {
      kind: { in: BUDGET_OP_KINDS },
      targetExternalId: {
        in: [
          launch.campaignExternalId!,
          ...adSets.map((row) => row.externalId),
        ],
      },
      createdAt: { gte: dayStart },
    },
    select: { previousState: true },
  });
  const highestBefore = ops.reduce(
    (max, op) => Math.max(max, budgetOf(op.previousState)),
    0,
  );
  return {
    current,
    highestToday: highestBefore || null,
    name: campaign ? nameWithoutTag(campaign.name) : launch.campaignExternalId!,
    live,
  };
}

// Kural silinince guards'tan kuralın izleri çıkar (spend cap kalır).
function withoutRule(guards: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...guards };
  delete rest.ruleId;
  delete rest.ruleThresholdMinor;
  delete rest.ruleDeleteFailedAt;
  return rest;
}

async function writeGuards(
  launchId: string,
  guards: Record<string, unknown>,
): Promise<void> {
  await prisma.adsLaunch.update({
    where: { id: launchId },
    data: { guards: guards as Prisma.InputJsonValue },
  });
}

export const AdsInsurance = {
  // Tick adımı (30 dakikada bir, süreçler arası kilitli).
  async runDue(now: Date = new Date()): Promise<number> {
    if (!AdsFlags.adRules() || !AdsFlags.sync()) return 0;
    if (metaWorkExcludedHere(process.env)) return 0;
    if (!(await claimPeriodic("ads.rules", EVERY_MS, now))) return 0;
    const launches = await prisma.adsLaunch.findMany({
      where: {
        campaignExternalId: { not: null },
        updatedAt: { gt: new Date(now.getTime() - 120 * 24 * 60 * 60_000) },
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    let changed = 0;
    for (const launch of launches) {
      const guards = guardsOf(launch.guards);
      if (launch.status !== "ACTIVE" && !guards.ruleId) continue;
      try {
        if (await this.maintain(launch, guards, now)) changed += 1;
      } catch (error) {
        console.error(
          `[ads-rules] ${launch.id} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return changed;
  },

  async maintain(
    launch: AdsLaunch,
    guards: InsuranceGuards & Record<string, unknown>,
    now: Date,
  ): Promise<boolean> {
    const access = await tokenFor(
      launch.workspaceId,
      launch.adAccountExternalId,
    );
    if (!access) return false;
    const budgets = await budgetsFor(
      launch,
      access.accountId,
      access.timezone,
      now,
    );
    const shouldHave = launch.status === "ACTIVE" && budgets.live;
    return withMetaCallContext(
      {
        account: launch.adAccountExternalId,
        lane: "P2_BACKGROUND",
        callSite: "ads.rules",
      },
      async () => {
        if (!shouldHave) {
          if (!guards.ruleId) return false;
          await deleteSafetyRule(guards.ruleId, access.token);
          await writeGuards(launch.id, withoutRule(guards));
          return true;
        }
        const threshold = safetyThresholdMinor({
          currentDailyMinor: budgets.current,
          highestTodayMinor: budgets.highestToday,
        });
        if (threshold === null) return false;
        if (!guards.ruleId) {
          const ruleId = await createSafetyRule({
            adAccountId: launch.adAccountExternalId,
            accessToken: access.token,
            name: safetyRuleName(budgets.name),
            spec: {
              campaignId: launch.campaignExternalId!,
              thresholdMinor: threshold,
            },
          });
          await writeGuards(launch.id, {
            ...guards,
            ruleId,
            ruleThresholdMinor: threshold,
          });
          return true;
        }
        if (guards.ruleThresholdMinor === threshold) return false;
        await updateSafetyRule({
          ruleId: guards.ruleId,
          accessToken: access.token,
          spec: {
            campaignId: launch.campaignExternalId!,
            thresholdMinor: threshold,
          },
        });
        await writeGuards(launch.id, {
          ...guards,
          ruleThresholdMinor: threshold,
        });
        return true;
      },
    );
  },

  // Yapı senkronunun başında (drift kararından önce): kuralların bu hesapta
  // yaptığı duraklatmalar RULE aktörlü niyet kaydı olur.
  async syncHistory(ctx: SyncContext): Promise<number> {
    if (!AdsFlags.adRules()) return 0;
    const launches = await prisma.adsLaunch.findMany({
      where: {
        adAccountExternalId: ctx.externalId,
        campaignExternalId: { not: null },
      },
      select: { id: true, workspaceId: true, projectId: true, guards: true },
    });
    const byRule = new Map(
      launches
        .map((launch) => [guardsOf(launch.guards).ruleId, launch] as const)
        .filter((pair): pair is readonly [string, (typeof launches)[number]] =>
          Boolean(pair[0]),
        ),
    );
    if (byRule.size === 0) return 0;
    const since =
      ctx.account.rulesHistoryAt ??
      new Date(ctx.now.getTime() - HISTORY_FALLBACK_MS);
    const history = await readSafetyRuleHistory(
      ctx.externalId,
      ctx.accessToken,
    );
    let recorded = 0;
    for (const entry of history) {
      const launch = byRule.get(entry.ruleId);
      const at = entry.timestamp ? new Date(entry.timestamp) : null;
      if (!launch || (at && at.getTime() <= since.getTime())) continue;
      for (const objectId of entry.objectIds) {
        try {
          await prisma.adsOperation.create({
            data: {
              workspaceId: launch.workspaceId,
              projectId: launch.projectId,
              adsAccountId: ctx.account.id,
              adAccountExternalId: ctx.externalId,
              kind: "SET_STATUS",
              tag: `rule:${entry.ruleId}:${objectId}:${entry.timestamp ?? ctx.now.toISOString()}`,
              launchId: launch.id,
              actorType: "RULE",
              targetExternalId: objectId,
              request: {
                status: "PAUSED",
                ruleId: entry.ruleId,
                at: entry.timestamp,
              },
              status: "SUCCEEDED",
              resultExternalId: objectId,
              completedAt: ctx.now,
            },
          });
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          ) {
            continue;
          }
          throw error;
        }
        recorded += 1;
        const object = await prisma.adsObject.findFirst({
          where: { adsAccountId: ctx.account.id, externalId: objectId },
          select: { name: true },
        });
        await AdsAlerts.raise(
          {
            workspaceId: launch.workspaceId,
            projectId: launch.projectId,
            adsAccountId: ctx.account.id,
            externalId: objectId,
            kind: "RULE_PAUSED",
            severity: "WARN",
            dedupeKey: `RULE_PAUSED:${objectId}`,
            title: `Paused by Agentelse safety rule: ${object ? nameWithoutTag(object.name) : objectId}`,
            detail:
              "It spent more than twice its daily budget today, so Meta paused it. Check its budget, then turn it back on.",
          },
          ctx.now,
        );
      }
    }
    await prisma.adsAccount.update({
      where: { id: ctx.account.id },
      data: { rulesHistoryAt: ctx.now },
    });
    return recorded;
  },

  // Disconnect (§3.9 sırası): önce kurallar, sonra izin ve token. Silinemeyen
  // kural guards'ta işaretlenir ve /health'te listelenir.
  async removeForProject(
    projectId: string,
    accessToken: string,
    now: Date = new Date(),
  ): Promise<{ removed: number; failed: number }> {
    const launches = await prisma.adsLaunch.findMany({
      where: { projectId, campaignExternalId: { not: null } },
      select: { id: true, adAccountExternalId: true, guards: true },
    });
    let removed = 0;
    let failed = 0;
    for (const launch of launches) {
      const guards = guardsOf(launch.guards);
      if (!guards.ruleId) continue;
      try {
        await withMetaCallContext(
          {
            account: launch.adAccountExternalId,
            lane: "P1_USER",
            callSite: "ads.rules-disconnect",
          },
          () => deleteSafetyRule(guards.ruleId!, accessToken),
        );
        await writeGuards(launch.id, withoutRule(guards));
        removed += 1;
      } catch (error) {
        console.error(
          `[ads-rules] rule ${guards.ruleId} could not be deleted at disconnect:`,
          error instanceof Error ? error.message : error,
        );
        await writeGuards(launch.id, {
          ...guards,
          ruleDeleteFailedAt: now.toISOString(),
        });
        failed += 1;
      }
    }
    return { removed, failed };
  },

  // /health: Disconnect'te silinemeyen kurallar.
  async undeletable(): Promise<
    { launchId: string; projectId: string; ruleId: string; at: string }[]
  > {
    const launches = await prisma.adsLaunch.findMany({
      where: { campaignExternalId: { not: null } },
      select: { id: true, projectId: true, guards: true },
      orderBy: { updatedAt: "desc" },
      take: 500,
    });
    return launches.flatMap((launch) => {
      const guards = guardsOf(launch.guards);
      return guards.ruleId && guards.ruleDeleteFailedAt
        ? [
            {
              launchId: launch.id,
              projectId: launch.projectId,
              ruleId: guards.ruleId,
              at: guards.ruleDeleteFailedAt,
            },
          ]
        : [];
    });
  },
};

import "server-only";

import type { AdsAccount, AdsObject, Prisma } from "@prisma/client";

import { AdsFlags, type OptimizerMode } from "@/lib/ads/flags";
import { parseLaunchSpec } from "@/lib/ads/launch-spec";
import { toMinorUnits } from "@/lib/ads/money";
import { explainDecision } from "@/lib/ads/rules/explain";
import { featuresOf, windowOf, type DayRow } from "@/lib/ads/rules/features";
import {
  learningBlocks,
  rateBlocks,
  type RecentChange,
} from "@/lib/ads/rules/gates";
import {
  adRules,
  adSetRules,
  decisionFingerprint,
  type RuleCandidate,
} from "@/lib/ads/rules/optimize-rules";
import { addDays, safeTimezone } from "@/lib/ads/sync-plan";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { AdsAlerts } from "@/server/ads/guard/alerts";
import { IdeaEngine } from "@/server/ideas/idea-engine";
import { claimPeriodic } from "@/server/observability/periodic";

import { AdsDecisions } from "./decisions";

// Optimizasyon motoru (docs/meta-ads-plan.md §3.5, F4): aynadan özellikler →
// deterministik kurallar → kapılar → AdsDecision. `META_ADS_OPTIMIZER`:
//   shadow  yalnız SHADOW kaydı (sahip örnekleri inceler; kabul ≥ %60 → on)
//   on      para / durum kararı L4 onaylı görev olur; yorgunluk fikir
//           havuzuna konsept isteği; bilgi kararı Ads sayfasında öneri.
// Hesap başına günde bir kez (süreçler arası kilitli). Meta'ya çağrı yok.

const EVERY_MS = 24 * 60 * 60_000;
const HISTORY_DAYS = 35;

type ObjectRows = Map<string, DayRow[]>;

function dayRow(row: {
  date: Date;
  spendMinor: bigint;
  impressions: number;
  clicks: number;
  linkClicks: number;
  results: number | null;
  video3s: number | null;
  thruplays: number | null;
}): DayRow {
  return {
    date: row.date.toISOString().slice(0, 10),
    spendMinor: Number(row.spendMinor),
    impressions: row.impressions,
    clicks: row.clicks,
    linkClicks: row.linkClicks,
    results: row.results,
    video3s: row.video3s,
    thruplays: row.thruplays,
  };
}

function running(object: AdsObject, now: Date): boolean {
  return (
    !object.goneAt &&
    object.configuredStatus === "ACTIVE" &&
    object.effectiveStatus === "ACTIVE" &&
    (!object.endTime || object.endTime.getTime() > now.getTime())
  );
}

export const AdsOptimizer = {
  async runDue(limit = 2, now: Date = new Date()): Promise<number> {
    const mode = AdsFlags.optimizer();
    if (mode === "off" || !AdsFlags.sync()) return 0;
    if (metaWorkExcludedHere(process.env)) return 0;
    const accounts = await prisma.adsAccount.findMany({
      where: {
        platform: "META",
        lastInsightsAt: { not: null },
        lastStructureAt: { not: null, gt: new Date(0) },
        projects: { some: { selected: true } },
      },
      take: 50,
    });
    let done = 0;
    for (const account of accounts) {
      if (done >= limit) break;
      if (!(await claimPeriodic(`ads.optimizer:${account.id}`, EVERY_MS, now)))
        continue;
      try {
        await this.evaluateAccount(account, mode, now);
      } catch (error) {
        console.error(
          `[ads-optimizer] ${account.externalId} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
      done += 1;
    }
    return done;
  },

  async evaluateAccount(
    account: AdsAccount,
    mode: Exclude<OptimizerMode, "off">,
    now: Date,
  ): Promise<number> {
    const link = await prisma.adsAccountProject.findFirst({
      where: { adsAccountId: account.id, selected: true },
      select: { projectId: true, brandId: true },
    });
    if (!link) return 0;
    const project = await prisma.project.findUnique({
      where: { id: link.projectId },
      select: { workspaceId: true },
    });
    if (!project) return 0;
    const today = dayKeyInTimezone(now, safeTimezone(account.timezoneName));
    const [objects, rows, launches] = await Promise.all([
      prisma.adsObject.findMany({
        where: { adsAccountId: account.id, goneAt: null },
      }),
      prisma.adsInsightDaily.findMany({
        where: {
          adsAccountId: account.id,
          date: { gte: new Date(`${addDays(today, -HISTORY_DAYS)}T00:00:00Z`) },
        },
      }),
      prisma.adsLaunch.findMany({
        where: { adsAccountId: account.id, campaignExternalId: { not: null } },
        select: { campaignExternalId: true, spec: true },
      }),
    ]);
    const byObject: ObjectRows = new Map();
    for (const row of rows) {
      const list = byObject.get(row.externalId) ?? [];
      list.push(dayRow(row));
      byObject.set(row.externalId, list);
    }
    const accountRows = byObject.get(account.externalId) ?? [];
    const accountD28 = windowOf(
      accountRows,
      addDays(today, -28),
      addDays(today, -1),
    );
    const accountCpa = accountD28.cpaMinor;
    const accountLinkCtr = accountD28.linkCtr;

    // Lansmanın KPI hedefi (F5b planlayıcısı yazar), yoksa ad set'in kendi
    // 28 günlük tabanı, yoksa hesabın tabanı.
    const kpiByCampaign = new Map<string, number>();
    for (const launch of launches) {
      const spec = parseLaunchSpec(launch.spec);
      if (
        spec?.kpi &&
        launch.campaignExternalId &&
        spec.kpi.metric !== "ROAS"
      ) {
        kpiByCampaign.set(
          launch.campaignExternalId,
          toMinorUnits(spec.kpi.target, spec.currency),
        );
      }
    }

    const recent = await prisma.adsDecision.findMany({
      where: {
        adsAccountId: account.id,
        status: {
          in: ["APPLIED", "VERIFIED", "PROPOSED", "APPROVED", "APPLYING"],
        },
        createdAt: { gt: new Date(now.getTime() - 7 * 24 * 60 * 60_000) },
      },
      select: {
        externalId: true,
        kind: true,
        appliedAt: true,
        createdAt: true,
      },
    });
    const recentOps = await prisma.adsOperation.findMany({
      where: {
        adAccountExternalId: account.externalId,
        kind: {
          in: ["UPDATE_ADSET", "UPDATE_CAMPAIGN", "UPDATE_AD", "SET_STATUS"],
        },
        createdAt: { gt: new Date(now.getTime() - 7 * 24 * 60 * 60_000) },
      },
      select: { targetExternalId: true, kind: true, createdAt: true },
    });
    const changesOf = (externalId: string): RecentChange[] => [
      ...recent
        .filter((decision) => decision.externalId === externalId)
        .map((decision) => ({
          kind: decision.kind,
          at: decision.appliedAt ?? decision.createdAt,
        })),
      ...recentOps
        .filter((op) => op.targetExternalId === externalId)
        .map((op) => ({
          kind: op.kind === "SET_STATUS" ? "PAUSE" : "BUDGET_DOWN",
          at: op.createdAt,
        })),
    ];

    const adSets = objects.filter(
      (object) => object.level === "ADSET" && running(object, now),
    );
    const ads = objects.filter(
      (object) => object.level === "AD" && running(object, now),
    );
    const campaigns = new Map(
      objects
        .filter((object) => object.level === "CAMPAIGN")
        .map((object) => [object.externalId, object]),
    );
    let written = 0;

    const consider = async (
      object: AdsObject,
      candidates: RuleCandidate[],
      learning: { learningStatus: string | null; lastSigEditAt: Date | null },
    ) => {
      for (const candidate of candidates) {
        if (!candidate.urgent && learningBlocks(learning, now)) continue;
        if (
          candidate.change &&
          rateBlocks(candidate.kind, changesOf(object.externalId), now)
        )
          continue;
        if (
          await AdsDecisions.rejectedRecently(
            account.id,
            object.externalId,
            candidate.ruleKey,
            now,
          )
        ) {
          continue;
        }
        const explanation = explainDecision(candidate, {
          name: object.name,
          currency: account.currency,
        });
        const decision = await AdsDecisions.create({
          workspaceId: project.workspaceId,
          projectId: object.projectId ?? link.projectId,
          adsAccountId: account.id,
          level: object.level,
          externalId: object.externalId,
          ruleKey: candidate.ruleKey,
          ruleVersion: candidate.ruleVersion,
          kind: candidate.kind,
          severity: candidate.severity,
          status: mode === "shadow" ? "SHADOW" : "PROPOSED",
          evidence: candidate.evidence as Prisma.InputJsonValue,
          explanation,
          ...(candidate.change
            ? { change: candidate.change as unknown as Prisma.InputJsonValue }
            : {}),
          fingerprint: decisionFingerprint(
            candidate.ruleKey,
            object.externalId,
            now,
          ),
          ...(candidate.kind === "NOTIFY"
            ? { expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000) }
            : {}),
        });
        if (!decision) continue;
        written += 1;
        if (mode === "shadow") continue;
        await this.act(decision, {
          brandId: link.brandId,
          currency: account.currency,
          adAccountId: account.externalId,
          campaign: object.campaignExternalId
            ? campaigns.get(object.campaignExternalId)
            : undefined,
          name: object.name,
        });
      }
    };

    for (const adSet of adSets) {
      const features = featuresOf({
        rows: byObject.get(adSet.externalId) ?? [],
        today,
        windowStats: adSet.windowStats,
        learningStatus: adSet.learningStatus,
        lastSigEditAt: adSet.lastSigEditAt,
        createdAt: adSet.createdAt,
        now,
      });
      const ownBase =
        features.d28.results && features.d28.results >= 10
          ? features.d28.cpaMinor
          : null;
      const target =
        (adSet.campaignExternalId
          ? kpiByCampaign.get(adSet.campaignExternalId)
          : undefined) ??
        ownBase ??
        accountCpa;
      const children = ads.filter(
        (ad) => ad.parentExternalId === adSet.externalId,
      );
      const newest = children.reduce<number | null>((min, ad) => {
        const age = Math.floor(
          (now.getTime() - ad.createdAt.getTime()) / 86_400_000,
        );
        return min === null || age < min ? age : min;
      }, null);
      const candidates = adSetRules(
        {
          externalId: adSet.externalId,
          name: adSet.name,
          dailyBudgetMinor:
            adSet.dailyBudgetMinor === null
              ? null
              : Number(adSet.dailyBudgetMinor),
          optimizationGoal: adSet.optimizationGoal,
          offsite:
            adSet.optimizationGoal === "OFFSITE_CONVERSIONS" ||
            adSet.optimizationGoal === "VALUE",
          features,
          minDailyBudgetMinor:
            account.minDailyBudgetMinor === null
              ? null
              : Number(account.minDailyBudgetMinor),
          newestAdAgeDays: newest,
        },
        { targetCpaMinor: target, accountLinkCtr },
      );
      await consider(adSet, candidates, {
        learningStatus: adSet.learningStatus,
        lastSigEditAt: adSet.lastSigEditAt,
      });

      const adSetSpend = features.d7.spendMinor;
      for (const ad of children) {
        const adFeatures = featuresOf({
          rows: byObject.get(ad.externalId) ?? [],
          today,
          windowStats: ad.windowStats,
          createdAt: ad.createdAt,
          now,
        });
        const adCandidates = adRules(
          {
            externalId: ad.externalId,
            name: ad.name,
            features: adFeatures,
            siblingsActive: children.length - 1,
            adSetSpend7dMinor: adSetSpend,
            isVideo: adFeatures.d28.video3s > 0,
          },
          { targetCpaMinor: target, accountLinkCtr },
        );
        // Reklam kararları da ebeveyn ad set'in öğrenme kapısına takılır.
        await consider(ad, adCandidates, {
          learningStatus: adSet.learningStatus,
          lastSigEditAt: adSet.lastSigEditAt,
        });
      }
    }
    return written;
  },

  // Kararın "on" modda eylemi.
  async act(
    decision: Awaited<ReturnType<typeof AdsDecisions.create>> & object,
    input: {
      brandId: string;
      currency: string | null;
      adAccountId: string;
      campaign?: AdsObject;
      name: string;
    },
  ): Promise<void> {
    if (decision.kind === "CREATIVE_REFRESH") {
      // Otomatik görsel üretimi yok: fikir havuzuna konsept isteği.
      const result = await IdeaEngine.generate({
        projectId: decision.projectId,
        count: 3,
        trigger: "manual",
        focus:
          `New ad angles for "${input.name}": ${decision.explanation}`.slice(
            0,
            300,
          ),
      }).catch(() => null);
      await prisma.adsDecision.update({
        where: { id: decision.id },
        data: {
          status: "APPLIED",
          appliedAt: new Date(),
          outcomeData: { ideas: result && result.ok ? result.created : [] },
        },
      });
      return;
    }
    if (decision.kind === "NOTIFY") {
      await AdsAlerts.raise({
        workspaceId: decision.workspaceId,
        projectId: decision.projectId,
        adsAccountId: decision.adsAccountId,
        externalId: decision.externalId,
        kind: "SUGGESTION",
        severity: "INFO",
        dedupeKey: `suggestion:${decision.ruleKey}:${decision.externalId}`,
        title: decision.explanation.split(". ")[0]!.slice(0, 160),
        detail: decision.explanation,
        data: { decisionId: decision.id },
      });
      return;
    }
    await AdsDecisions.propose(decision, {
      brandId: input.brandId,
      currency: input.currency,
      adAccountId: input.adAccountId,
      campaignId:
        decision.level === "CAMPAIGN"
          ? decision.externalId
          : input.campaign?.externalId,
      campaignName: input.campaign?.name ?? input.name,
    });
  },
};

import "server-only";

import type { AdsObject } from "@prisma/client";

import { AdsFlags } from "@/lib/ads/flags";
import {
  deliveryFindings,
  noDeliveryFindings,
  runawaySpend,
  type GuardFinding,
  type GuardObject,
} from "@/lib/ads/guard-rules";
import { anomalyTitle, metricAnomalies } from "@/lib/ads/anomaly";
import { envelopeMinor, parseLaunchSpec } from "@/lib/ads/launch-spec";
import { formatMoney } from "@/lib/ads/money";
import { nameWithoutTag } from "@/lib/ads/operation-tag";
import {
  overlapKey,
  overlappingPairs,
  type TargetingSummary,
} from "@/lib/ads/overlap";
import { addDays, safeTimezone, weekStartSunday } from "@/lib/ads/sync-plan";
import { tokenWarningDays } from "@/lib/ads/token-health";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { AdsAutopilot } from "@/server/ads/autopilot";
import type { SyncContext, SyncProject } from "@/server/ads/sync/context";
import type { MetaTokenHealth } from "@/server/integrations/meta-client";
import { claimPeriodic } from "@/server/observability/periodic";

import { AdsAlerts } from "./alerts";

// Bekçiler (docs/meta-ads-plan.md §3.6): aynadan okur, Meta'ya çağrı yapmaz.
// evaluateAccount her başarılı senkrondan hemen sonra koşar (G1, G5, G8,
// proje duraklatılmış ama reklam çalışıyor); runPeriodic tick adımıdır
// (senkron nabzı, token, takılan yazma, yetim nesne).

// F5b: yeni lead bildirimi (kişisel veri yok; yalnız insights'taki lead
// sayısı). Lead'ler Meta'nın Leads Center'ında; Agentelse yalnız haber verir.
export function leadsToday(
  rows: readonly { level: string; date: Date; actions: unknown }[],
  today: Date,
): number {
  let total = 0;
  for (const row of rows) {
    if (row.level !== "ACCOUNT" || row.date.getTime() !== today.getTime()) continue;
    const actions = (row.actions ?? {}) as Record<string, number>;
    total += Number(actions.lead ?? actions["onsite_conversion.lead_grouped"] ?? 0) || 0;
  }
  return total;
}

export const OBJECT_ALERT_KINDS = [
  "RUNAWAY_SPEND",
  "AD_DISAPPROVED",
  "ALL_ADS_REJECTED",
  "DELIVERY_ISSUE",
  "BILLING_HOLD",
  "REVIEW_SLOW",
  "NO_DELIVERY",
  "PROJECT_PAUSED_ADS_RUNNING",
  "ENVELOPE_REACHED",
  "MONTHLY_CAP_REACHED",
] as const;

const PERIODIC_EVERY_MS = 15 * 60_000;
const SYNC_STALE_MS = 2 * 60 * 60_000;
const OP_STUCK_MS = 10 * 60_000;
const ORPHAN_AFTER_MS = 24 * 60 * 60_000;

function toGuardObject(row: AdsObject): GuardObject {
  return {
    externalId: row.externalId,
    level: row.level as GuardObject["level"],
    name: row.name,
    parentExternalId: row.parentExternalId,
    campaignExternalId: row.campaignExternalId,
    configuredStatus: row.configuredStatus,
    effectiveStatus: row.effectiveStatus,
    startTime: row.startTime,
    endTime: row.endTime,
    createdAt: row.createdAt,
    firstSeenAt: row.createdAt,
    goneAt: row.goneAt,
    budgetRemainingMinor:
      row.budgetRemainingMinor === null ? null : Number(row.budgetRemainingMinor),
    issues: row.issues,
    reviewFeedback: row.reviewFeedback,
  };
}

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

// Kampanyanın bugün yürürlükteki günlük bütçesi: CBO'da kampanyanın, ABO'da
// çalışan ad set'lerin toplamı. Bugün yapılan düşürme yanlış alarm
// üretmesin diye bugünkü yazmaların önceki değeri de hesaba katılır.
function dailyBudgetOf(
  campaign: AdsObject,
  objects: AdsObject[],
  budgetsBefore: ReadonlyMap<string, number>,
): number | null {
  const own = campaign.dailyBudgetMinor === null ? null : Number(campaign.dailyBudgetMinor);
  if (own) return Math.max(own, budgetsBefore.get(campaign.externalId) ?? 0);
  const adSets = objects.filter(
    (object) =>
      object.level === "ADSET" &&
      object.campaignExternalId === campaign.externalId &&
      !object.goneAt &&
      object.configuredStatus === "ACTIVE",
  );
  if (adSets.some((adSet) => adSet.lifetimeBudgetMinor !== null)) return null;
  const total = adSets.reduce(
    (sum, adSet) =>
      sum +
      Math.max(
        adSet.dailyBudgetMinor === null ? 0 : Number(adSet.dailyBudgetMinor),
        budgetsBefore.get(adSet.externalId) ?? 0,
      ),
    0,
  );
  return total > 0 ? total : null;
}

function budgetFromRequest(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  const raw =
    record.dailyBudgetCents ??
    record.proposedDailyBudgetCents ??
    record.dailyBudgetMinor ??
    record.daily_budget;
  const number = Number(raw);
  return Number.isFinite(number) ? number : 0;
}

async function raiseFor(
  projects: SyncProject[],
  ctx: SyncContext,
  finding: GuardFinding,
  open: Map<string, Set<string>>,
  projectOf: (externalId: string) => string | null,
): Promise<void> {
  const owner = projectOf(finding.externalId);
  const targets = owner
    ? projects.filter((project) => project.projectId === owner)
    : projects;
  for (const project of targets.length ? targets : projects) {
    const dedupeKey = `${finding.kind}:${finding.externalId}`;
    open.get(project.projectId)?.add(dedupeKey);
    await AdsAlerts.raise(
      {
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        adsAccountId: ctx.account.id,
        externalId: finding.externalId,
        kind: finding.kind,
        severity: finding.severity,
        dedupeKey,
        title: finding.title,
        detail: finding.detail,
        data: finding.data,
      },
      ctx.now,
    );
  }
}

// G2 (docs/meta-ads-plan.md §6): lansman kampanyasının etkinleştirmeden bu
// yana harcaması onaylı zarfa ulaştı (Meta'daki spend_cap zarfın %110'u,
// ad set end_time zarfın sonu; bu bekçi %100'de durdurur).
async function envelopeFindings(ctx: SyncContext, objects: AdsObject[]): Promise<GuardFinding[]> {
  const launches = await prisma.adsLaunch.findMany({
    where: {
      adAccountExternalId: ctx.externalId,
      status: "ACTIVE",
      campaignExternalId: { not: null },
    },
    select: { campaignExternalId: true, spec: true, activatedAt: true, createdAt: true },
  });
  const out: GuardFinding[] = [];
  for (const launch of launches) {
    const campaign = objects.find(
      (object) =>
        object.level === "CAMPAIGN" &&
        object.externalId === launch.campaignExternalId &&
        object.configuredStatus === "ACTIVE" &&
        !object.goneAt,
    );
    const spec = parseLaunchSpec(launch.spec);
    if (!campaign || !spec) continue;
    const envelope = envelopeMinor(spec);
    const since = dayKeyInTimezone(launch.activatedAt ?? launch.createdAt, ctx.timezone);
    const spent = await prisma.adsInsightDaily.aggregate({
      where: {
        adsAccountId: ctx.account.id,
        level: "CAMPAIGN",
        externalId: campaign.externalId,
        date: { gte: dateOf(since) },
      },
      _sum: { spendMinor: true },
    });
    const spendMinor = Number(spent._sum.spendMinor ?? 0);
    if (envelope <= 0 || spendMinor < envelope) continue;
    out.push({
      kind: "ENVELOPE_REACHED",
      severity: "CRITICAL",
      externalId: campaign.externalId,
      title: `Approved budget used up: ${nameWithoutTag(campaign.name)}`,
      detail: `It spent ${formatMoney(spendMinor, ctx.currency)} of the ${formatMoney(envelope, ctx.currency)} you approved. Pause it, or approve more budget before it keeps spending.`,
      data: { envelopeMinor: envelope, spendMinor },
    });
  }
  return out;
}

async function monthlyCapFindings(
  ctx: SyncContext,
  objects: AdsObject[],
  open: Map<string, Set<string>>,
): Promise<void> {
  const policies = await prisma.autonomyPolicy.findMany({
    where: {
      projectId: { in: ctx.projects.map((project) => project.projectId) },
      adsMonthlyCapMinor: { not: null },
    },
    select: { projectId: true, adsMonthlyCapMinor: true },
  });
  if (policies.length === 0) return;
  const mtd = await prisma.adsInsightDaily.aggregate({
    where: {
      adsAccountId: ctx.account.id,
      level: "ACCOUNT",
      date: { gte: dateOf(`${ctx.today.slice(0, 7)}-01`) },
    },
    _sum: { spendMinor: true },
  });
  const spent = Number(mtd._sum.spendMinor ?? 0);
  for (const policy of policies) {
    const cap = Number(policy.adsMonthlyCapMinor ?? 0);
    const project = ctx.projects.find((row) => row.projectId === policy.projectId);
    if (!project || cap <= 0 || spent < cap) continue;
    const running = objects.filter(
      (object) =>
        object.level === "CAMPAIGN" &&
        object.createdByAgentelse &&
        object.projectId === project.projectId &&
        object.configuredStatus === "ACTIVE" &&
        !object.goneAt,
    );
    if (running.length === 0) continue;
    const dedupeKey = `MONTHLY_CAP_REACHED:${ctx.externalId}:${ctx.today.slice(0, 7)}`;
    open.get(project.projectId)?.add(dedupeKey);
    await AdsAlerts.raise(
      {
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        adsAccountId: ctx.account.id,
        externalId: ctx.externalId,
        kind: "MONTHLY_CAP_REACHED",
        severity: "CRITICAL",
        dedupeKey,
        title: "This month's ad spending cap is reached",
        detail: `Spent ${formatMoney(spent, ctx.currency)} this month against your cap of ${formatMoney(cap, ctx.currency)}. Pause your Agentelse campaigns or raise the cap in Settings.`,
        data: { capMinor: cap, spendMinor: spent },
      },
      ctx.now,
    );
    for (const campaign of running) {
      await autoPause(
        ctx,
        campaign,
        "G2_MONTHLY_CAP",
        `Paused "${nameWithoutTag(campaign.name)}": this month's ad spend reached your cap of ${formatMoney(cap, ctx.currency)}.`,
        { capMinor: cap, spendMinor: spent },
      );
    }
  }
}

function autoPauseText(
  finding: GuardFinding,
  campaign: AdsObject,
  currency: string | null,
): string {
  const name = nameWithoutTag(campaign.name);
  const data = (finding.data ?? {}) as Record<string, unknown>;
  const money = (value: unknown) => formatMoney(Number(value ?? 0), currency);
  if (finding.kind === "ENVELOPE_REACHED") {
    return `Paused "${name}": it spent ${money(data.spendMinor)}, the ${money(data.envelopeMinor)} you approved is used up.`;
  }
  return data.breach === "weekly"
    ? `Paused "${name}": it spent ${money(data.weekSpendMinor)} since Sunday, more than its weekly budget allows.`
    : `Paused "${name}": it spent ${money(data.todaySpendMinor)} today against a daily budget of ${money(data.budgetMinor)}.`;
}

async function autoPause(
  ctx: SyncContext,
  campaign: AdsObject,
  ruleKey: "G1_RUNAWAY" | "G2_ENVELOPE" | "G2_MONTHLY_CAP",
  explanation: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  const project =
    ctx.projects.find((row) => row.projectId === campaign.projectId) ?? ctx.projects[0];
  if (!project?.brandId) return;
  try {
    await AdsAutopilot.tryGuardPause({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      brandId: project.brandId,
      account: ctx.account,
      level: "CAMPAIGN",
      externalId: campaign.externalId,
      ruleKey,
      explanation,
      evidence,
      dayKey: ctx.today,
      now: ctx.now,
    });
  } catch (error) {
    console.error(
      `[ads-guard] automatic pause failed for ${campaign.externalId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

// F8 (META_ADS_AGENCY): günde bir kez hesap başına metrik anomalisi (dünün
// CPM / CPA / link CTR z-skoru) ve çalışan ad set'ler arasında kitle
// çakışması. Yalnız aynadan; bulgular uyarıdır (otomatik eylem yok).
async function dailyScaleChecks(ctx: SyncContext, objects: AdsObject[]): Promise<void> {
  if (!AdsFlags.agency()) return;
  if (!(await claimPeriodic(`ads.scale-checks:${ctx.account.id}`, 24 * 60 * 60_000, ctx.now))) {
    return;
  }
  const yesterday = addDays(ctx.today, -1);
  const rows = await prisma.adsInsightDaily.findMany({
    where: {
      adsAccountId: ctx.account.id,
      level: "ACCOUNT",
      date: { gte: dateOf(addDays(yesterday, -28)), lte: dateOf(yesterday) },
    },
    select: { date: true, spendMinor: true, impressions: true, linkClicks: true, results: true },
  });
  const anomalies = metricAnomalies(
    rows.map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      spendMinor: Number(row.spendMinor),
      impressions: row.impressions,
      linkClicks: row.linkClicks,
      results: row.results,
    })),
    yesterday,
  );
  const running = objects.filter(
    (object) =>
      object.level === "ADSET" &&
      !object.goneAt &&
      object.configuredStatus === "ACTIVE" &&
      object.effectiveStatus === "ACTIVE",
  );
  const pairs = overlappingPairs(
    running.flatMap((adSet) => {
      const targeting = adSet.targeting as TargetingSummary | null;
      return targeting
        ? [
            {
              externalId: adSet.externalId,
              name: nameWithoutTag(adSet.name),
              optimizationGoal: adSet.optimizationGoal,
              targeting,
            },
          ]
        : [];
    }),
  );
  for (const project of ctx.projects) {
    const open = new Set<string>();
    for (const anomaly of anomalies) {
      const dedupeKey = `METRIC_ANOMALY:${anomaly.metric}:${ctx.externalId}:${yesterday}`;
      open.add(dedupeKey);
      await AdsAlerts.raise(
        {
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          adsAccountId: ctx.account.id,
          externalId: ctx.externalId,
          kind: "METRIC_ANOMALY",
          severity: "WARN",
          dedupeKey,
          title: anomalyTitle(anomaly),
          detail:
            anomaly.metric === "LINK_CTR"
              ? "Far fewer people clicked than on a normal day. Check the ads and the link."
              : "Far above a normal day for this account. Check the auction, the audience and recent changes.",
          data: { ...anomaly, day: yesterday },
        },
        ctx.now,
      );
    }
    for (const pair of pairs) {
      const dedupeKey = `AUDIENCE_OVERLAP:${overlapKey(pair.a.externalId, pair.b.externalId)}`;
      open.add(dedupeKey);
      await AdsAlerts.raise(
        {
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          adsAccountId: ctx.account.id,
          externalId: pair.a.externalId,
          kind: "AUDIENCE_OVERLAP",
          severity: "INFO",
          dedupeKey,
          title: `Two ad sets target the same people: ${pair.a.name} and ${pair.b.name}`,
          detail:
            "They bid against each other in the same auctions, which pushes both costs up. Merge them, or exclude one audience from the other.",
        },
        ctx.now,
      );
    }
    await AdsAlerts.resolveMissing(
      {
        projectId: project.projectId,
        kinds: ["METRIC_ANOMALY", "AUDIENCE_OVERLAP"],
        stillOpen: open,
        adsAccountId: ctx.account.id,
      },
      ctx.now,
    );
  }
}

export const AdsGuard = {
  async evaluateAccount(ctx: SyncContext): Promise<void> {
    if (ctx.projects.length === 0) return;
    const objects = await prisma.adsObject.findMany({
      where: { adsAccountId: ctx.account.id },
    });
    const projectOf = (externalId: string) =>
      objects.find((object) => object.externalId === externalId)?.projectId ?? null;
    const open = new Map(ctx.projects.map((project) => [project.projectId, new Set<string>()]));
    const findings: GuardFinding[] = [];

    // G5 + G8.
    const guardObjects = objects.map(toGuardObject);
    findings.push(...deliveryFindings(guardObjects, ctx.now));
    const yesterday = addDays(ctx.today, -1);
    const weekStart = weekStartSunday(ctx.today);
    const since = weekStart < yesterday ? weekStart : yesterday;
    const rows = await prisma.adsInsightDaily.findMany({
      where: { adsAccountId: ctx.account.id, date: { gte: dateOf(since) } },
      select: {
        level: true,
        externalId: true,
        date: true,
        spendMinor: true,
        impressions: true,
        actions: true,
      },
    });
    if (ctx.account.lastInsightsAt) {
      const impressionsByAdSet = new Map<string, number>();
      for (const row of rows) {
        if (row.level !== "ADSET" || row.date < dateOf(yesterday)) continue;
        impressionsByAdSet.set(
          row.externalId,
          (impressionsByAdSet.get(row.externalId) ?? 0) + row.impressions,
        );
      }
      const cap = ctx.account.spendCapMinor;
      const spent = ctx.account.amountSpentMinor;
      findings.push(
        ...noDeliveryFindings({
          objects: guardObjects,
          impressionsByAdSet,
          accountCapReached: Boolean(cap && spent !== null && spent >= cap),
          now: ctx.now,
        }),
      );
    }

    // G1: kampanya toplamları (kimlikle okunan satırlar).
    const ops = await prisma.adsOperation.findMany({
      where: {
        adAccountExternalId: ctx.externalId,
        kind: { in: ["UPDATE_CAMPAIGN", "UPDATE_ADSET"] },
        createdAt: { gte: new Date(ctx.now.getTime() - 24 * 60 * 60_000) },
      },
      select: { targetExternalId: true, previousState: true, request: true },
    });
    const budgetsBefore = new Map<string, number>();
    for (const op of ops) {
      if (!op.targetExternalId) continue;
      const before = Math.max(budgetFromRequest(op.previousState), budgetFromRequest(op.request));
      if (before > (budgetsBefore.get(op.targetExternalId) ?? 0)) {
        budgetsBefore.set(op.targetExternalId, before);
      }
    }
    for (const campaign of objects.filter((object) => object.level === "CAMPAIGN" && !object.goneAt)) {
      const budget = dailyBudgetOf(campaign, objects, budgetsBefore);
      const campaignRows = rows.filter(
        (row) => row.level === "CAMPAIGN" && row.externalId === campaign.externalId,
      );
      const todaySpend = campaignRows
        .filter((row) => row.date.getTime() === dateOf(ctx.today).getTime())
        .reduce((sum, row) => sum + Number(row.spendMinor), 0);
      const weekSpend = campaignRows
        .filter((row) => row.date >= dateOf(weekStart))
        .reduce((sum, row) => sum + Number(row.spendMinor), 0);
      const breach = runawaySpend({
        dailyBudgetMinor: budget,
        todaySpendMinor: todaySpend,
        weekSpendMinor: weekSpend,
      });
      if (!breach || !budget) continue;
      findings.push({
        kind: "RUNAWAY_SPEND",
        severity: "CRITICAL",
        externalId: campaign.externalId,
        title: `Spending above plan: ${nameWithoutTag(campaign.name)}`,
        detail:
          breach === "daily"
            ? `Spent ${formatMoney(todaySpend, ctx.currency)} today against a daily budget of ${formatMoney(budget, ctx.currency)}. Meta normally stays under 1.75×. Pause it and check its budget in Ads Manager.`
            : `Spent ${formatMoney(weekSpend, ctx.currency)} since Sunday against ${formatMoney(budget * 7, ctx.currency)} for the week. Pause it and check its budget in Ads Manager.`,
        data: { breach, budgetMinor: budget, todaySpendMinor: todaySpend, weekSpendMinor: weekSpend },
      });
    }

    // G2 (F7): lansmanın onaylı zarfı doldu.
    findings.push(...(await envelopeFindings(ctx, objects)));

    for (const finding of findings) {
      await raiseFor(ctx.projects, ctx, finding, open, projectOf);
    }

    // G2: projenin aylık tavanı (Settings → Autonomy → Ads autopilot).
    await monthlyCapFindings(ctx, objects, open);

    // F7: kaçak harcama ve dolan zarf, Ads autopilot açıksa kendiliğinden
    // duraklatılır (kapılar ve günlük sınır AdsAutopilot'ta).
    for (const finding of findings) {
      const ruleKey =
        finding.kind === "RUNAWAY_SPEND"
          ? ("G1_RUNAWAY" as const)
          : finding.kind === "ENVELOPE_REACHED"
            ? ("G2_ENVELOPE" as const)
            : null;
      const campaign = objects.find(
        (object) =>
          object.level === "CAMPAIGN" &&
          object.externalId === finding.externalId &&
          object.configuredStatus === "ACTIVE" &&
          !object.goneAt,
      );
      if (!ruleKey || !campaign) continue;
      await autoPause(ctx, campaign, ruleKey, autoPauseText(finding, campaign, ctx.currency), finding.data ?? {});
    }

    // Bugün gelen lead'ler (gün başına tek uyarı, sayı güncellenir; önceki
    // günlerinki kapanır).
    const leads = leadsToday(rows, dateOf(ctx.today));
    const todayLeadsKey = `NEW_LEADS:${ctx.externalId}:${ctx.today}`;
    for (const project of ctx.projects) {
      await AdsAlerts.resolveMissing(
        {
          projectId: project.projectId,
          kinds: ["NEW_LEADS"],
          stillOpen: new Set(leads > 0 ? [todayLeadsKey] : []),
          adsAccountId: ctx.account.id,
        },
        ctx.now,
      );
    }
    if (leads > 0) {
      for (const project of ctx.projects) {
        await AdsAlerts.raise(
          {
            workspaceId: project.workspaceId,
            projectId: project.projectId,
            adsAccountId: ctx.account.id,
            externalId: ctx.externalId,
            kind: "NEW_LEADS",
            severity: "INFO",
            dedupeKey: todayLeadsKey,
            title: `New leads today: ${leads}`,
            detail: "Open Leads Center in Meta Business Suite to reply while they're fresh.",
            data: { count: leads },
          },
          ctx.now,
        );
      }
    }

    // Proje Agentelse'te duraklatılmış ama reklamlar Meta'da harcıyor.
    const sevenDaysAgo = dateOf(addDays(ctx.today, -7));
    const recentSpend = await prisma.adsInsightDaily.aggregate({
      where: {
        adsAccountId: ctx.account.id,
        level: "ACCOUNT",
        date: { gte: sevenDaysAgo },
      },
      _sum: { spendMinor: true },
    });
    const spending = Number(recentSpend._sum.spendMinor ?? 0) > 0;
    for (const project of ctx.projects) {
      if (spending && (project.status === "PAUSED" || project.status === "CLOSED")) {
        const dedupeKey = `PROJECT_PAUSED_ADS_RUNNING:${ctx.externalId}`;
        open.get(project.projectId)?.add(dedupeKey);
        await AdsAlerts.raise(
          {
            workspaceId: project.workspaceId,
            projectId: project.projectId,
            adsAccountId: ctx.account.id,
            externalId: ctx.externalId,
            kind: "PROJECT_PAUSED_ADS_RUNNING",
            severity: "WARN",
            dedupeKey,
            title: "Project paused in Agentelse, ads still running in Meta",
            detail: "Pausing the project doesn't stop your ads. Use Pause all if they should stop too.",
          },
          ctx.now,
        );
      }
      await AdsAlerts.resolveMissing(
        {
          projectId: project.projectId,
          kinds: OBJECT_ALERT_KINDS,
          stillOpen: open.get(project.projectId) ?? new Set(),
          adsAccountId: ctx.account.id,
        },
        ctx.now,
      );
    }

    await dailyScaleChecks(ctx, objects).catch((error: unknown) => {
      console.error(
        `[ads-guard] scale checks failed for ${ctx.externalId}:`,
        error instanceof Error ? error.message : error,
      );
    });
  },

  // Tick adımı (15 dakikada bir, süreçler arası kilitli).
  async runPeriodic(now: Date = new Date()): Promise<number> {
    if (!AdsFlags.sync()) return 0;
    if (metaWorkExcludedHere(process.env)) return 0;
    if (!(await claimPeriodic("ads.guard", PERIODIC_EVERY_MS, now))) return 0;

    const accounts = await prisma.adsAccount.findMany({
      where: { platform: "META", projects: { some: { selected: true } } },
      include: {
        projects: { where: { selected: true }, select: { projectId: true } },
      },
    });
    let raised = 0;
    for (const account of accounts) {
      const projects = await prisma.project.findMany({
        where: { id: { in: account.projects.map((link) => link.projectId) } },
        select: { id: true, workspaceId: true },
      });
      const credential = account.credentialId
        ? await prisma.integrationCredential.findUnique({
            where: { id: account.credentialId },
            select: { status: true, metadata: true },
          })
        : null;
      const delivering = await prisma.adsObject.count({
        where: {
          adsAccountId: account.id,
          level: "ADSET",
          effectiveStatus: "ACTIVE",
          goneAt: null,
          OR: [{ endTime: null }, { endTime: { gt: now } }],
        },
      });
      const findings: {
        kind: string;
        severity: "INFO" | "WARN" | "CRITICAL";
        title: string;
        detail: string;
      }[] = [];

      // Senkron nabzı.
      const stale =
        !account.lastInsightsAt ||
        now.getTime() - account.lastInsightsAt.getTime() > SYNC_STALE_MS;
      if (delivering > 0 && stale && credential?.status === "ACTIVE") {
        findings.push({
          kind: "SYNC_FAILING",
          severity: "WARN",
          title: "Ad numbers are out of date",
          detail: "Agentelse couldn't refresh this ad account for over 2 hours. We keep retrying.",
        });
      }

      // Token (G7).
      const health = (credential?.metadata as { tokenHealth?: MetaTokenHealth } | null)
        ?.tokenHealth;
      if (!credential || credential.status !== "ACTIVE" || health?.isValid === false) {
        findings.push({
          kind: "TOKEN_INVALID",
          severity: delivering > 0 ? "CRITICAL" : "WARN",
          title: "Reconnect Meta Ads: your connection expired",
          detail:
            delivering > 0
              ? "Your ads keep running in Meta, but Agentelse can't watch or pause them until you reconnect."
              : "Agentelse can't read or manage this ad account until you reconnect.",
        });
      } else {
        const days = tokenWarningDays(health, now);
        if (days !== null && days <= 7) {
          findings.push({
            kind: "TOKEN_EXPIRING",
            severity: "WARN",
            title: "Your Meta Ads connection expires soon",
            detail: `Reconnect within ${Math.max(days, 1)} day${days === 1 ? "" : "s"} to keep managing ads.`,
          });
        }
        if (health && health.missingScopes.length > 0) {
          findings.push({
            kind: "PERMISSION_MISSING",
            severity: "WARN",
            title: "Agentelse is missing a Meta permission",
            detail: "Reconnect Meta Ads and allow every permission it asks for.",
          });
        }
        if (
          health?.adAccountTargets &&
          health.adAccountTargets.length > 0 &&
          !health.adAccountTargets.includes(account.externalId)
        ) {
          findings.push({
            kind: "PERMISSION_MISSING",
            severity: "WARN",
            title: "Agentelse wasn't given access to this ad account",
            detail: "Reconnect Meta Ads and select this ad account.",
          });
        }
      }

      // Takılan yazma (yanıtı kaybolan oluşturma).
      const stuck = await prisma.adsOperation.count({
        where: {
          adAccountExternalId: account.externalId,
          status: { in: ["SENT", "UNKNOWN"] },
          sentAt: { lt: new Date(now.getTime() - OP_STUCK_MS) },
        },
      });
      if (stuck > 0) {
        findings.push({
          kind: "CHAIN_STUCK",
          severity: "WARN",
          title: "A change to your ads is still unconfirmed",
          detail: "Meta didn't confirm a recent change. Agentelse is checking whether it went through.",
        });
      }

      // Yetim duraklatılmış Agentelse kampanyası.
      const orphans = await prisma.adsObject.count({
        where: {
          adsAccountId: account.id,
          level: "CAMPAIGN",
          createdByAgentelse: true,
          configuredStatus: "PAUSED",
          lastDeliveryAt: null,
          goneAt: null,
          createdAt: { lt: new Date(now.getTime() - ORPHAN_AFTER_MS) },
        },
      });
      if (orphans > 0) {
        findings.push({
          kind: "ORPHAN_OBJECT",
          severity: "INFO",
          title: `${orphans} paused campaign${orphans === 1 ? "" : "s"} from Agentelse never ran`,
          detail: "You can archive them in Ads Manager to keep the account tidy.",
        });
      }

      for (const project of projects) {
        const open = new Set<string>();
        for (const finding of findings) {
          const dedupeKey = `${finding.kind}:${account.externalId}:${finding.title}`;
          open.add(dedupeKey);
          await AdsAlerts.raise(
            {
              workspaceId: project.workspaceId,
              projectId: project.id,
              adsAccountId: account.id,
              externalId: account.externalId,
              kind: finding.kind,
              severity: finding.severity,
              dedupeKey,
              title: finding.title,
              detail: finding.detail,
            },
            now,
          );
          raised += 1;
        }
        await AdsAlerts.resolveMissing(
          {
            projectId: project.id,
            kinds: ["SYNC_FAILING", "TOKEN_INVALID", "TOKEN_EXPIRING", "PERMISSION_MISSING", "CHAIN_STUCK", "ORPHAN_OBJECT"],
            stillOpen: open,
            adsAccountId: account.id,
          },
          now,
        );
      }
    }
    return raised;
  },

  // Hesap saatiyle bugün (UI ve özet).
  accountToday(timezoneName: string | null, now: Date = new Date()): string {
    return dayKeyInTimezone(now, safeTimezone(timezoneName));
  },
};

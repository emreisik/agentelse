"use server";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { revalidatePath } from "next/cache";

import { AdsFlags } from "@/lib/ads/flags";
import {
  adSetEndTime,
  blockingIssues,
  envelopeMinor,
  parseLaunchSpec,
  specHash,
  type AdsLaunchSpec,
} from "@/lib/ads/launch-spec";
import { formatMoney } from "@/lib/ads/money";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone, zonedDateTimeToUtc } from "@/lib/timezone";
import { ADS_FLOW_COPY } from "@/lib/module-flows/ads/copy";
import {
  launchSpecFromFlow,
  type AdsLaunchCheck,
  type LaunchBuildContext,
} from "@/lib/module-flows/ads/launch";
import {
  ADS_OBJECTIVE_META,
  audienceLine,
  parseAdsFlowState,
  viewStepOf,
  type AdsBrief,
  type AdsPlan,
} from "@/lib/module-flows/ads/state";
import { AdsAccounts } from "@/server/ads/accounts";
import { driveLaunchInline } from "@/server/ads/launch/drive";
import { AdsLaunches } from "@/server/ads/launch/store";
import {
  prepareLaunch,
  type LaunchValidation,
} from "@/server/ads/launch/validate";
import { driveJobInline } from "@/server/chat/inline-job";
import { applyApprovalDecision } from "@/server/commands/approval-decisions";
import { TaskPlanner } from "@/server/commands/task-planner";
import { readAdsCard, writeAdsCard } from "@/server/modules/ads/flow-card";
import {
  GUARD_MESSAGE,
  authorizeWorks,
  guardedAction,
} from "@/server/works/guard";

// Güvenli lansman v2'nin kart eylemleri (docs/meta-ads-plan.md F3,
// `META_ADS_LAUNCH_V2`). Review'da ön kontrol (prepare), tek dokunuşla onay ve
// başlatma; Launch adımında "Try again", "Turn on" ve "Discard". Her deneme
// ayrı bir görevdir ve aynı AdsLaunch kaydına bağlanır.

const WRITE = { bucket: "ads-flow", limit: 60 } as const;
const PREPARE = { bucket: "ads-launch-check", limit: 20 } as const;
const LAUNCH = { bucket: "ads-launch", limit: 10 } as const;

export type PrepareAdsLaunchResult =
  | { ok: true; check: AdsLaunchCheck }
  | { ok: false; message: string; code?: "V2_OFF" };

export type AdsLaunchV2Result =
  { ok: true; waitingAdmin?: boolean } | { ok: false; message: string };

function failed(message: string = GUARD_MESSAGE.failed) {
  return { ok: false as const, message };
}

function refresh(projectId: string): void {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/ads`);
}

function endsOnText(spec: AdsLaunchSpec, now: Date): string {
  const end = adSetEndTime(
    now,
    spec.budget.durationDays,
    spec.timezone,
    zonedDateTimeToUtc,
    dayKeyInTimezone,
  );
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: spec.timezone,
  }).format(end);
}

function checkOf(
  launchId: string,
  spec: AdsLaunchSpec,
  validation: LaunchValidation,
  now: Date,
): AdsLaunchCheck {
  return {
    launchId,
    ready: blockingIssues(validation.issues).length === 0,
    issues: validation.issues.map((issue) => ({
      severity: issue.severity,
      message: issue.message,
      field: issue.field,
    })),
    previews: validation.previews,
    envelope: formatMoney(envelopeMinor(spec), spec.currency),
    spendCap:
      spec.guards.campaignSpendCapMinor !== null
        ? formatMoney(spec.guards.campaignSpendCapMinor, spec.currency)
        : null,
    endsOn: endsOnText(spec, now),
    timezone: spec.timezone,
    featuresFallback: Boolean(validation.featuresFallback),
  };
}

function contextFromSpec(
  spec: AdsLaunchSpec,
  minCap: number | null,
): LaunchBuildContext {
  return {
    adAccountId: spec.adAccountId,
    currency: spec.currency,
    timezone: spec.timezone,
    pageId: spec.pageId,
    ...(spec.instagramUserId ? { instagramUserId: spec.instagramUserId } : {}),
    minCampaignSpendCapMinor: minCap,
    dsaBeneficiary: null,
    dsaPayor: null,
  };
}

function summaryOf(
  spec: AdsLaunchSpec,
  brief: AdsBrief,
  accountName?: string,
  pageName?: string,
) {
  const objective = ADS_OBJECTIVE_META[brief.objective];
  return {
    currency: spec.currency,
    envelopeMinor: envelopeMinor(spec),
    dailyMinor: spec.budget.dailyMinor,
    days: spec.budget.durationDays,
    spendCapMinor: spec.guards.campaignSpendCapMinor,
    objective: `${objective.label} · ${objective.goalLabel}`,
    audience: audienceLine(brief),
    ...(accountName ? { account: accountName } : {}),
    ...(pageName ? { page: pageName } : {}),
    timezone: spec.timezone,
    activate: spec.activate,
  };
}

// Görev planlanır (L4 onay açılır) ve tıklayan kişi harcamayı onaylayabiliyorsa
// aynı dokunuşta onaylanır; iş `after()` ile istek beklemeden sürülür.
async function planAndStart(input: {
  auth: { workspaceId: string; defaultBrandId: string; userId: string };
  projectId: string;
  commandId: string;
  launchId: string;
  mode: "create" | "activate";
  request: string;
  summary: Record<string, unknown>;
  adAccountId: string;
}): Promise<{ waitingAdmin: boolean }> {
  const planned = await TaskPlanner.planForCapability({
    workspaceId: input.auth.workspaceId,
    projectId: input.projectId,
    brandId: input.auth.defaultBrandId,
    commandId: input.commandId,
    capability: "META_LAUNCH",
    request: input.request,
    createdByType: "USER",
    createdByUserId: input.auth.userId,
    departmentKey: "PERFORMANCE_MARKETING",
    payloadExtra: {
      launchId: input.launchId,
      mode: input.mode,
      adAccountId: input.adAccountId,
      currency: input.summary.currency,
      summary: input.summary,
    },
  });
  const approval = await prisma.approval.findFirst({
    where: { taskId: planned.task.id, status: "PENDING" },
  });
  await prisma.adsLaunch.update({
    where: { id: input.launchId },
    data: {
      currentTaskId: planned.task.id,
      ...(input.mode === "create"
        ? { status: "AWAITING_APPROVAL", approvalId: approval?.id ?? null }
        : { activationApprovalId: approval?.id ?? null }),
    },
  });
  if (!approval) return { waitingAdmin: false };
  try {
    await applyApprovalDecision({
      approval,
      to: "APPROVED",
      reviewedByUserId: input.auth.userId,
      actorType: "USER",
    });
  } catch {
    // Harcamayı yalnız OWNER/ADMIN onaylar (F0b): onay bekler.
    return { waitingAdmin: true };
  }
  const job = await prisma.executionJob.findFirst({
    where: { taskId: planned.task.id },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (job) after(() => driveLaunchInline(job.id));
  return { waitingAdmin: false };
}

// ---- Review: ön kontrol -------------------------------------------------------

export async function prepareAdsLaunchAction(
  projectId: string,
  commandId: string,
): Promise<PrepareAdsLaunchResult> {
  if (!AdsFlags.launchV2()) return { ok: false, message: "", code: "V2_OFF" };
  const result = await guardedAction(
    "ads-launch-check",
    async (): Promise<PrepareAdsLaunchResult> => {
      const gate = await authorizeWorks(projectId, PREPARE);
      if (!gate.ok) return failed(gate.message);
      const found = await readAdsCard(projectId, commandId);
      if (!found) return failed();
      const state = parseAdsFlowState(found.card.data);
      if (state.launch) return failed(ADS_FLOW_COPY.launchedAlready);
      const { brief, plan } = state;
      if (!brief || !plan || viewStepOf(found.card.step, state) !== "review") {
        return failed(ADS_FLOW_COPY.movedOn);
      }
      const now = new Date();
      const prepared = await prepareLaunch({
        workspaceId: gate.auth.workspaceId,
        projectId,
        workId: found.workId,
        commandId: found.commandId,
        userId: gate.auth.userId,
        build: (context) =>
          launchSpecFromFlow({ brief, plan, context, activate: true }),
        now,
      });
      if (!prepared.ok) return failed(prepared.message);
      return {
        ok: true,
        check: checkOf(
          prepared.launch.id,
          prepared.spec,
          prepared.validation,
          now,
        ),
      };
    },
  );
  return result.ok ? result : failed(result.message);
}

// ---- Approve & launch ----------------------------------------------------------

export async function launchAdsV2Action(
  projectId: string,
  commandId: string,
  options: { activate?: boolean } = {},
): Promise<AdsLaunchV2Result> {
  if (!AdsFlags.launchV2()) return failed();
  const result = await guardedAction(
    "ads-launch-v2",
    async (): Promise<AdsLaunchV2Result> => {
      const gate = await authorizeWorks(projectId, LAUNCH);
      if (!gate.ok) return failed(gate.message);
      const found = await readAdsCard(projectId, commandId);
      if (!found) return failed();
      const stored = parseAdsFlowState(found.card.data);
      if (stored.launch) return { ok: true };
      const brief: AdsBrief | undefined = stored.brief;
      const plan: AdsPlan | undefined = stored.plan;
      if (!brief || !plan || viewStepOf(found.card.step, stored) !== "review") {
        return failed(ADS_FLOW_COPY.movedOn);
      }

      const latest = await AdsLaunches.latestForCommand(found.commandId);
      const latestSpec = latest ? parseLaunchSpec(latest.spec) : null;
      if (!latest || !latestSpec || latest.status !== "VALIDATED") {
        return failed(ADS_FLOW_COPY.checkFailed);
      }
      const account = await AdsAccounts.resolve(projectId);
      if (account.adAccountId !== latestSpec.adAccountId) {
        return failed(ADS_FLOW_COPY.accountChanged);
      }
      // Onay, kontrol edilen spec'e verilir: Brief / Plan sonradan değiştiyse
      // yeniden kontrol gerekir.
      const activate = options.activate !== false;
      const spec = launchSpecFromFlow({
        brief,
        plan,
        context: contextFromSpec(
          latestSpec,
          latestSpec.guards.campaignSpendCapMinor,
        ),
        activate,
      });
      spec.guards = latestSpec.guards;
      if (specHash(spec) !== specHash({ ...latestSpec, activate })) {
        return failed(ADS_FLOW_COPY.briefChanged);
      }

      const claimId = randomUUID();
      const claim = await writeAdsCard(
        projectId,
        found.commandId,
        (card, state) => {
          if (state.launch) return { reject: ADS_FLOW_COPY.launchedAlready };
          if (viewStepOf(card.step, state) !== "review")
            return { reject: ADS_FLOW_COPY.movedOn };
          return {
            step: "deliver",
            state: {
              ...state,
              launch: {
                claimId,
                startedAt: new Date().toISOString(),
                launchId: latest.id,
              },
            },
          };
        },
      );
      if (!claim.ok) return failed(claim.message);

      try {
        await prisma.adsLaunch.update({
          where: { id: latest.id },
          data: { spec: spec as never, specHash: specHash(spec) },
        });
        const started = await planAndStart({
          auth: gate.auth,
          projectId,
          commandId: found.commandId,
          launchId: latest.id,
          mode: "create",
          request: `Launch Meta campaign: ${plan.campaignName}`,
          summary: summaryOf(
            spec,
            brief,
            account.adAccountName,
            account.pageName,
          ),
          adAccountId: spec.adAccountId,
        });
        refresh(projectId);
        return {
          ok: true,
          ...(started.waitingAdmin ? { waitingAdmin: true } : {}),
        };
      } catch (error) {
        console.error(
          "[works] ads launch v2 failed:",
          error instanceof Error ? error.message : error,
        );
        // Kart Review'a döner; lansman yeniden denenebilir.
        await writeAdsCard(projectId, found.commandId, (_card, state) => {
          if (state.launch?.claimId !== claimId)
            return { reject: ADS_FLOW_COPY.movedOn };
          const next = { ...state };
          delete next.launch;
          return { step: "review", state: next };
        }).catch(() => undefined);
        refresh(projectId);
        return failed();
      }
    },
  );
  return result.ok ? result : failed(result.message);
}

// ---- Launch adımı: Try again / Turn on / Discard --------------------------------

async function launchOfCard(projectId: string, commandId: string) {
  const found = await readAdsCard(projectId, commandId);
  if (!found) return null;
  const launchId = parseAdsFlowState(found.card.data).launch?.launchId;
  if (!launchId) return null;
  const launch = await AdsLaunches.forProject(launchId, projectId);
  return launch ? { found, launch } : null;
}

// Kart başına aynı anda en çok bir açık lansman görevi.
async function openTask(taskId: string | null): Promise<boolean> {
  if (!taskId) return false;
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true },
  });
  return Boolean(
    task &&
    ["QUEUED", "RUNNING", "WAITING_APPROVAL", "READY"].includes(task.status),
  );
}

export async function retryAdsLaunchAction(
  projectId: string,
  commandId: string,
): Promise<AdsLaunchV2Result> {
  const result = await guardedAction(
    "ads-launch-retry",
    async (): Promise<AdsLaunchV2Result> => {
      const gate = await authorizeWorks(projectId, LAUNCH);
      if (!gate.ok) return failed(gate.message);
      const current = await launchOfCard(projectId, commandId);
      if (!current) return failed(ADS_FLOW_COPY.movedOn);
      const { found, launch } = current;
      if (launch.status !== "FAILED") return failed(ADS_FLOW_COPY.stillGoing);
      if (await openTask(launch.currentTaskId))
        return failed(ADS_FLOW_COPY.stillGoing);
      const spec = parseLaunchSpec(launch.spec);
      const state = parseAdsFlowState(found.card.data);
      if (!spec || !state.brief) return failed();
      const account = await AdsAccounts.resolve(projectId);
      const started = await planAndStart({
        auth: gate.auth,
        projectId,
        commandId: found.commandId,
        launchId: launch.id,
        mode: "create",
        request: `Retry Meta launch: ${spec.campaignName}`,
        summary: summaryOf(
          spec,
          state.brief,
          account.adAccountName,
          account.pageName,
        ),
        adAccountId: spec.adAccountId,
      });
      refresh(projectId);
      return {
        ok: true,
        ...(started.waitingAdmin ? { waitingAdmin: true } : {}),
      };
    },
  );
  return result.ok ? result : failed(result.message);
}

export async function turnOnAdsLaunchAction(
  projectId: string,
  commandId: string,
): Promise<AdsLaunchV2Result> {
  const result = await guardedAction(
    "ads-launch-activate",
    async (): Promise<AdsLaunchV2Result> => {
      const gate = await authorizeWorks(projectId, LAUNCH);
      if (!gate.ok) return failed(gate.message);
      const current = await launchOfCard(projectId, commandId);
      if (!current) return failed(ADS_FLOW_COPY.movedOn);
      const { found, launch } = current;
      if (launch.status !== "CREATED_PAUSED")
        return failed(ADS_FLOW_COPY.movedOn);
      if (await openTask(launch.currentTaskId))
        return failed(ADS_FLOW_COPY.stillGoing);
      const spec = parseLaunchSpec(launch.spec);
      const state = parseAdsFlowState(found.card.data);
      if (!spec || !state.brief) return failed();
      const account = await AdsAccounts.resolve(projectId);
      const started = await planAndStart({
        auth: gate.auth,
        projectId,
        commandId: found.commandId,
        launchId: launch.id,
        mode: "activate",
        request: `Turn on Meta campaign: ${spec.campaignName}`,
        summary: summaryOf(
          { ...spec, activate: true },
          state.brief,
          account.adAccountName,
          account.pageName,
        ),
        adAccountId: spec.adAccountId,
      });
      refresh(projectId);
      return {
        ok: true,
        ...(started.waitingAdmin ? { waitingAdmin: true } : {}),
      };
    },
  );
  return result.ok ? result : failed(result.message);
}

// "Discard": güvenlik eylemi (L0, kullanıcının tıklaması onaydır).
export async function discardAdsLaunchAction(
  projectId: string,
  commandId: string,
): Promise<AdsLaunchV2Result> {
  const result = await guardedAction(
    "ads-launch-discard",
    async (): Promise<AdsLaunchV2Result> => {
      const gate = await authorizeWorks(projectId, WRITE);
      if (!gate.ok) return failed(gate.message);
      const current = await launchOfCard(projectId, commandId);
      if (!current) return failed(ADS_FLOW_COPY.movedOn);
      const { found, launch } = current;
      if (launch.status === "DISCARDED") return { ok: true };
      if (await openTask(launch.currentTaskId))
        return failed(ADS_FLOW_COPY.stillGoing);
      const planned = await TaskPlanner.planForCapability({
        workspaceId: gate.auth.workspaceId,
        projectId,
        brandId: gate.auth.defaultBrandId,
        commandId: found.commandId,
        capability: "META_SAFETY_ACTION",
        request: "Discard the half-made Meta launch",
        createdByType: "USER",
        createdByUserId: gate.auth.userId,
        departmentKey: "PERFORMANCE_MARKETING",
        payloadExtra: {
          action: "DISCARD_LAUNCH",
          launchId: launch.id,
          adAccountId: launch.adAccountExternalId,
          reason: "User pressed Discard",
        },
      });
      if (!planned.dispatched || !("job" in planned) || !planned.job)
        return failed();
      const settled = await driveJobInline(planned.job.id, "LOW");
      refresh(projectId);
      return settled.status === "COMPLETED"
        ? { ok: true }
        : failed(settled.errorMessage ?? GUARD_MESSAGE.failed);
    },
  );
  return result.ok ? result : failed(result.message);
}

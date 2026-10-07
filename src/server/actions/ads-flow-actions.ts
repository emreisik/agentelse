"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import type { AdsChain } from "@/lib/module-flows/ads/chain";
import { ADS_ACCOUNT_COPY, ADS_FLOW_COPY } from "@/lib/module-flows/ads/copy";
import {
  ADS_BRIEF_ISSUE,
  AdsBriefInputSchema,
  AdsPlanInputSchema,
  adsLaunchPayload,
  briefChangesPlan,
  briefIssue,
  needsLaunchV2,
  normalizeBudget,
  parseAdsFlowState,
  planIssue,
  targetsEuEea,
  viewStepOf,
  type AdsAccountView,
  type AdsBrief,
  type AdsBriefOptions,
  type AdsFlowState,
  type AdsPlan,
} from "@/lib/module-flows/ads/state";
import { MODULE_FLOW_STEPS } from "@/lib/module-flows/card";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import { TaskPlanner } from "@/server/commands/task-planner";
import { loadAdsAccount } from "@/server/modules/ads/account";
import { loadAdsBriefOptions } from "@/server/modules/ads/brief-options";
import { loadAdsChain, loadLaunchChain } from "@/server/modules/ads/chain";
import { readAdsCard, writeAdsCard } from "@/server/modules/ads/flow-card";
import { draftAdsPlan } from "@/server/modules/ads/draft-plan";
import { findSourcePost } from "@/server/modules/ads/source-posts";
import {
  GUARD_MESSAGE,
  assertWorkActive,
  authorizeWorks,
  guardedAction,
} from "@/server/works/guard";

// The Ads Manager flow's actions (docs/modules.md "Ads Manager"): one card in
// the Work's chat walks Brief -> Plan -> Create -> Review -> Launch. Every
// write goes through updateModuleFlowCard (atomic; a completed Work refuses);
// reads are tenant-scoped by the project. Launching plans ONE Task, the
// campaign, with this card's Command as its lineage; the existing relays plan
// the ad set and the ad once the step before is created, each behind its own
// approval, and everything is created PAUSED.

const WRITE = { bucket: "ads-flow", limit: 60 } as const;
// The Launch step re-reads while Meta works (a few reads a minute).
const READ = { bucket: "ads-flow-read", limit: 240 } as const;
const PLAN = { bucket: "ads-plan", limit: 20 } as const;
const LAUNCH = { bucket: "ads-launch", limit: 10 } as const;

export type AdsFlowResult = { ok: true } | { ok: false; message: string };

export type AdsBriefOptionsResult =
  { ok: true; options: AdsBriefOptions } | { ok: false; message: string };

export type SaveAdsBriefResult =
  { ok: true; hasPlan: boolean } | { ok: false; message: string };

export type DraftAdsPlanResult =
  { ok: true; plan: AdsPlan } | { ok: false; message: string };

export type AdsLaunchResult =
  { ok: true; chain: AdsChain } | { ok: false; message: string };

function failed(message: string = GUARD_MESSAGE.failed) {
  return { ok: false as const, message };
}

function refresh(projectId: string, extra: readonly string[] = []): void {
  for (const path of [`/projects/${projectId}`, ...extra]) {
    revalidatePath(path);
  }
}

function accountBlock(account: AdsAccountView): string | null {
  return account.status === "ready"
    ? null
    : ADS_ACCOUNT_COPY[account.status].blocked;
}

function withoutLaunch(state: AdsFlowState): AdsFlowState {
  const next: AdsFlowState = { ...state };
  delete next.launch;
  return next;
}

// The card's read / write helpers live in src/server/modules/ads/flow-card.ts
// (shared with the launch v2 actions).
const writeCard = writeAdsCard;

// ---- Brief ---------------------------------------------------------------------

export async function loadAdsBriefOptionsAction(
  projectId: string,
  commandId: string,
): Promise<AdsBriefOptionsResult> {
  const result = await guardedAction(
    "ads-brief-options",
    async (): Promise<AdsBriefOptionsResult> => {
      const gate = await authorizeWorks(projectId, READ);
      if (!gate.ok) return failed(gate.message);
      const found = await readAdsCard(projectId, commandId);
      if (!found) return failed();
      const state = parseAdsFlowState(found.card.data);
      // The chosen post, else the hinted one, is offered even when older.
      const include =
        state.brief?.source.creativeId ?? state.hint?.sourceCreativeId;
      const options = await loadAdsBriefOptions(
        projectId,
        include ? { include } : {},
      );
      return { ok: true, options };
    },
  );
  return result.ok ? result : failed(result.message);
}

export async function saveAdsBriefAction(
  projectId: string,
  commandId: string,
  input: unknown,
): Promise<SaveAdsBriefResult> {
  const result = await guardedAction(
    "ads-brief-save",
    async (): Promise<SaveAdsBriefResult> => {
      const gate = await authorizeWorks(projectId, WRITE);
      if (!gate.ok) return failed(gate.message);
      const parsed = AdsBriefInputSchema.safeParse(input);
      if (!parsed.success) {
        return failed(briefIssue(input) ?? ADS_BRIEF_ISSUE.other);
      }
      const found = await readAdsCard(projectId, commandId);
      if (!found) return failed();

      const account = await loadAdsAccount(projectId);
      const blocked = accountBlock(account);
      if (blocked) return failed(blocked);
      const given = parsed.data;
      const source = await findSourcePost(projectId, given.creativeId);
      if (!source) return failed(ADS_FLOW_COPY.postGone);
      // F5b: ek postlar (kreatif çeşitliliği), ana postla aynı kurallarla.
      const extraIds = [...new Set(given.extraCreativeIds ?? [])].filter(
        (id) => id !== given.creativeId,
      );
      const extraSources = [];
      for (const id of extraIds) {
        const extra = await findSourcePost(projectId, id);
        if (!extra) return failed(ADS_FLOW_COPY.postGone);
        extraSources.push(extra);
      }

      // The budget as Meta will hold it in the ad account's currency.
      const dailyBudget = normalizeBudget(given.dailyBudget, account.currency);
      if (!(dailyBudget > 0)) return failed(ADS_BRIEF_ISSUE.budget);
      const brief: AdsBrief = {
        objective: given.objective,
        dailyBudget,
        days: given.days,
        countries: [...new Set(given.countries)],
        ageMin: given.ageMin,
        ageMax: given.ageMax,
        gender: given.gender,
        link: given.link.trim(),
        callToAction: given.callToAction,
        // F5a: mesaj hedefi ve trafikte optimize edilen olay.
        ...(given.messages ? { messages: given.messages } : {}),
        ...(given.trafficEvent && !given.messages
          ? { trafficEvent: given.trafficEvent }
          : {}),
        // F5b
        ...(given.kpi ? { kpi: given.kpi } : {}),
        ...(given.audienceMode ? { audienceMode: given.audienceMode } : {}),
        ...(given.budgetMode ? { budgetMode: given.budgetMode } : {}),
        ...(given.existingAdSetId ? { existingAdSetId: given.existingAdSetId } : {}),
        ...(given.leadForm && given.objective === "OUTCOME_LEADS"
          ? { leadForm: given.leadForm }
          : {}),
        ...(extraSources.length > 0 ? { extraSources } : {}),
        // Carousel: seçilen bütün postlar tek reklamın kartları.
        ...(given.adFormat === "carousel" && extraSources.length > 0
          ? { adFormat: "carousel" as const }
          : {}),
        source,
        ...(account.currency ? { currency: account.currency } : {}),
        ...(account.pageName ? { pageName: account.pageName } : {}),
        ...(account.adAccountId ? { adAccountId: account.adAccountId } : {}),
        // DSA: yalnız AB/AEA hedefinde saklanır ve ad set'e gider.
        ...(targetsEuEea(given.countries) &&
        given.dsaBeneficiary &&
        given.dsaPayor
          ? {
              dsaBeneficiary: given.dsaBeneficiary.trim(),
              dsaPayor: given.dsaPayor.trim(),
            }
          : {}),
      };

      let hasPlan = false;
      const write = await writeCard(projectId, found.commandId, (_c, state) => {
        if (state.launch) return { reject: ADS_FLOW_COPY.launchedAlready };
        // Another post or goal makes the written ad stale.
        const next: AdsFlowState = { ...state, brief };
        if (briefChangesPlan(state.brief, brief)) delete next.plan;
        hasPlan = Boolean(next.plan);
        return { step: "plan", state: next };
      });
      if (!write.ok) return failed(write.message);
      refresh(projectId);
      return { ok: true, hasPlan };
    },
  );
  return result.ok ? result : failed(result.message);
}

// ---- Plan ----------------------------------------------------------------------

export async function draftAdsPlanAction(
  projectId: string,
  commandId: string,
  options: { regenerate?: boolean } = {},
): Promise<DraftAdsPlanResult> {
  const result = await guardedAction(
    "ads-plan-draft",
    async (): Promise<DraftAdsPlanResult> => {
      const gate = await authorizeWorks(projectId, PLAN);
      if (!gate.ok) return failed(gate.message);
      const found = await readAdsCard(projectId, commandId);
      if (!found) return failed();
      const state = parseAdsFlowState(found.card.data);
      const brief = state.brief;
      if (state.launch) return failed(ADS_FLOW_COPY.launchedAlready);
      if (!brief) return failed(ADS_FLOW_COPY.movedOn);
      // Already written (another tab, a repeated tap): no second model call.
      if (state.plan && options?.regenerate !== true) {
        return { ok: true, plan: state.plan };
      }
      // A completed Work refuses before the model is paid for.
      const active = await assertWorkActive(prisma, {
        workId: found.workId,
        projectId,
      });
      if (!active.ok) return failed(active.message);

      const drafted = await draftAdsPlan({
        scope: {
          workspaceId: gate.auth.workspaceId,
          projectId,
          brandId: gate.auth.defaultBrandId,
        },
        brief,
        language: await brandRuleLanguageOf(projectId),
      });
      if (!drafted.ok) return failed(drafted.message);

      const write = await writeCard(projectId, found.commandId, (card, now) => {
        if (now.launch) return { reject: ADS_FLOW_COPY.launchedAlready };
        // Written for this brief, on the Plan: anything else moved on meanwhile.
        if (
          !now.brief ||
          briefChangesPlan(now.brief, brief) ||
          viewStepOf(card.step, now) !== "plan"
        ) {
          return { reject: ADS_FLOW_COPY.briefChanged };
        }
        return { step: "plan", state: { ...now, plan: drafted.plan } };
      });
      if (!write.ok) return failed(write.message);
      refresh(projectId);
      return { ok: true, plan: drafted.plan };
    },
  );
  return result.ok ? result : failed(result.message);
}

export async function saveAdsPlanAction(
  projectId: string,
  commandId: string,
  input: unknown,
): Promise<AdsFlowResult> {
  const result = await guardedAction(
    "ads-plan-save",
    async (): Promise<AdsFlowResult> => {
      const gate = await authorizeWorks(projectId, WRITE);
      if (!gate.ok) return failed(gate.message);
      const parsed = AdsPlanInputSchema.safeParse(input);
      if (!parsed.success) return failed(planIssue(input) ?? undefined);
      const found = await readAdsCard(projectId, commandId);
      if (!found) return failed();

      const write = await writeCard(
        projectId,
        found.commandId,
        (card, state) => {
          if (state.launch) return { reject: ADS_FLOW_COPY.launchedAlready };
          if (!state.brief || viewStepOf(card.step, state) !== "plan") {
            return { reject: ADS_FLOW_COPY.movedOn };
          }
          // The brand-rule note is about the AI's words: it stays only while the
          // text is still theirs.
          const flags =
            state.plan?.flags &&
            state.plan.primaryText === parsed.data.primaryText
              ? state.plan.flags
              : undefined;
          const plan: AdsPlan = { ...parsed.data, ...(flags ? { flags } : {}) };
          return { step: "create", state: { ...state, plan } };
        },
      );
      if (!write.ok) return failed(write.message);
      refresh(projectId);
      return { ok: true };
    },
  );
  return result.ok ? result : failed(result.message);
}

// Back to an earlier step (Back, or a done step in the stepper), or Create ->
// Review. Before the launch only: a launched ad stays on its Launch step.
export async function setAdsStepAction(
  projectId: string,
  commandId: string,
  step: string,
): Promise<AdsFlowResult> {
  const result = await guardedAction(
    "ads-step",
    async (): Promise<AdsFlowResult> => {
      const gate = await authorizeWorks(projectId, WRITE);
      if (!gate.ok) return failed(gate.message);
      const target = MODULE_FLOW_STEPS.find((key) => key === step);
      if (!target || target === "deliver") return failed();
      const found = await readAdsCard(projectId, commandId);
      if (!found) return failed();

      const write = await writeCard(
        projectId,
        found.commandId,
        (card, state) => {
          if (state.launch) return { reject: ADS_FLOW_COPY.launchedAlready };
          const current = viewStepOf(card.step, state);
          const forward = current === "create" && target === "review";
          const back =
            MODULE_FLOW_STEPS.indexOf(target) <
            MODULE_FLOW_STEPS.indexOf(current);
          if (!forward && !back) return { reject: ADS_FLOW_COPY.movedOn };
          return { step: target, state };
        },
      );
      if (!write.ok) return failed(write.message);
      refresh(projectId);
      return { ok: true };
    },
  );
  return result.ok ? result : failed(result.message);
}

// ---- Launch ----------------------------------------------------------------------

export async function launchAdsAction(
  projectId: string,
  commandId: string,
): Promise<AdsFlowResult> {
  const result = await guardedAction(
    "ads-launch",
    async (): Promise<AdsFlowResult> => {
      const gate = await authorizeWorks(projectId, LAUNCH);
      if (!gate.ok) return failed(gate.message);
      const found = await readAdsCard(projectId, commandId);
      if (!found) return failed();
      const stored = parseAdsFlowState(found.card.data);
      // A second tap after the launch is the same launch.
      if (stored.launch) return { ok: true };
      const { brief, plan } = stored;
      if (!brief || !plan || viewStepOf(found.card.step, stored) !== "review") {
        return failed(ADS_FLOW_COPY.movedOn);
      }
      // Eski üç onaylı zincir mesaj, form, sabit bütçe, çoklu post ya da
      // mevcut ad set kuramaz (F5a/F5b yalnız v2'de).
      if (needsLaunchV2(brief)) return failed(ADS_FLOW_COPY.messagesNeedV2);

      const account = await loadAdsAccount(projectId);
      const blocked = accountBlock(account);
      if (blocked) return failed(blocked);
      // The budget was set in the ad account's currency: another account (or
      // currency) since the Brief means the amount must be looked at again.
      if ((account.currency ?? null) !== (brief.currency ?? null)) {
        return failed(ADS_FLOW_COPY.accountChanged);
      }
      // Another ad account since the Brief: the campaign would be built in
      // an account nobody looked at (docs/meta-ads-plan.md F0b).
      if (brief.adAccountId && account.adAccountId !== brief.adAccountId) {
        return failed(ADS_FLOW_COPY.accountChanged);
      }
      // The ad's picture is the post's asset: it must still be there.
      const picture = await prisma.asset.findFirst({
        where: { id: brief.source.assetId, projectId },
        select: { id: true },
      });
      if (!picture) return failed(ADS_FLOW_COPY.postGone);

      // The claim: only one tap (one tab) plans the campaign, and only for the
      // brief and texts that were read above.
      const claimId = randomUUID();
      const claim = await writeCard(
        projectId,
        found.commandId,
        (card, state) => {
          if (state.launch) return { reject: ADS_FLOW_COPY.launchedAlready };
          if (
            !state.brief ||
            !state.plan ||
            viewStepOf(card.step, state) !== "review" ||
            JSON.stringify(state.brief) !== JSON.stringify(brief) ||
            JSON.stringify(state.plan) !== JSON.stringify(plan)
          ) {
            return { reject: ADS_FLOW_COPY.movedOn };
          }
          return {
            step: "deliver",
            state: {
              ...state,
              launch: { claimId, startedAt: new Date().toISOString() },
            },
          };
        },
      );
      if (!claim.ok) return failed(claim.message);

      let campaignTaskId: string;
      try {
        const planned = await TaskPlanner.planForCapability({
          workspaceId: gate.auth.workspaceId,
          projectId,
          brandId: gate.auth.defaultBrandId,
          commandId: found.commandId,
          capability: "META_CAMPAIGN_CREATE",
          request: `Create Meta campaign: ${plan.campaignName}`,
          createdByType: "USER",
          createdByUserId: gate.auth.userId,
          departmentKey: "PERFORMANCE_MARKETING",
          payloadExtra: adsLaunchPayload(brief, plan),
        });
        campaignTaskId = planned.task.id;
      } catch (error) {
        console.error(
          "[works] ads launch failed:",
          error instanceof Error ? error.message : error,
        );
        // Released: the card goes back to Review and can launch again.
        await writeCard(projectId, found.commandId, (_card, state) =>
          state.launch?.claimId === claimId
            ? { step: "review", state: withoutLaunch(state) }
            : { reject: ADS_FLOW_COPY.movedOn },
        ).catch(() => undefined);
        refresh(projectId);
        return failed();
      }

      // Best effort: without it the chain is still found by its lineage.
      await writeCard(projectId, found.commandId, (_card, state) =>
        state.launch?.claimId === claimId
          ? {
              step: "deliver",
              state: { ...state, launch: { ...state.launch, campaignTaskId } },
            }
          : { reject: ADS_FLOW_COPY.movedOn },
      ).catch(() => undefined);
      refresh(projectId, [`/projects/${projectId}/ads`]);
      return { ok: true };
    },
  );
  return result.ok ? result : failed(result.message);
}

// The chain as it stands: read on the Launch step, again after each approval
// and while Meta is working. Once the ad exists the card remembers it.
export async function loadAdsLaunchAction(
  projectId: string,
  commandId: string,
): Promise<AdsLaunchResult> {
  const result = await guardedAction(
    "ads-launch-read",
    async (): Promise<AdsLaunchResult> => {
      const gate = await authorizeWorks(projectId, READ);
      if (!gate.ok) return failed(gate.message);
      const found = await readAdsCard(projectId, commandId);
      if (!found) return failed();
      const launch = parseAdsFlowState(found.card.data).launch;
      if (!launch) return failed(ADS_FLOW_COPY.movedOn);
      // v2: tek lansman kaydı.
      const chain = launch.launchId
        ? await loadLaunchChain(projectId, launch.launchId)
        : await loadAdsChain(projectId, {
            commandId: found.commandId,
            launch,
          });
      if (!chain) return failed(ADS_FLOW_COPY.movedOn);
      if (chain.complete && !launch.completedAt) {
        const completedAt = new Date().toISOString();
        const write = await writeCard(
          projectId,
          found.commandId,
          (_c, state) =>
            state.launch?.claimId === launch.claimId
              ? {
                  step: "deliver",
                  state: { ...state, launch: { ...state.launch, completedAt } },
                }
              : { reject: ADS_FLOW_COPY.movedOn },
        ).catch(() => null);
        if (write?.ok) refresh(projectId);
      }
      return { ok: true, chain };
    },
  );
  return result.ok ? result : failed(result.message);
}

// "Edit and launch again" once a launch stopped (a step failed or was
// declined): back to Review with the same brief and texts.
export async function relaunchAdsAction(
  projectId: string,
  commandId: string,
): Promise<AdsFlowResult> {
  const result = await guardedAction(
    "ads-relaunch",
    async (): Promise<AdsFlowResult> => {
      const gate = await authorizeWorks(projectId, WRITE);
      if (!gate.ok) return failed(gate.message);
      const found = await readAdsCard(projectId, commandId);
      if (!found) return failed();
      const launch = parseAdsFlowState(found.card.data).launch;
      if (!launch) return { ok: true };
      const chain = launch.launchId
        ? await loadLaunchChain(projectId, launch.launchId)
        : await loadAdsChain(projectId, {
            commandId: found.commandId,
            launch,
          });
      if (!chain) return failed(ADS_FLOW_COPY.movedOn);
      if (!chain.stopped) return failed(ADS_FLOW_COPY.stillGoing);
      // v2: Meta'da yarım kalan nesneler varken yeni lansman açılmaz; önce
      // "Discard" (yetim nesne kalmasın).
      if (chain.v2 && chain.v2.status === "FAILED" && chain.campaignId) {
        return failed(ADS_FLOW_COPY.discardFirst);
      }

      const write = await writeCard(projectId, found.commandId, (_c, state) =>
        state.launch?.claimId === launch.claimId
          ? { step: "review", state: withoutLaunch(state) }
          : { reject: ADS_FLOW_COPY.movedOn },
      );
      if (!write.ok) return failed(write.message);
      refresh(projectId);
      return { ok: true };
    },
  );
  return result.ok ? result : failed(result.message);
}

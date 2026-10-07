import "server-only";

// Side-effect wiring module: registers the late setup-stage runners and the
// intelligence pipeline steps into the orchestrator/engine extension points.
// Imported once by ExecutionWorker so a single import activates the full
// Agency OS loop without creating module cycles.

import { isAgencyFocusMode } from "@/server/agency/agency-focus";
import { CouncilEngine } from "@/server/agency/council/council-engine";
import { AgencyLoopHeartbeat } from "@/server/agency/continuous/agency-loop-heartbeat";
import {
  AgencyDirector,
  registerWorkPlanBuilder,
} from "@/server/agency/director/agency-director";
import { WorkHandoffEngine } from "@/server/agency/handoffs/work-handoff-engine";
import { IdeaFoundry } from "@/server/agency/ideas/idea-foundry";
import { IdeaRefill } from "@/server/ideas/idea-refill";
import { WeeklyPlanDraft } from "@/server/agency/content/weekly-plan-draft";
import { WeeklyPlanProduce } from "@/server/agency/content/weekly-plan-produce";
import { legacyAgencyLoopMode } from "@/server/agency/legacy-loop";
import { IntelligenceEngine } from "@/server/agency/intelligence/intelligence-engine";
import { WebSignalScanner } from "@/server/agency/intelligence/web-signal-scanner";
import { OpportunityEngine } from "@/server/agency/opportunities/opportunity-engine";
import { registerSetupStageRunner } from "@/server/agency/setup/project-setup-orchestrator";
import {
  registerAgencyTickStep,
  registerTaskCompletedHandler,
  registerTaskTerminalHandler,
} from "@/server/agency/continuous/continuous-agency-engine";
import { LearningEngine } from "@/server/agency/learning/learning-engine";
import { MetaTokenHealthCheck } from "@/server/ads/token-health";
import { AdsFlags } from "@/lib/ads/flags";
import { AdsDigest } from "@/server/ads/guard/digest";
import { AdsRetention } from "@/server/ads/guard/retention";
import { AdsGuard } from "@/server/ads/guard/watchdogs";
import { LaunchWatchdog } from "@/server/ads/guard/launch-watchdog";
import { AdsDecisions } from "@/server/ads/decisions";
import { AdsOptimizer } from "@/server/ads/optimizer";
import { refreshAdsGoals } from "@/server/ads/goals";
import { AdsConnections } from "@/server/ads/connections";
import { AdsInsurance } from "@/server/ads/insurance";
import { AdsReports } from "@/server/ads/reports/weekly";
import { claimPeriodic } from "@/server/observability/periodic";
import { AsyncInsights } from "@/server/ads/sync/async-insights";
import { AdsSync } from "@/server/ads/sync/runner";
import { AdsWebhookSubscriptions } from "@/server/ads/webhook-subscriptions";
import { AdsWebhooks } from "@/server/ads/webhooks";
import { MeasurementEngine } from "@/server/agency/measurement/measurement-engine";
import { StrategyEngine } from "@/server/agency/strategy/strategy-service";
import { MetaAdSetChainRelay } from "@/server/agency/meta-ads/meta-adset-chain-relay";
import { MetaCampaignChainRelay } from "@/server/agency/meta-ads/meta-campaign-chain-relay";
import { CreativePublishCompletion } from "@/server/commands/creative-publish-completion";
import { GoogleAnalyticsScanner } from "@/server/agency/performance/google-analytics-scanner";
import { GoogleConnectionHealth } from "@/server/integrations/google-connection-health";
import { GaRetention } from "@/server/website-analytics/retention";
import { GaHealth } from "@/server/website-analytics/health/runner";
import { GaInsights } from "@/server/website-analytics/analysis/runner";
import { GaFindingEvaluator } from "@/server/website-analytics/analysis/evaluator";
import { GaSync } from "@/server/website-analytics/sync/runner";
import { GaReports } from "@/server/website-analytics/reports/runner";
import { GaAttributionLearnings } from "@/server/website-analytics/attribution/learnings";
import { GscRetention } from "@/server/seo/retention";
import { GscSync } from "@/server/seo/sync/runner";
import { SeoCrawler } from "@/server/seo/crawl/crawler";
import { SeoInspection } from "@/server/seo/health/inspection";
import { GscSitemaps } from "@/server/seo/health/gsc-sitemaps";
import { SeoCwvJob } from "@/server/seo/health/cwv";
import { SeoHealth } from "@/server/seo/health/runner";
import { SearchUpdates } from "@/server/seo/health/updates";
import { SeoAuditRetention } from "@/server/seo/health/retention";
import { SeoOpportunities } from "@/server/seo/opportunities/runner";
import { SeoOpportunityRetention } from "@/server/seo/opportunities/retention";
import { SeoActionJobs } from "@/server/seo/actions/jobs";
import { SeoReports } from "@/server/seo/reports/runner";
import { SeoReportRetention } from "@/server/seo/reports/retention";
import { MetaPerformanceScanner } from "@/server/agency/performance/meta-performance-scanner";
import { WorkPlanBuilder } from "@/server/agency/work-plans/work-plan-builder";
import { WorkPlanProgressor } from "@/server/agency/work-plans/work-plan-progressor";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { InsightRepository } from "@/server/repositories/insight.repository";
import { OpportunityRepository } from "@/server/repositories/opportunity.repository";
import { pollTelegramApprovals } from "@/server/integrations/telegram-approval-poller";

// --- Setup stages 9-11 (spec section 5) ------------------------------------

registerSetupStageRunner("INITIAL_OPPORTUNITIES", async (scope) => {
  await IntelligenceEngine.synthesizeInsights(scope);
  const insights = await InsightRepository.listForProject(scope.projectId, {
    status: "NEW",
    limit: 10,
  });
  // Per-item error boundary — one insight's opportunity evaluation failing
  // (a malformed LLM response, a transient provider error) must not abort
  // evaluation for the other insights, nor fail this whole setup stage.
  await Promise.all(
    insights.map((insight) =>
      OpportunityEngine.evaluateInsight(insight.id, scope.projectId).catch(
        (error) => {
          console.error(
            `[agency-wiring] evaluateInsight failed for insight ${insight.id}:`,
            error instanceof Error ? error.message : error,
          );
        },
      ),
    ),
  );
});

registerSetupStageRunner("INITIAL_IDEA_PORTFOLIO", async (scope) => {
  const opportunities = await OpportunityRepository.listForProject(
    scope.projectId,
    { status: "EVALUATED", limit: 3 },
  );
  // Independent per-opportunity generation — each does its own dedup check
  // scoped to its own opportunityId+lens, no shared mutable state — so
  // there's no reason for these to run one after another. Per-item error
  // boundary (same pattern as INITIAL_WORK_PLAN's decideOnIdea below): one
  // opportunity's reasoning call failing must not abort idea generation for
  // the rest of the batch, nor fail this whole setup stage.
  await Promise.all(
    opportunities.map((opportunity) =>
      IdeaFoundry.generateForOpportunity(opportunity.id, scope.projectId, {
        postToChat: false,
      }).catch((error) => {
        console.error(
          `[agency-wiring] generateForOpportunity failed for opportunity ${opportunity.id}:`,
          error instanceof Error ? error.message : error,
        );
      }),
    ),
  );
  // Council pass over the fresh portfolio (bounded parallel batches). Same
  // per-item error boundary — one idea's council evaluation failing (e.g. a
  // malformed LLM response) must not sink the other 4 ideas in its batch.
  const raw = await IdeaRepository.listForProject(scope.projectId, {
    status: "RAW",
    limit: 20,
  });
  const BATCH = 5;
  for (let i = 0; i < raw.length; i += BATCH) {
    await Promise.all(
      raw.slice(i, i + BATCH).map((idea) =>
        CouncilEngine.evaluateIdea(idea.id, scope.projectId, {
          postToChat: false,
        }).catch((error) => {
          console.error(
            `[agency-wiring] evaluateIdea failed for idea ${idea.id} (${idea.title}):`,
            error instanceof Error ? error.message : error,
          );
        }),
      ),
    );
  }
});

registerSetupStageRunner("INITIAL_WORK_PLAN", async (scope) => {
  const shortlisted = await IdeaRepository.listForProject(scope.projectId, {
    status: "SHORTLISTED",
    limit: 10,
  });
  // Per-idea error boundary: one idea that can't be decided (e.g. its
  // opportunity has no linked ProjectGoal — GoalEngine.assertGoalsLinked)
  // must not abort the whole stage. Without this, that single idea sorts
  // first on every retry and the stage fails identically forever, since
  // nothing here ever mutates its status to move it out of the way.
  for (const idea of shortlisted) {
    if (idea.councilEvaluations.length === 0) continue;
    try {
      await AgencyDirector.decideOnIdea(idea.id, scope.projectId);
    } catch (error) {
      console.error(
        `[agency-wiring] decideOnIdea failed for idea ${idea.id} (${idea.title}):`,
        error instanceof Error ? error.message : error,
      );
    }
  }
});

// --- Continuous loop steps (spec section 33, pipeline order) ----------------

// First step of every tick, deliberately: keeps AgencyLoopState's PAUSED
// sync fresh (see agency-loop-heartbeat.ts) before any of the engines below
// run — a later phase's per-engine pause checks will read state this step
// just wrote, not state up to one tick stale.
registerAgencyTickStep({
  name: "agency-loop-heartbeat",
  run: () => AgencyLoopHeartbeat.run(50),
});
// Meta Ads steps run right after the heartbeat, before every LLM step, so a
// long tick never delays them (docs/meta-ads-plan.md §5). Each skips itself
// on a dev process sharing the live database (K19).
registerAgencyTickStep({
  name: "meta-token-health",
  run: () => MetaTokenHealthCheck.runDue(5),
});
// F2 (META_ADS_SYNC): the mirror sync (≤3 accounts a tick, per-account CAS
// lease), the guard (15 min), the 08:30 daily digest and retention. Each
// returns 0 at once while the flag is off.
registerAgencyTickStep({
  name: "meta-ads-sync",
  run: () => AdsSync.runDue(3),
});
registerAgencyTickStep({
  name: "meta-ads-guard",
  run: () => AdsGuard.runPeriodic(),
});
registerAgencyTickStep({
  name: "meta-launch-watchdog",
  run: () => LaunchWatchdog.run(),
});
// F7 (META_ADS_WEBHOOKS): incoming ad webhooks are read 2 minutes after they
// arrive (one targeted read per object, then the guard for that account);
// subscriptions are checked once a day. Polling stays as the fallback.
registerAgencyTickStep({
  name: "meta-ads-webhooks",
  run: () => AdsWebhooks.processDue(50),
});
registerAgencyTickStep({
  name: "meta-ads-webhook-subscriptions",
  run: () => AdsWebhookSubscriptions.runDue(),
});
// F7 (META_ADS_RULES, optional): Meta-side safety rule per running Agentelse
// campaign (created, re-thresholded on budget changes, removed when done).
registerAgencyTickStep({
  name: "meta-ads-rules",
  run: () => AdsInsurance.runDue(),
});
// F8 (META_ADS_AGENCY): workspace connections (daily debug_token, key
// rotation) and async ad-level insight reports (one status check per account
// a tick, per-account daily cap).
registerAgencyTickStep({
  name: "meta-ads-connections",
  run: () => AdsConnections.checkDue(),
});
registerAgencyTickStep({
  name: "meta-ads-async-insights",
  run: () => AsyncInsights.runDue(),
});
// F4 (META_ADS_OPTIMIZER=shadow|on): rules over the mirror once a day per
// account, and the decisions' lifecycle (expiry, read-back, matured
// evaluation) every 30 minutes.
registerAgencyTickStep({
  name: "meta-ads-optimizer",
  run: () => AdsOptimizer.runDue(2),
});
registerAgencyTickStep({
  name: "ads-decision-lifecycle",
  run: async () => {
    if (!(await claimPeriodic("ads.decisions", 30 * 60_000))) return 0;
    const expired = await AdsDecisions.expireDue();
    const verified = await AdsDecisions.verifyDue(10);
    const evaluated = await AdsDecisions.evaluateDue(20);
    // F5b: reklam KPI hedeflerinin güncel değeri (haftada bir, kendi kilidiyle).
    const goals = await refreshAdsGoals();
    return expired + verified + evaluated + goals;
  },
});
// F6 (META_ADS_REPORTS): weekly report (Monday 08:00 project time), monthly
// client report (the 1st, 09:00) and Brand Brain lessons from evaluated
// decisions.
registerAgencyTickStep({
  name: "ads-reports",
  run: () => AdsReports.runDue(5),
});
registerAgencyTickStep({
  name: "ads-daily-digest",
  run: () => AdsDigest.runDue(10),
});
registerAgencyTickStep({
  name: "ads-retention",
  run: () => AdsRetention.runDue(),
});
// Approvals answered in Telegram are applied right after the Meta steps, not
// behind the LLM steps below.
registerAgencyTickStep({
  name: "telegram-approval-polling",
  run: () => pollTelegramApprovals(),
});

// The Brand Brain's weekly look at the outside world (web-signal-scanner.ts):
// one web-searching call per active project a week reports competitors' moves,
// trends, cultural moments and news as sourced signals. It replaces the old
// "signal-scans" step (generic OpenClaw web research per signal category,
// SignalUniverse.runDueScans), which lost its provider with OpenClaw and only
// created tasks that failed at once.
registerAgencyTickStep({
  name: "web-signal-scan",
  run: () => WebSignalScanner.runDueScans(2),
});
// Structured, real-Meta-Insights signal source — deliberately separate
// from the weekly web scan above: this scans
// connected Meta ad accounts directly via the Marketing API on its own
// ~7h cadence and can also short-circuit straight to a Track 2 Approval
// (see performance-optimizer.ts) for high-severity findings, something a
// generic signal source never does. Placed right before signal-processing
// so PERFORMANCE signals produced this tick get scored in the same tick.
registerAgencyTickStep({
  name: "meta-ads-performance-scan",
  // F2: with the mirror on, its findings come from the guard and (F4) the
  // rules engine; the old scanner would read Meta live a second time.
  run: () =>
    AdsFlags.sync()
      ? Promise.resolve(0)
      : MetaPerformanceScanner.runDueScans(5),
});
// Same role as meta-ads-performance-scan above, for GA4/Search Console —
// SEO signals produced this tick get scored in the same tick's
// signal-processing step. See google-analytics-scanner.ts.
registerAgencyTickStep({
  name: "google-analytics-scan",
  run: () => GoogleAnalyticsScanner.runDueScans(5),
});
// Google Analytics ve Search Console bağlantılarının günlük sağlık kontrolü
// (google-connection-health.ts): token, izin ve seçili mülk/site erişimi.
// Odak ayarından bağımsız çalışır; kopuk bağlantı her modda görünmeli.
registerAgencyTickStep({
  name: "google-connection-health",
  run: () => GoogleConnectionHealth.runDue(5),
});
// GA-F2 (GA_SYNC): Google Analytics ambarının senkronu (≤3 bağ bir tick'te,
// bağ başına CAS kilidi, kota yöneticisi) ve günlük saklama temizliği. Bayrak
// kapalıyken ikisi de hemen 0 döner; odak ayarı bunları kapatmaz.
registerAgencyTickStep({
  name: "ga-sync",
  run: () => GaSync.runDue(3),
});
registerAgencyTickStep({
  name: "ga-retention",
  run: () => GaRetention.runDue(),
});
// GA-F3 (GA_HEALTH): ölçüm sağlığı denetimi; parmak izli tam değerlendirme + saatlik yalnız-realtime yolu, en çok 5 bağ bir tick'te, haftalık site taraması (tick başına 1). Bayrak kapalıyken hemen 0 döner; odak ayarı bunu kapatmaz.
registerAgencyTickStep({ name: "ga-health", run: () => GaHealth.runDue(5) });
// GA-F4 (GA_INSIGHTS=shadow|on): analiz motoru. Günlük AN1/AN15, Pazartesi 06:30'dan sonra (mülk saati, pazar verisi gelince) haftalık AN2-AN12; ≤5 bağ bir tick'te, bağ başına CAS kilidi. Ardından kabul edilen bulguların sonucu ve 24 aylık saklama. Bayrak kapalıyken ikisi de sorgusuz 0 döner; odak ayarı kapatmaz.
registerAgencyTickStep({ name: "ga-analyze", run: () => GaInsights.runDue(5) });
registerAgencyTickStep({
  name: "ga-finding-evaluate",
  run: () => GaFindingEvaluator.runDue(20),
});
// GA-F5 (GA_REPORTS=true): Website analytics sohbetine raporlar. Bağ başına CAS kilidi; sırasıyla hedeflerin günlük güncel değeri (ProjectGoal.currentValue + tahmin), kritik ölçüm uyarısı kartı, günlük nabız (yalnız not edilecek bir şey varsa), haftalık rapor (Pazartesi 08:00 proje saati, pazar verisi gelince), aylık rapor ve "Next month plan" (ayın 2'si 08:00). Bayrak kapalıyken sorgusuz 0 döner; odak ayarı kapatmaz.
registerAgencyTickStep({ name: "ga-reports", run: () => GaReports.runDue(5) });
// GA-F6 (GA_UTM + GA_SYNC): etiketli linklerin (reklam, bio) sitedeki sonucu kapıyı geçerse sayısız GA4 Brand Brain öğrenmesi; günde bir (claimPeriodic), projeler güne göre döner; yerel geliştirmede yalnız GA_SYNC_DEV_PROJECTS. Bayrak kapalıyken sorgusuz 0 döner.
registerAgencyTickStep({
  name: "ga-attribution-learnings",
  run: () => GaAttributionLearnings.runDue(),
});
// SC-F2 (GSC_SYNC): Search Console ambarının senkronu (≤3 site bir tick'te,
// site başına CAS kilidi, kota yöneticisi, 90 sn süre) ve günlük saklama
// temizliği (SK3 arşivi). Bayrak kapalıyken senkron hemen 0 döner; saklama
// yalnız ambarda bağ kaldıysa (bayrak sonradan kapatıldı) çalışır. Odak ayarı
// bunları kapatmaz.
registerAgencyTickStep({ name: "gsc-sync", run: () => GscSync.runDue(3) });
registerAgencyTickStep({
  name: "seo-retention",
  run: () => GscRetention.runDue(),
});
// SC-F3 (SEO_HEALTH / SEO_CRAWL): site tarayıcı ve 6 saatlik gerileme bekçisi
// (saniyede ≤1 istek, robots.txt'ye uyum), bütçeli URL Inspection + GSC
// sitemap okuması, haftalık CrUX, arama sağlığı kontrolleri (SH1–SH27, puan,
// uyarılar), Google güncellemeleri takvimi ve saklama. Tarayıcı sağlıktan önce
// koşar ki bekçinin bulduğu noindex aynı tick'te uyarıya dönsün. Bayraklar
// kapalıyken hepsi hemen 0 döner; odak ayarı bunları kapatmaz.
registerAgencyTickStep({ name: "seo-crawl", run: () => SeoCrawler.runDue(3) });
registerAgencyTickStep({
  name: "gsc-inspect",
  run: async () =>
    (await GscSitemaps.syncDue(3)) + (await SeoInspection.runDue(5)),
});
registerAgencyTickStep({ name: "seo-cwv", run: () => SeoCwvJob.runDue(3) });
registerAgencyTickStep({ name: "seo-health", run: () => SeoHealth.runDue(5) });
registerAgencyTickStep({
  name: "search-updates-sync",
  run: () => SearchUpdates.runDue(),
});
registerAgencyTickStep({
  name: "seo-health-retention",
  run: () => SeoAuditRetention.runDue(),
});
// SC-F4 (SEO_INSIGHTS): SEO fırsat motoru; haftalık özetler kesinleşince sınıflama, embedding, CTR eğrisi, konu kümeleri ve SO1–SO16 kuralları; bulgular SeoFinding'e yazılır. Bayrak kapalıyken motor hemen 0 döner; saklama yalnız motor verisi kaldıysa çalışır. Odak ayarı bunları kapatmaz.
registerAgencyTickStep({
  name: "seo-opportunities",
  run: async () =>
    (await SeoOpportunities.runDue(2)) +
    (await SeoOpportunityRetention.runDue()),
});
// SC-F6 (SEO_ACTIONS): öneri → uygulama → ölçüm döngüsü; doğrulama günlük ve 45 sn bütçeli (kendi tarayıcımız + inceleme bütçesi), değerlendirme vadesi gelenlerde, kapıdan geçen sonuçlar öğrenmeye. Bayrak kapalıyken hemen 0 döner (saklama yalnız eylem satırı varsa); odak ayarı bunları kapatmaz.
registerAgencyTickStep({ name: "seo-action-verify", run: () => SeoActionJobs.verify() });
registerAgencyTickStep({ name: "seo-action-evaluate", run: () => SeoActionJobs.evaluate() });
// SC-F5 (SEO_REPORTS): Search & SEO sohbeti; kesinleşen günde nabız (yalnız dikkat çekiciyse), Çarşamba haftalık rapor, ayın 4'ünde aylık rapor + SEO yol haritası, SEO hedeflerinin günlük ölçümü. Bayrak kapalıyken hemen 0 döner; saklama ayrı çalışır ve yalnız rapor verisi kaldıysa iş yapar. Odak ayarı bunları kapatmaz.
registerAgencyTickStep({
  name: "seo-reports",
  run: async () => {
    const posted = await SeoReports.runDue(5).catch((error) => {
      console.error(
        "[seo-reports] run failed:",
        error instanceof Error ? error.name : "error",
      );
      return 0;
    });
    const pruned = await SeoReportRetention.runDue().catch((error) => {
      console.error(
        "[seo-reports] retention failed:",
        error instanceof Error ? error.name : "error",
      );
      return 0;
    });
    return posted + pruned;
  },
});
registerAgencyTickStep({
  name: "signal-processing",
  run: () => IntelligenceEngine.processNewSignals(20),
});
registerAgencyTickStep({
  name: "insight-synthesis",
  run: async () => {
    const projects = await IntelligenceEngine.projectsNeedingInsights(5);
    // One LLM call per project, independent of each other — in parallel.
    await Promise.all(
      projects.map((scope) => IntelligenceEngine.synthesizeInsights(scope)),
    );
    return projects.length;
  },
});
registerAgencyTickStep({
  name: "opportunity-evaluation",
  run: () => OpportunityEngine.evaluatePromotedInsights(10),
});
// The Brand Brain loop's idea step (docs/ideas.md): the idea pool is kept
// full of ready-to-make post ideas. A project someone works in, whose fresh
// post ideas fall below the low-water mark, gets one idea-engine run at most
// every few hours (idea-refill.ts), bounded by the pool size and the daily AI
// limit. The ideas are typed and born VALIDATED, out of reach of the old
// Council and Director, so this runs in every LEGACY_AGENCY_LOOP mode. It
// replaces the old daily "idea-generation" step (campaign ideas across
// creative lenses, which the posts planner could not use as they were).
registerAgencyTickStep({
  name: "idea-pool-refill",
  run: () => IdeaRefill.runDue(2),
});
// Faz 4: every Sunday evening (project time) Agentelse drafts next week's plan
// from the idea pool into a chat of its own (weekly-plan-draft.ts), unless the
// owner switched it off in Settings -> Autonomy. A draft only: saving, making
// and publishing stay the owner's taps. Works only; one lite call per project
// a week; the "nothing due" path is two queries.
registerAgencyTickStep({
  name: "weekly-plan-draft",
  run: () => WeeklyPlanDraft.runDue(2),
});
// Faz 5: once a weekly draft has sat untouched for a couple of hours,
// weekly-plan-produce.ts saves it and starts production on its own — only for
// a project whose owner opted into Settings -> Autonomy "Prepare it
// automatically" (AutonomyPolicy.weeklyAutoProduce, default off). Approving,
// scheduling and publishing stay the owner's taps exactly as they are for a
// plan produced by hand. Runs only once the old loop is wound down
// (LEGACY_AGENCY_LOOP=drain|off): with it `on`, the Council and the Director
// would also be turning the same pool ideas into work of their own.
registerAgencyTickStep({
  name: "weekly-plan-produce",
  run: async () =>
    legacyAgencyLoopMode() === "on" ? 0 : WeeklyPlanProduce.runDue(2),
});
registerAgencyTickStep({
  name: "council-evaluation",
  run: () => CouncilEngine.evaluatePendingIdeas(5),
});
registerAgencyTickStep({
  name: "director-decisions",
  run: () => AgencyDirector.decideShortlisted(5),
});

// --- Wave 4: work orchestration wiring --------------------------------------

// Director's multi-department path builds a full WorkPlan.
registerWorkPlanBuilder((input) => WorkPlanBuilder.buildForIdea(input));

// Completed tasks progress their work plan and close out their handoff.
// Handler names below are what LEGACY_AGENCY_LOOP (legacy-loop.ts) gates on and
// what the audit trail shows when one fails; the unlisted ones are real product
// features and always run.
registerTaskCompletedHandler(async (taskId) => {
  await WorkPlanProgressor.onTaskCompleted(taskId);
}, "work-plan-progression");
registerTaskCompletedHandler(async (taskId) => {
  await WorkHandoffEngine.onTaskCompleted(taskId);
}, "handoff-close-out");
// Symmetric to the COMPLETED path above — a FAILED task's work plan needs
// to know too (cascade-cancel dependents, resolve the plan to FAILED once
// every node is terminal), or the plan and any dependent task strand
// forever (see work-plan-progressor.ts's onTaskTerminal).
registerTaskTerminalHandler(async (taskId, status) => {
  await WorkPlanProgressor.onTaskTerminal(taskId, status);
}, "work-plan-terminal");
// Resumes handoffs accept() had to strand ACCEPTED (daily task-creation cap
// hit) or leave PROPOSED past its expiry — see work-handoff-engine.ts's
// progressPending, which finally gives WorkHandoffRepository.listByStatus
// the caller it never had.
registerAgencyTickStep({
  name: "handoff-progression",
  run: () => WorkHandoffEngine.progressPending(10),
});
// Self-heals a WorkPlan node task that was created READY (deferDispatch) but
// never got dispatched by the one-shot root-dispatch call in
// work-plan-builder.ts or a reactive TASK_COMPLETED/TASK_CANCELLED trigger
// (e.g. isProjectAgencyActive was transiently false at plan-creation time) —
// see work-plan-progressor.ts's sweepOrphanedReadyTasks for the staleness/
// idempotency reasoning. Without this, such a task (and everything depending
// on it) stays orphaned in READY forever.
registerAgencyTickStep({
  name: "work-plan-stale-sweep",
  run: () => WorkPlanProgressor.sweepOrphanedReadyTasks(20),
});
// Combined AdSet+Ad wizard's second-Task fan-out (see meta-adset-chain-relay.ts).
registerTaskCompletedHandler(async (taskId) => {
  await MetaAdSetChainRelay.onTaskCompleted(taskId);
}, "meta-adset-chain");
// Autonomous campaign-proposal path's Campaign->AdSet fan-out (see
// meta-campaign-chain-relay.ts) — one link earlier in the same chain as
// the relay just above, which then continues on to the Ad unchanged.
registerTaskCompletedHandler(async (taskId) => {
  await MetaCampaignChainRelay.onTaskCompleted(taskId);
}, "meta-campaign-chain");
// Flips a Creative to PUBLISHED once its publish Task completes (see
// creative-publish-completion.ts) — applies to every publish path, human
// or autonomous, not just the ones added above.
registerTaskCompletedHandler(async (taskId) => {
  await CreativePublishCompletion.onTaskCompleted(taskId);
}, "creative-publish-completion");

// --- Wave 5: measurement + learning wiring ----------------------------------

// Externally visible completed work gets a measurement plan; completed
// MEASUREMENT_CHECK tasks store their observation on the check.
registerTaskCompletedHandler(async (taskId) => {
  // Focus mode turns the measurement loop off (agency-focus.ts) — don't
  // pile up plans whose checks would all fire at once when it's re-enabled.
  if (isAgencyFocusMode()) return;
  await MeasurementEngine.planForCompletedTask(taskId);
}, "measurement-planning");
registerTaskCompletedHandler(async (taskId) => {
  await MeasurementEngine.onCheckTaskCompleted(taskId);
}, "measurement-check-result");
// Symmetric to the COMPLETED handler above — a MEASUREMENT_CHECK task
// ending FAILED/CANCELLED previously left its MeasurementCheck stuck at
// RUNNING forever (see measurement-engine.ts's onCheckTaskTerminal), which
// in turn meant its MeasurementPlan never reached COMPLETED and
// LearningEngine never saw it.
registerTaskTerminalHandler(async (taskId, status) => {
  await MeasurementEngine.onCheckTaskTerminal(taskId, status);
}, "measurement-check-terminal");

registerAgencyTickStep({
  name: "measurement-checks",
  run: () => MeasurementEngine.runDueChecks(10),
});
registerAgencyTickStep({
  name: "learning",
  run: () => LearningEngine.processCompletedMeasurements(10),
});
// Right after learning: brands with fresh BrandLearning entries this same
// tick (produced by the step above) are picked up immediately, since tick
// steps run sequentially — see continuous-agency-engine.ts.
registerAgencyTickStep({
  name: "strategy-synthesis",
  run: () => StrategyEngine.resynthesizeDue(5),
});

// F4: an optimization decision follows its task (applied, rejected, expired,
// superseded by a CAS miss).
registerTaskCompletedHandler(async (taskId) => {
  await AdsDecisions.onTaskCompleted(taskId);
}, "ads-decision-applied");
registerTaskTerminalHandler(async (taskId, status) => {
  await AdsDecisions.onTaskTerminal(taskId, status);
}, "ads-decision-terminal");

export const AGENCY_WIRING_LOADED = true;

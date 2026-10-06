import {
  PLAN_RUNWAY_DAYS,
  addDaysKey,
  channelLabel,
  MAX_POSTS_PER_RUN,
  postCountOf,
  publishesItself,
  type JourneyItem,
  type JourneySnapshot,
  type NextStep,
} from "@/lib/journey";
import { CHANNELS } from "@/lib/content-channels";
import { WEEKLY_DRAFT_COPY } from "@/lib/weekly-draft";

import { selectProductionBatch } from "./plan-progress";

// What the client should do next, worked out from the records alone (no model,
// no memory): the same answer under either chat engine, and it cannot forget.
// Pure; the loader (snapshot.ts) does the reading. Ordered by how much a
// delay costs: something stuck or due first, then the natural next move.
// The bar shows the first few; an empty list means there is nothing to
// advance (no plan yet), and the bar falls back to its default shortcuts.

const MAX_STEPS = 3;
// One approve step covers at most this many plans and pieces (the server caps
// the same way).
const MAX_APPROVE_PLANS = 12;
const MAX_APPROVE_PIECES = 100;

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

function isManualNow(item: JourneyItem, snapshot: JourneySnapshot): boolean {
  return (
    item.stage === "APPROVED" &&
    item.publish !== "approval" &&
    !publishesItself(item, snapshot.connections)
  );
}

// The weekly plan draft waits in its own chat: open it.
function weeklyDraftStep(draft: { workId: string; count: number }): NextStep {
  return {
    key: "weekly-draft",
    tone: "next",
    label: WEEKLY_DRAFT_COPY.stepLabel,
    title: WEEKLY_DRAFT_COPY.stepTitle(draft.count),
    action: { kind: "open_weekly_draft", workId: draft.workId, count: draft.count },
  };
}

// Published posts waiting for the owner's "Worked / Didn't work".
function verdictStep(awaiting: number): NextStep {
  return {
    key: "results",
    tone: "next",
    label: `See results (${awaiting})`,
    title: `${count(awaiting, "published post is", "published posts are")} waiting for your verdict: did it work?`,
    action: { kind: "show_results", count: awaiting },
  };
}

// Ideas waiting in the pool and no plan to put them in: plan from them.
function planFromIdeasStep(pool: number): NextStep {
  return {
    key: "plan-from-ideas",
    tone: "next",
    label: "Plan from ideas",
    title: `${count(pool, "idea is", "ideas are")} ready in the idea pool.`,
    action: { kind: "plan_from_ideas", count: pool },
  };
}

// GA-F3: web sitesinin ölçüm adımları. Alan adı olan ama Google Analytics
// bağlamamış projeye sessiz bir bağlama önerisi; açık bir ölçüm sorunu varsa
// kritikse engel, değilse sıradaki adım olarak düzeltme.
export function websiteSteps(snapshot: JourneySnapshot): {
  blocker: NextStep[];
  next: NextStep[];
} {
  const website = snapshot.website;
  if (!website) return { blocker: [], next: [] };
  if (website.analytics === "not_connected") {
    return website.hasDomain
      ? {
          blocker: [],
          next: [
            {
              key: "connect-analytics",
              tone: "next",
              label: "Connect Google Analytics",
              title:
                "Connect Google Analytics to see what your posts bring to your website.",
              action: { kind: "connect_analytics" },
              quiet: true,
            },
          ],
        }
      : { blocker: [], next: [] };
  }
  const fix = website.fix;
  if (!fix) return { blocker: [], next: [] };
  const step: NextStep = {
    key: `fix-tracking-${fix.checkKey}`,
    tone: fix.critical ? "blocker" : "next",
    label: "Fix tracking",
    title: fix.title,
    action: { kind: "fix_tracking", checkKey: fix.checkKey, href: fix.href },
  };
  return fix.critical
    ? { blocker: [step], next: [] }
    : { blocker: [], next: [step] };
}

// SC-F3: açık kritik arama sağlığı sorunu; her iki yolda da ilk adım.
function searchIssueStep(
  issue: NonNullable<JourneySnapshot["searchCritical"]>,
): NextStep {
  return {
    key: "fix-search-issue",
    tone: "blocker",
    label: "Fix",
    title:
      issue.count > 1
        ? `${issue.title} (+${issue.count - 1} more search issues)`
        : issue.title,
    action: {
      kind: "fix_search_issue",
      alertId: issue.alertId,
      count: issue.count,
    },
  };
}

// Sohbet modeline giden adım metinleri. GA4/GSC uyarılarından türeyen
// adımların başlığı (Google verisinden bulgular) üçüncü taraf yapay zekâ
// işlemcisine gitmez: yerine sabit bir cümle geçer, düğme ekranda kalır.
const PROMPT_SAFE_TITLES: Partial<Record<NextStep["action"]["kind"], string>> =
  {
    fix_tracking:
      "Fix a website tracking issue (the client sees a Fix tracking button).",
    fix_search_issue:
      "Fix a Google Search issue (the client sees a Fix button).",
  };

export function nextStepTitlesForPrompt(steps: readonly NextStep[]): string[] {
  return steps.map(
    (step) => PROMPT_SAFE_TITLES[step.action.kind] ?? step.title,
  );
}

export function computeNextSteps(snapshot: JourneySnapshot): NextStep[] {
  const { items, today } = snapshot;
  const pool = snapshot.ideaPool ?? 0;
  const draft = snapshot.weeklyDraft;
  const awaiting = snapshot.awaitingVerdict ?? 0;
  const site = websiteSteps(snapshot);
  const search = snapshot.searchCritical
    ? [searchIssueStep(snapshot.searchCritical)]
    : [];
  // A drafted week stands in for "plan from ideas" and "plan the next weeks":
  // the plan is already made, it only waits for the owner. A chat that holds
  // an unsaved draft of its own is not offered a new plan either (it would
  // replace the draft). Published posts waiting for a verdict are asked about
  // in every chat.
  if (items.length === 0) {
    const lead = draft
      ? [weeklyDraftStep(draft)]
      : pool > 0 && !snapshot.openDraftHere
        ? [planFromIdeasStep(pool)]
        : [];
    return [
      ...search,
      ...site.blocker,
      ...lead,
      ...(awaiting > 0 ? [verdictStep(awaiting)] : []),
      ...site.next,
    ];
  }

  const steps: NextStep[] = [...search];
  const at = (stage: JourneyItem["stage"]) =>
    items.filter((item) => item.stage === stage);

  const failed = at("FAILED");
  const inReview = at("IN_REVIEW");
  const approved = at("APPROVED");

  // The plan whose nearest producible week comes first.
  const producibleIds = selectProductionBatch(items);
  const batch = items.filter((item) => producibleIds.includes(item.id));

  if (failed.length > 0 && batch.length > 0) {
    steps.push({
      key: "produce-retry",
      tone: "blocker",
      label: "Try again",
      title: `${count(postCountOf(failed), "post", "posts")} could not be made.`,
      action: {
        kind: "produce_plan",
        planId: batch[0]!.planId,
        count: batch.length,
      },
    });
  }

  // Approved pieces the client posts themselves, whose day has come.
  const dueManual = approved.filter(
    (item) =>
      isManualNow(item, snapshot) && item.date !== "" && item.date <= today,
  );
  if (dueManual.length > 0) {
    steps.push({
      key: "publish-manual",
      tone: "blocker",
      label: `Publish ${postCountOf(dueManual)}`,
      title: `${count(postCountOf(dueManual), "post is", "posts are")} yours to post today.`,
      action: {
        kind: "publish_manual",
        creativeIds: dueManual.map((item) => item.id),
      },
    });
  }
  // GA-F3: kritik ölçüm sorunu, gecikmiş paylaşımdan hemen sonra.
  steps.push(...site.blocker);

  // Work-scoped only: approving what is in review in one go comes before the
  // review step itself. It names the exact pieces it was computed for.
  if (snapshot.workScoped === true && inReview.length >= 2) {
    const planIds = [...new Set(inReview.map((item) => item.planId))].slice(
      0,
      MAX_APPROVE_PLANS,
    );
    const creativeIds = inReview
      .filter((item) => planIds.includes(item.planId))
      .slice(0, MAX_APPROVE_PIECES)
      .map((item) => item.id);
    const posts = postCountOf(
      inReview.filter((item) => creativeIds.includes(item.id)),
    );
    if (creativeIds.length >= 2 && posts >= 2) {
      steps.push({
        key: "approve",
        tone: "next",
        label: `Approve ${posts}`,
        title: `${posts} posts are ready. Approve them in one go.`,
        action: {
          kind: "approve_plan",
          planIds,
          creativeIds,
          count: creativeIds.length,
        },
      });
    }
  }

  if (inReview.length > 0) {
    steps.push({
      key: "review",
      tone: "next",
      label: `Review ${postCountOf(inReview)}`,
      title: `${count(postCountOf(inReview), "post is", "posts are")} ready for your decision.`,
      action: {
        kind: "review_queue",
        creativeId: inReview[0]!.id,
        count: inReview.length,
      },
    });
  }

  if (batch.length > 0 && failed.length === 0) {
    const from = batch[0]!.date;
    const to = batch[batch.length - 1]!.date;
    const span = from && to && from !== to ? ` (${from} – ${to})` : "";
    steps.push({
      key: "produce",
      tone: "next",
      label: `Produce ${Math.min(postCountOf(batch), MAX_POSTS_PER_RUN)}`,
      title: `${count(postCountOf(batch), "planned post has", "planned posts have")} no content yet${span}.`,
      action: {
        kind: "produce_plan",
        planId: batch[0]!.planId,
        count: batch.length,
      },
    });
  }

  // Approved Instagram pieces waiting for their time, with nothing to release
  // them: without a publish schedule they would never go out on their day.
  const selfPublishing = approved.filter(
    (item) =>
      publishesItself(item, snapshot.connections) &&
      item.date !== "" &&
      item.date > today,
  );
  if (selfPublishing.length > 0 && !snapshot.publishScheduleEnabled) {
    steps.push({
      key: "enable-scheduled-publish",
      tone: "next",
      label: "Turn on scheduled posting",
      title: `${count(selfPublishing.length, "approved post", "approved posts")} will go out at the planned time once scheduled posting is on.`,
      action: {
        kind: "enable_scheduled_publish",
        count: selfPublishing.length,
      },
    });
  }

  // A channel in the plan that cannot publish yet. Never blocks producing:
  // the content is made either way, only the automatic posting needs it.
  const live = items.filter((item) => item.stage !== "PUBLISHED");
  const missing = [
    ...new Set(
      live.flatMap((item) =>
        item.channel &&
        CHANNELS[item.channel].group === "social" &&
        snapshot.connections[item.channel]?.connected === false
          ? [item.channel]
          : [],
      ),
    ),
  ];
  if (missing.length > 0) {
    const channel = missing[0]!;
    steps.push({
      key: `connect-${channel}`,
      tone: "next",
      label: `Connect ${channelLabel(channel)}`,
      title: `${channelLabel(channel)} is not connected, so its pieces cannot post themselves.`,
      action: { kind: "connect_channel", channel },
      // A Work with a locked channel needs to see it in the bar.
      ...(snapshot.workScoped === true ? { quiet: false } : { quiet: true }),
    });
  }

  // The plan is running out (or is done): suggest the next stretch before it
  // ends, so there is never a gap in the calendar.
  const dates = items
    .map((item) => item.date)
    .filter(Boolean)
    .sort();
  const lastDate = dates[dates.length - 1];
  if (draft) {
    steps.push(weeklyDraftStep(draft));
  } else if (lastDate && lastDate <= addDaysKey(today, PLAN_RUNWAY_DAYS)) {
    steps.push({
      key: "plan-next",
      tone: "next",
      label: "Plan the next weeks",
      title:
        (lastDate < today
          ? "Your plan has ended."
          : `Your plan runs until ${lastDate}.`) +
        (pool > 0
          ? ` ${count(pool, "idea is", "ideas are")} ready in the pool.`
          : ""),
      action: { kind: "plan_next", afterDate: lastDate },
    });
  }

  // What the measurement loop has to say about pieces that went out. Last on
  // purpose: informative, never the thing standing between the plan and its
  // next piece.
  // Published posts the owner has not judged yet come first: their verdict is
  // what the brand learns from (post-results.ts).
  if (awaiting > 0) {
    steps.push(verdictStep(awaiting));
  } else if (snapshot.results.length > 0) {
    const n = snapshot.results.length;
    steps.push({
      key: "results",
      tone: "next",
      label: `See results (${n})`,
      title: `${count(n, "published piece has", "published pieces have")} results.`,
      action: { kind: "show_results", count: n },
    });
  }
  // GA-F3: kritik olmayan ölçüm düzeltmesi ya da sessiz GA bağlama önerisi.
  steps.push(...site.next);

  // The cap is for what is waiting; quiet steps never take a slot from it.
  return [
    ...steps.filter((step) => !step.quiet).slice(0, MAX_STEPS),
    ...steps.filter((step) => step.quiet),
  ];
}

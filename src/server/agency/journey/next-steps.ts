import {
  PLAN_RUNWAY_DAYS,
  addDaysKey,
  channelLabel,
  publishesItself,
  type JourneyItem,
  type JourneySnapshot,
  type NextStep,
} from "@/lib/journey";
import { CHANNELS } from "@/lib/content-channels";

import { selectProductionBatch } from "./plan-progress";

// What the client should do next, worked out from the records alone (no model,
// no memory): the same answer under either chat engine, and it cannot forget.
// Pure; the loader (snapshot.ts) does the reading. Ordered by how much a
// delay costs: something stuck or due first, then the natural next move.
// The bar shows the first few; an empty list means there is nothing to
// advance (no plan yet), and the bar falls back to its default shortcuts.

const MAX_STEPS = 3;

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

function isManualNow(item: JourneyItem, snapshot: JourneySnapshot): boolean {
  return (
    item.stage === "APPROVED" &&
    item.publish !== "approval" &&
    !publishesItself(item, snapshot.connections)
  );
}

export function computeNextSteps(snapshot: JourneySnapshot): NextStep[] {
  const { items, today } = snapshot;
  if (items.length === 0) return [];

  const steps: NextStep[] = [];
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
      title: `${count(failed.length, "piece", "pieces")} could not be made.`,
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
      label: `Publish ${dueManual.length}`,
      title: `${count(dueManual.length, "piece is", "pieces are")} yours to post today.`,
      action: {
        kind: "publish_manual",
        creativeIds: dueManual.map((item) => item.id),
      },
    });
  }

  if (inReview.length > 0) {
    steps.push({
      key: "review",
      tone: "next",
      label: `Review ${inReview.length}`,
      title: `${count(inReview.length, "piece is", "pieces are")} ready for your decision.`,
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
      label: `Produce ${batch.length}`,
      title: `${count(batch.length, "planned piece has", "planned pieces have")} no content yet${span}.`,
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
    });
  }

  // The plan is running out (or is done): suggest the next stretch before it
  // ends, so there is never a gap in the calendar.
  const dates = items
    .map((item) => item.date)
    .filter(Boolean)
    .sort();
  const lastDate = dates[dates.length - 1];
  if (lastDate && lastDate <= addDaysKey(today, PLAN_RUNWAY_DAYS)) {
    steps.push({
      key: "plan-next",
      tone: "next",
      label: "Plan the next weeks",
      title:
        lastDate < today
          ? "Your plan has ended."
          : `Your plan runs until ${lastDate}.`,
      action: { kind: "plan_next", afterDate: lastDate },
    });
  }

  // What the measurement loop has to say about pieces that went out. Last on
  // purpose: informative, never the thing standing between the plan and its
  // next piece.
  if (snapshot.results.length > 0) {
    const n = snapshot.results.length;
    steps.push({
      key: "results",
      tone: "next",
      label: `See results (${n})`,
      title: `${count(n, "published piece has", "published pieces have")} results.`,
      action: { kind: "show_results", count: n },
    });
  }

  return steps.slice(0, MAX_STEPS);
}

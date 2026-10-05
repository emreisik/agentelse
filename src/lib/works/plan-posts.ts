import { CHANNELS, resolvePlanItem } from "@/lib/content-channels";
import type { PlanItemStage } from "@/lib/journey";
import { postKeyOf } from "@/lib/works/plan-platforms";
import type { CreativeCardData } from "@/types/creative-card";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// A plan's pieces live WITH the plan in the chat (docs/works.md "Plan posts"):
// one carousel under the plan card, one slide per POST (its channels are tabs),
// never one chat message per piece. Pure: the page folds its turns with it
// before they are sent, and the carousel groups and reads its posts with it.

type ReadyCard = Extract<CreativeCardData, { kind: "creative-ready" }>;
type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type PlanItem = PlanCard["items"][number];
export type PlanSlot = NonNullable<NonNullable<PlanCard["slots"]>[number]>;

export type FoldableTurn = { commandId: string; card?: IdeaEventCardData };

function isSavedPlan(card: IdeaEventCardData | undefined): card is PlanCard {
  return card?.kind === "content-plan-draft" && card.state === "saved";
}

// Turns in chat order. `taskPlan`: task id -> the plan Command that started it
// (a loading or failed piece only knows its task). A piece of a plan that is in
// this chat leaves the list and joins that plan card's `posts` (the newest card
// of a piece wins); everything else stays exactly where it was.
export function foldPlanPosts<T extends FoldableTurn>(
  turns: readonly T[],
  taskPlan: ReadonlyMap<string, string>,
): T[] {
  const planOfCreative = new Map<string, string>();
  const plans = new Set<string>();
  for (const turn of turns) {
    if (!isSavedPlan(turn.card)) continue;
    plans.add(turn.commandId);
    for (const id of turn.card.savedCreativeIds ?? []) {
      planOfCreative.set(id, turn.commandId);
    }
  }
  if (plans.size === 0) return [...turns];

  const posts = new Map<string, Map<string, ReadyCard>>();
  const kept: T[] = [];
  for (const turn of turns) {
    const card = turn.card;
    if (card?.kind === "creative-ready") {
      const planId =
        card.planId && plans.has(card.planId)
          ? card.planId
          : planOfCreative.get(card.creativeId);
      if (planId) {
        // An older card of a revised piece is not the piece any more.
        if (card.status !== "ARCHIVED") {
          const byPiece = posts.get(planId) ?? new Map<string, ReadyCard>();
          byPiece.set(card.creativeId, card);
          posts.set(planId, byPiece);
        }
        continue;
      }
    }
    if (
      (card?.kind === "creative-loading" || card?.kind === "creative-failed") &&
      plans.has(taskPlan.get(card.taskId) ?? "")
    ) {
      continue;
    }
    if (
      card?.kind === "publish-prompt" &&
      planOfCreative.has(card.creativeId)
    ) {
      continue;
    }
    kept.push(turn);
  }

  return kept.map((turn) => {
    const own = posts.get(turn.commandId);
    if (!own || !isSavedPlan(turn.card)) return turn;
    return { ...turn, card: { ...turn.card, posts: [...own.values()] } };
  });
}

// ---- a saved plan's posts ----------------------------------------------------

// One channel of a post as the saved plan holds it: its Creative
// (savedCreativeIds[index]), the item it was made from and, once the page has
// overlaid the records, where it stands.
export type PlanDelivery = {
  id: string;
  index: number;
  item: PlanItem;
  slot?: PlanSlot;
};

export type PlanPostGroup<T extends PlanDelivery> = {
  key: string;
  // Absent on a plan saved before posts existed.
  postId?: string;
  deliveries: T[];
};

// The deliveries of a saved plan, in its order. A removed item or a piece that
// is gone (a null slot) is not on screen.
export function planDeliveriesOf(card: PlanCard): PlanDelivery[] {
  if (card.state !== "saved") return [];
  const ids = card.savedCreativeIds ?? [];
  return card.items.flatMap((item, index) => {
    const id = ids[index];
    const slot = card.slots?.[index];
    if (!id || item.removed || slot === null) return [];
    return [{ id, index, item, ...(slot ? { slot } : {}) }];
  });
}

// The posts of a plan in plan order, each with its deliveries in item order.
// The deliveries of one Post share its id; a plan saved before posts existed
// falls back to the day, time and idea (postKeyOf).
export function groupByPost<T extends PlanDelivery>(
  deliveries: readonly T[],
): PlanPostGroup<T>[] {
  const groups = new Map<string, PlanPostGroup<T>>();
  for (const delivery of deliveries) {
    const postId = delivery.slot?.postId;
    const key = postId ?? postKeyOf(delivery.item);
    const group = groups.get(key);
    if (group) {
      group.deliveries.push(delivery);
      continue;
    }
    groups.set(key, {
      key,
      ...(postId ? { postId } : {}),
      deliveries: [delivery],
    });
  }
  return [...groups.values()];
}

// A delivery has content once it is made: waiting for a decision, approved or
// out.
export const CONTENT_STAGES: ReadonlySet<PlanItemStage> = new Set([
  "IN_REVIEW",
  "APPROVED",
  "PUBLISHED",
]);

// Where a delivery stands on screen: being made in this chat first, then its
// finished card (fresher than the plan right after a run), else the plan's own
// stage.
export function deliveryStageOf(delivery: {
  slot?: PlanSlot;
  card?: ReadyCard;
  making?: boolean;
}): PlanItemStage {
  if (delivery.making) return "PRODUCING";
  const card = delivery.card;
  if (card?.status === "PUBLISHED" || card?.publishLine?.kind === "published") {
    return "PUBLISHED";
  }
  switch (card?.status) {
    case "APPROVED":
    case "REJECTED":
    case "IN_REVIEW":
      return card.status;
    case "DRAFT":
      // Made, not decided yet (plan-progress.ts reads a DRAFT with content
      // the same way).
      return "IN_REVIEW";
    default:
      return delivery.slot?.stage ?? "PLANNED";
  }
}

// A post is ready once every channel left in it has content. `stages` are the
// stages of those channels only (a left-out one is not part of the post).
export function isPostReady(stages: readonly PlanItemStage[]): boolean {
  return (
    stages.length > 0 && stages.every((stage) => CONTENT_STAGES.has(stage))
  );
}

// The one main button of a post: make what is missing (again, after a
// failure), wait while it is made, approve once everything is made and
// something waits. Null: nothing to do (decided, out, or declined).
export type PostPrimary =
  | { kind: "make"; retry: boolean }
  | { kind: "making" }
  | { kind: "approve" }
  | null;

export function postPrimaryOf(stages: readonly PlanItemStage[]): PostPrimary {
  if (stages.length === 0) return null;
  if (stages.includes("PRODUCING")) return { kind: "making" };
  if (stages.some((stage) => stage === "PLANNED" || stage === "FAILED")) {
    return { kind: "make", retry: stages.includes("FAILED") };
  }
  return isPostReady(stages) && stages.includes("IN_REVIEW")
    ? { kind: "approve" }
    : null;
}

// The tab of each delivery: its channel ("Facebook"), or its format ("Post",
// "Story") when another tab of the post is on the same channel.
export function deliveryLabelsOf(
  items: readonly {
    channel?: string;
    formatKey?: string;
    platform?: string;
    format?: string;
  }[],
): string[] {
  const resolved = items.map((item) => resolvePlanItem(item));
  return resolved.map((entry, index) => {
    if (!entry) return items[index]?.platform ?? "Post";
    const twin = resolved.some(
      (other, at) => at !== index && other?.channel === entry.channel,
    );
    return twin ? entry.format.label : CHANNELS[entry.channel].label;
  });
}

// How many channels a post goes to: an Instagram post and its Story are one
// channel (the plan pane counts the same way).
export function channelCountOf(
  items: readonly { channel?: string; formatKey?: string; platform?: string }[],
): number {
  const channels = new Set<string>();
  for (const item of items) {
    const channel = resolvePlanItem(item)?.channel ?? item.platform;
    if (channel) channels.add(channel);
  }
  return channels.size;
}

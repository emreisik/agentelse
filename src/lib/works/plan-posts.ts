import {
  CHANNELS,
  resolvePlanItem,
  type ChannelFormat,
  type ChannelKey,
} from "@/lib/content-channels";
import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import type { PlanItemStage } from "@/lib/journey";
import { DATE_SHAPE, TIME_SHAPE, postKeyOf } from "@/lib/works/plan-platforms";
import { slotWhenLabel } from "@/lib/works/slot-rules";
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
// falls back to the day, time and idea (postKeyOf). `postIdOf` reads the post
// of a delivery (its slot's by default).
export function groupByPost<T extends PlanDelivery>(
  deliveries: readonly T[],
  postIdOf: (delivery: T) => string | undefined = (delivery) =>
    delivery.slot?.postId,
): PlanPostGroup<T>[] {
  const groups = new Map<string, PlanPostGroup<T>>();
  for (const delivery of deliveries) {
    const postId = postIdOf(delivery);
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

// A delivery in a sentence ("Instagram Story", "Facebook"): its tab says only
// "Story" beside the post's other Instagram tab.
export function deliveryNameOf(delivery: {
  channel?: ChannelKey;
  label: string;
}): string {
  if (!delivery.channel) return delivery.label;
  const channel = CHANNELS[delivery.channel].label;
  return delivery.label === channel ? channel : `${channel} ${delivery.label}`;
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

// ---- the posts of a plan in the chat ---------------------------------------------

// A piece a run pressed in this chat is making (ChatPackage.pieces, keyed by
// creative id): pending while it is made, done with its finished card.
export type LivePieceLike = {
  state: "pending" | "done" | "error";
  card?: IdeaEventCardData;
};

// One delivery of a post as its slide shows it.
export type SlideDelivery<P extends LivePieceLike = LivePieceLike> =
  PlanDelivery & {
    channel?: ChannelKey;
    format?: ChannelFormat;
    // Its tab: "Post", "Story", "Facebook"...
    label: string;
    // Its finished card: the saved one, else the one just made in this chat.
    card?: ReadyCard;
    // Its live progress while a run of this chat makes it.
    making?: P;
    stage: PlanItemStage;
    // Left out of its post: still a tab, never made or posted.
    excluded: boolean;
  };

export type SlidePost<P extends LivePieceLike = LivePieceLike> = PlanPostGroup<
  SlideDelivery<P>
> & {
  // The stages of the deliveries left in the post, in its order.
  stages: PlanItemStage[];
};

// A saved plan's posts as the chat shows them: one slide per Post, its
// deliveries (the channels) as tabs, each where it stands right now. A piece
// that just finished in this chat shows its card at once; the saved one takes
// over with the next page refresh.
export function slidePostsOf<P extends LivePieceLike>(
  card: PlanCard,
  pieces?: Readonly<Record<string, P>>,
): SlidePost<P>[] {
  const saved = new Map(
    (card.posts ?? []).map((post) => [post.creativeId, post]),
  );
  const cardOf = (id: string): ReadyCard | undefined => {
    const own = saved.get(id);
    if (own) return own;
    const piece = pieces?.[id];
    return piece?.state === "done" && piece.card?.kind === "creative-ready"
      ? piece.card
      : undefined;
  };
  // Without the plan's records (a journey that could not be read) a finished
  // card still knows its post.
  const groups = groupByPost(
    planDeliveriesOf(card),
    (delivery) => delivery.slot?.postId ?? cardOf(delivery.id)?.postId,
  );
  return groups.map((group) => {
    const labels = deliveryLabelsOf(
      group.deliveries.map((delivery) => delivery.item),
    );
    const deliveries = group.deliveries.map(
      (delivery, at): SlideDelivery<P> => {
        const piece = pieces?.[delivery.id];
        const making = piece?.state === "pending" ? piece : undefined;
        const made = cardOf(delivery.id);
        const resolved = resolvePlanItem(delivery.item);
        return {
          ...delivery,
          ...(resolved
            ? { channel: resolved.channel, format: resolved.format }
            : {}),
          label: labels[at] ?? "Post",
          ...(made ? { card: made } : {}),
          ...(making ? { making } : {}),
          stage: deliveryStageOf({
            slot: delivery.slot,
            card: made,
            making: making !== undefined,
          }),
          excluded: delivery.slot?.excluded === true,
        };
      },
    );
    return {
      ...group,
      deliveries,
      stages: deliveries
        .filter((delivery) => !delivery.excluded)
        .map((delivery) => delivery.stage),
    };
  });
}

// "k of n ready": the posts whose every channel left in has content.
export function readyPostCount(
  posts: readonly { stages: readonly PlanItemStage[] }[],
): number {
  return posts.filter((post) => isPostReady(post.stages)).length;
}

// "Thu 8 Oct, 10:00": when the post goes out, from its first channel left in
// (they all go out together), on the plan's own wall clock. "" without one.
export function postWhenOf(
  deliveries: readonly Pick<SlideDelivery, "item" | "slot" | "excluded">[],
): string {
  const lead =
    deliveries.find((delivery) => !delivery.excluded) ?? deliveries[0];
  if (!lead) return "";
  const when = lead.slot?.when;
  const date = when ? when.slice(0, 10) : lead.item.date;
  const time = when ? when.slice(11, 16) : lead.item.time;
  return DATE_SHAPE.test(date) && TIME_SHAPE.test(time)
    ? slotWhenLabel(date, time)
    : "";
}

// A format made as a picture (a post, a Story, a carousel's cover), the same
// rule the plan run makes it by (plan-run.ts productionFor). The others (a
// Reel's script, LinkedIn, X) are written.
export function makesPicture(format: ChannelFormat | undefined): boolean {
  return format?.deliverable === "instagram_post";
}

export type SlidePicture = { assetId?: string; width: number; height: number };

// A delivery's picture on its slide: its image at its own size or, while it is
// still to make, the frame of the picture it will get (its format's shape).
// Null for a written delivery: its words are the post.
export function slidePictureOf(
  delivery: Pick<SlideDelivery, "card" | "slot" | "channel" | "format">,
): SlidePicture | null {
  const card = delivery.card;
  const assetId = card?.assetId ?? delivery.slot?.assetId;
  const isImage =
    Boolean(assetId) && (card?.mimeType?.startsWith("image/") ?? true);
  if (!isImage && (card !== undefined || !makesPicture(delivery.format))) {
    return null;
  }
  const platform =
    card?.platform ??
    (delivery.channel ? CHANNELS[delivery.channel].platform : undefined);
  const size = getCreativePlatformFormat(
    platform,
    card?.contentFormat ?? delivery.format?.contentFormat,
  ).pixelSize;
  return {
    ...(isImage && assetId ? { assetId } : {}),
    width: card?.assetWidth ?? size.width,
    height: card?.assetHeight ?? size.height,
  };
}

// A delivery's quiet "Leave out" / "Include". Only a delivery of a real Post
// can be left out (a plan saved before posts has none). It is offered but
// blocked while the delivery is being made or once it is posted, and for the
// last channel left in (a post keeps at least one); the server checks again.
export type LeaveOut = {
  kind: "leave" | "include";
  blocked?: "posted" | "making" | "last";
};

export function leaveOutOf(
  delivery: { stage: PlanItemStage; excluded: boolean },
  post: { postId?: string; stages: readonly PlanItemStage[] },
): LeaveOut | null {
  if (!post.postId) return null;
  const kind = delivery.excluded ? "include" : "leave";
  if (delivery.stage === "PUBLISHED") return { kind, blocked: "posted" };
  if (delivery.stage === "PRODUCING") return { kind, blocked: "making" };
  if (kind === "leave" && post.stages.length <= 1) {
    return { kind, blocked: "last" };
  }
  return { kind };
}

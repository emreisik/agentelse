"use client";

import { ArrowRight, Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { useChatPackage } from "@/components/commands/chat-package-context";
import { useChatSend } from "@/components/commands/chat-send-context";
import { WsStatusPill } from "@/components/commands/ws-event-card";
import { Button } from "@/components/ui/button";
import {
  BrandCheck,
  parseReply,
  replyFailure,
} from "@/components/works/plan-card-extras";
import {
  disabledReasonOf,
  useWorkCardHost,
  type WorkCardHostValue,
} from "@/components/works/work-card-host";
import {
  CHANNELS,
  PLAN_GOAL_LABEL,
  isPlanGoal,
  resolveFormat,
  resolvePlanItem,
  type ChannelKey,
} from "@/lib/content-channels";
import { buildWeeks } from "@/lib/content-plan-view";
import { copyText } from "@/lib/works/copy";
import { produceCostNote } from "@/lib/works/cost";
import {
  MAX_ALTERNATIVE_RUNS,
  MAX_ALTERNATIVES_STORED,
  swapItem,
} from "@/lib/works/plan-alternatives";
import {
  canApprovePost,
  canMovePost,
  canOpenStep,
  canPlanPublishing,
  isLiveDelivery,
  isPostMade,
  liveStagesOf,
  movePieces,
  nextRunOf,
  nextSuggestion,
  pieceOf,
  piecesToMove,
  progressOf,
  rangeLabel,
  stepOf,
  stepStates,
  todayIn,
  type PaneStep,
  type PieceView,
  type RunPiece,
} from "@/lib/works/plan-pane";
import { worksPublishMode } from "@/lib/works/plan-publish-truth";
import {
  activePlatformsOf,
  deliveriesOfPlan,
  formatFor,
  groupPosts,
  nextSkipFormats,
  orderedPlatforms,
  piecesOfPlan,
  postKeyOf,
  withSkipFormats,
} from "@/lib/works/plan-platforms";
import { integrationsHref } from "@/lib/works/starter-cards";
import { saveContentPlanAction } from "@/server/actions/content-plan-actions";
import {
  movePlanPostAction,
  removePlanPostAction,
  setPlanInstagramStoryAction,
  setPlanPlatformsAction,
  setPlanPostSkipAction,
  type PlanDraftResult,
} from "@/server/actions/plan-draft-actions";
import { swapPlanItemAction } from "@/server/actions/plan-options-actions";
import {
  approvePostAction,
  setDeliveryExcludedAction,
} from "@/server/actions/post-actions";
import { moveSlotAction } from "@/server/actions/schedule-slots-actions";
import { enablePlanPublishingAction } from "@/server/actions/plan-progress-actions";
import { approvePlansAction } from "@/server/actions/work-approve-actions";
import type { IdeaEventCardData } from "@/types/idea-event-card";

import { PLAN_PANE_COPY as COPY } from "./copy";
import {
  AccountsPanel,
  ChannelChips,
  PaneHeader,
  PlanStepper,
  ViewToggle,
  WeekStrip,
  type PaneView,
} from "./pane-parts";
import { PostCard, type CardTab, stateOfTabs } from "./post-card";
import {
  PublishCalendar,
  PublishReview,
  type ReviewPost,
} from "./publish-review";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type PlanItem = PlanCard["items"][number];

// A change made on a draft's posts, shown at once while its action runs.
type DraftEdit =
  | { type: "move"; indices: readonly number[]; date: string; time: string }
  | { type: "remove"; indices: readonly number[] }
  | { type: "swap"; index: number; altIndex: number }
  | {
      type: "skip";
      indices: readonly number[];
      skipFormats: readonly string[];
    };

function applyDraftEdit(current: PlanItem[], edit: DraftEdit): PlanItem[] {
  if (edit.type === "remove") {
    return current.filter((_, at) => !edit.indices.includes(at));
  }
  if (edit.type === "skip") {
    return current.map((item, at) =>
      edit.indices.includes(at)
        ? withSkipFormats(item, edit.skipFormats)
        : item,
    );
  }
  if (edit.type === "swap") {
    return current.map((item, at) =>
      at === edit.index ? (swapItem(item, edit.altIndex) ?? item) : item,
    );
  }
  return current
    .map((item, at) => ({
      item: edit.indices.includes(at)
        ? { ...item, date: edit.date, time: edit.time }
        : item,
      at,
    }))
    .sort(
      (a, b) =>
        `${a.item.date}T${a.item.time}`.localeCompare(
          `${b.item.date}T${b.item.time}`,
        ) || a.at - b.at,
    )
    .map((entry) => entry.item);
}

// The idea of a post that is being looked at: which post (and what it says now,
// to be sure it is the same one) and which of its other ideas.
type IdeaPointer = { index: number; topic: string; alt: number };

// The save action answers a stale plan with code STALE.
function isStale(result: object): boolean {
  return "code" in result && result.code === "STALE";
}

const GENERATE_WAIT_MS = 12_000;

export function ContentPlanPane({
  card,
  commandId,
}: {
  card: PlanCard;
  commandId?: string;
}) {
  const host = useWorkCardHost();
  if (!host) return null;
  return <PaneBody card={card} commandId={commandId} host={host} />;
}

function PaneBody({
  card,
  commandId,
  host,
}: {
  card: PlanCard;
  commandId?: string;
  host: WorkCardHostValue;
}) {
  const router = useRouter();
  const chatPackage = useChatPackage();
  const sendChat = useChatSend();
  const [pending, startTransition] = useTransition();
  const [, startEdit] = useTransition();

  const projectId = host.projectId;
  const workId = host.workId;
  const draft = card.state === "draft";
  const superseded = card.state === "superseded";
  const timezone = card.timezone || host.timezone || "";
  const today = todayIn(timezone || "UTC");
  const connected = host.connectedChannels ?? [];

  // A draft's changes show at once; the action's own revalidation brings the
  // stored plan after them.
  const [draftItems, applyDraft] = useOptimistic(card.items, applyDraftEdit);
  // The channels the person ticked (null: not chosen yet, every post goes where
  // the plan drew it). Only a choice makes one piece per post and channel.
  const [choice, applyChoice] = useOptimistic(
    card.platforms && card.platforms.length > 0
      ? orderedPlatforms(card.platforms)
      : null,
    (_current, next: ChannelKey[]) => next,
  );
  const platforms = choice ?? activePlatformsOf(card);
  // "Also as a Story" on Instagram (one switch for the whole plan).
  const [story, applyStory] = useOptimistic(
    Boolean(card.instagramStory),
    (_current, next: boolean) => next,
  );
  // What saving would make right now (one piece per post and platform, plus
  // the Stories, less the channels each post leaves out).
  const draftPieces = useMemo(
    () =>
      piecesOfPlan({
        items: draftItems,
        platforms: choice ?? undefined,
        instagramStory: story,
      }),
    [draftItems, choice, story],
  );
  // A made post's channel left out or taken back in, shown at once while its
  // action runs (creative id -> left out).
  const [leftNow, markLeftOut] = useOptimistic(
    {} as Readonly<Record<string, boolean>>,
    (current, change: { id: string; out: boolean }) => ({
      ...current,
      [change.id]: change.out,
    }),
  );
  const leftOutAt = (index: number): boolean => {
    const slot = card.slots?.[index];
    if (!slot) return false;
    return leftNow[slot.id] ?? slot.excluded === true;
  };

  const sourceItems = draftItems;
  // A saved plan's posts are its Posts (one card each, whatever day a channel
  // says); a draft's, and an older plan's, are the items that share a day, a
  // time and an idea.
  const posts = useMemo(
    () =>
      groupPosts(
        sourceItems,
        draft ? undefined : (index) => card.slots?.[index]?.postId,
      ),
    [sourceItems, draft, card.slots],
  );

  // ---- steps -----------------------------------------------------------------
  const progress = progressOf(card);
  const derived = stepOf(progress);
  const [picked, setPicked] = useState<PaneStep | null>(null);
  const shown: PaneStep =
    picked && canOpenStep(picked, progress) ? picked : derived;
  const states = stepStates(shown, progress);
  const openable = {
    plan: canOpenStep("plan", progress),
    content: canOpenStep("content", progress),
    publish: canOpenStep("publish", progress),
  };

  // ---- list or week ----------------------------------------------------------
  const [view, setView] = useState<PaneView>("list");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [weekIndex, setWeekIndex] = useState(0);
  const [dayPick, setDayPick] = useState<string | null>(null);
  const weeks = useMemo(
    () => buildWeeks(posts.map((post) => ({ date: post.date }))),
    [posts],
  );
  const week = weeks[Math.min(weekIndex, Math.max(0, weeks.length - 1))];
  const dayCounts: Record<string, number> = {};
  for (const day of week?.days ?? []) {
    dayCounts[day] = posts.filter((post) => post.date === day).length;
  }
  const selectedDay =
    dayPick && (dayCounts[dayPick] ?? 0) > 0
      ? dayPick
      : (week?.days.find((day) => (dayCounts[day] ?? 0) > 0) ?? null);
  const shownPosts =
    view === "week" ? posts.filter((post) => post.date === selectedDay) : posts;
  const openNow =
    openKey !== null && (openKey === "" || posts.some((p) => p.key === openKey))
      ? openKey
      : (posts[0]?.key ?? "");

  const [accountsOpen, setAccountsOpen] = useState(false);
  const [stale, setStale] = useState(false);
  const [approved, setApproved] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);

  // ---- what each post is made of ----------------------------------------------
  // One tab per channel of the post: a channel can have two (an Instagram post
  // and its Story). A draft shows what saving would make, the channels the post
  // leaves out among them; a made plan shows its pieces.
  const tabsOf = (post: (typeof posts)[number]): CardTab[] => {
    const seen = new Set<string>();
    const tabs: CardTab[] = [];
    if (draft) {
      const deliveries = deliveriesOfPlan({
        items: post.items,
        platforms: choice ?? undefined,
        instagramStory: story,
      });
      for (const delivery of deliveries) {
        const resolved = resolvePlanItem(delivery.item);
        if (!resolved) continue;
        const key = `${resolved.channel}:${resolved.format.key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tabs.push({
          channel: resolved.channel,
          formatKey: resolved.format.key,
          ...(delivery.skipped ? { leftOut: true } : {}),
        });
      }
      // Items outside the catalog: the platforms the plan goes to.
      return tabs.length > 0
        ? tabs
        : platforms.map((channel) => ({
            channel,
            formatKey: formatFor(channel, post.items[0]?.formatKey),
          }));
    }
    for (const index of post.indices) {
      const item = card.items[index];
      const channel = item ? resolvePlanItem(item)?.channel : undefined;
      const key = `${channel}:${item?.formatKey ?? ""}`;
      if (!item || !channel || seen.has(key)) continue;
      seen.add(key);
      tabs.push({
        channel,
        formatKey: item.formatKey,
        piece: pieceOf(card, item, index, channel),
        ...(leftOutAt(index) ? { leftOut: true } : {}),
      });
    }
    return tabs;
  };
  // Each post's tabs, once per render.
  const tabsByPost = new Map(posts.map((post) => [post.key, tabsOf(post)]));
  const tabsFor = (post: (typeof posts)[number]): CardTab[] =>
    tabsByPost.get(post.key) ?? [];
  // The channels the posts go to, as their cards count them (a left-out one,
  // or one gone since, is not counted).
  const pieceCount = posts.reduce(
    (sum, post) => sum + tabsFor(post).filter(isLiveDelivery).length,
    0,
  );
  // The post's id once saved (every piece of a post carries the same one).
  const postIdOf = (post: (typeof posts)[number]): string | undefined =>
    post.postId ??
    post.indices.map((index) => card.slots?.[index]?.postId).find(Boolean);

  // ---- the plan's actions ------------------------------------------------------
  const reason = disabledReasonOf(host, { kind: "server", planId: commandId });
  const blocked = reason !== null || !commandId;
  const editable = draft && !blocked;

  const edit = (
    optimistic: () => void,
    call: (id: string) => Promise<PlanDraftResult>,
  ) => {
    if (!commandId) return;
    startEdit(async () => {
      optimistic();
      const result = await call(commandId);
      if (!result.ok) {
        toast.error(result.message);
        if (result.code === "STALE") router.refresh();
      }
    });
  };

  // A made plan's post to a new day and time. A Post moves as one: moving one
  // of its pieces moves the others (post-move.ts). An older plan's post moves
  // piece by piece, one after the other, and its open card follows it to its
  // new place (it is named by its day).
  const moveMade = (
    post: (typeof posts)[number],
    pieces: readonly (PieceView | undefined)[],
    date: string,
    time: string,
  ) => {
    const to = { date, time };
    const moving = postIdOf(post)
      ? piecesToMove(pieces, to).slice(0, 1)
      : pieces;
    startEdit(async () => {
      const result = await movePieces(moving, to, (id, at) =>
        moveSlotAction(projectId, workId, id, at).catch(() => ({
          ok: false,
        })),
      );
      if (result.moved > 0 && !post.postId) {
        setOpenKey(postKeyOf({ date, time, topic: post.topic }));
      }
      if (result.ok) {
        if (result.moved > 0) host.announce(COPY.moved);
        return;
      }
      toast.error(result.message ?? COPY.moveFailed);
      router.refresh();
    });
  };

  const togglePlatform = (key: ChannelKey) => {
    const next = platforms.includes(key)
      ? platforms.filter((platform) => platform !== key)
      : orderedPlatforms([...platforms, key]);
    if (next.length === 0) {
      toast.info(COPY.keepOne);
      return;
    }
    edit(
      () => applyChoice(next),
      (id) => setPlanPlatformsAction(id, next),
    );
  };

  const toggleStory = () => {
    const next = !story;
    edit(
      () => applyStory(next),
      (id) => setPlanInstagramStoryAction(id, next),
    );
  };

  // One channel of one post left out, or taken back in (docs/works.md
  // "Posts"). A draft skips its format, so saving never makes it; a made plan
  // excludes its piece, which is then never made, approved or posted. A post
  // keeps at least one channel.
  const toggleLeftOut = (post: (typeof posts)[number], tab: CardTab) => {
    const out = !tab.leftOut;
    if (draft) {
      if (!tab.formatKey) return;
      const formatKey = tab.formatKey;
      const next = nextSkipFormats(
        post.items,
        { platforms: choice ?? undefined, instagramStory: story },
        formatKey,
        out,
      );
      if (!next.ok) {
        if (next.reason === "LAST") toast.info(COPY.keepOneChannel);
        else toast.error(COPY.failedGeneric);
        return;
      }
      edit(
        () =>
          applyDraft({
            type: "skip",
            indices: post.indices,
            skipFormats: next.skipFormats,
          }),
        (id) =>
          setPlanPostSkipAction(id, post.indices, post.topic, formatKey, out),
      );
      return;
    }
    const creativeId = tab.piece?.creativeId;
    if (!creativeId) return;
    startEdit(async () => {
      markLeftOut({ id: creativeId, out });
      const result = await setDeliveryExcludedAction(creativeId, out).catch(
        () => null,
      );
      if (result?.ok) {
        host.announce(out ? COPY.leftOutDone : COPY.includedDone);
      } else {
        toast.error(result?.message ?? COPY.failedGeneric);
      }
      router.refresh();
    });
  };

  // One Approve for a made post: every channel left in it that waits is
  // approved together (post-actions.ts).
  const [approvingPost, setApprovingPost] = useState<string | null>(null);
  const approvePost = async (postId: string) => {
    if (approvingPost) return;
    setApprovingPost(postId);
    try {
      const result = await approvePostAction(postId);
      if (result.ok) {
        toast.success(COPY.postApproved);
        host.announce(COPY.postApproved);
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error(COPY.failedGeneric);
    } finally {
      setApprovingPost(null);
      router.refresh();
    }
  };

  // A new idea for a post: its other ideas one after the other, each shown as a
  // suggestion the person approves ("Use this idea") before the post changes.
  // A post with none gets some first (one paid round for the whole plan).
  const [suggesting, setSuggesting] = useState<IdeaPointer | null>(null);
  // Ideas that were asked for: shown as soon as the refreshed plan has them.
  const [waiting, setWaiting] = useState<
    (IdeaPointer & { base: number }) | null
  >(null);
  const [generating, setGenerating] = useState<number | null>(null);
  const swapping = useRef(false);

  const arrived =
    waiting &&
    draftItems[waiting.index]?.topic === waiting.topic &&
    (draftItems[waiting.index]?.alternatives?.length ?? 0) > waiting.base
      ? waiting
      : null;
  const shownIdea: IdeaPointer | null = arrived ?? suggesting;

  // Ideas that never arrive (nothing new fitted this post): stop waiting.
  useEffect(() => {
    if (!waiting || arrived) return undefined;
    const timer = window.setTimeout(() => {
      setWaiting(null);
      toast.info(COPY.noMoreIdeas);
    }, GENERATE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, arrived]);

  // The idea shown for a post, if the post is still the one it was shown for.
  const suggestionFor = (index: number) => {
    const item = draftItems[index];
    if (
      !shownIdea ||
      shownIdea.index !== index ||
      !item ||
      item.topic !== shownIdea.topic
    ) {
      return null;
    }
    const alt = item.alternatives?.[shownIdea.alt];
    return alt ? { item, alt, at: shownIdea.alt } : null;
  };

  const swapIdea = (index: number, altIndex: number, topic: string) => {
    if (!commandId || swapping.current) return;
    swapping.current = true;
    startEdit(async () => {
      applyDraft({ type: "swap", index, altIndex });
      try {
        const result = await swapPlanItemAction(
          commandId,
          index,
          altIndex,
          topic,
        );
        if (result.ok) {
          host.announce(COPY.swapped);
          toast.success(COPY.swapped);
        } else {
          toast.error(result.message);
          if (result.code === "STALE") router.refresh();
        }
      } catch {
        toast.error(COPY.failedGeneric);
      } finally {
        swapping.current = false;
      }
    });
  };

  const askForIdeas = async (
    index: number,
    topic: string,
    base: number,
    alt: number,
  ) => {
    if (!commandId) return;
    setGenerating(index);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/chat/plan/alternatives`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          // The post asked for: the idea pool's post ideas go to it first.
          body: JSON.stringify({ commandId, index }),
        },
      );
      const reply = parseReply(await response.json().catch(() => null));
      if (response.ok && reply?.ok) {
        setWaiting({ index, topic, alt, base });
        router.refresh();
      } else {
        toast.error(replyFailure(reply).message);
      }
    } catch {
      toast.error(copyText("planAlt.failed"));
    } finally {
      setGenerating(null);
    }
  };

  const newIdeaFor = (index: number, postKey: string) => {
    const item = draftItems[index];
    if (!item || generating !== null) return;
    setOpenKey(postKey);
    const pool = item.alternatives?.length ?? 0;
    const step = nextSuggestion({
      pool,
      current: suggestionFor(index)?.at ?? null,
      canGenerate:
        pool < MAX_ALTERNATIVES_STORED &&
        (card.alternativesMeta?.runs ?? 0) < MAX_ALTERNATIVE_RUNS,
    });
    if (!step) {
      toast.info(COPY.noMoreIdeas);
      return;
    }
    if (step.kind === "show") {
      setWaiting(null);
      setSuggesting({ index, topic: item.topic, alt: step.alt });
      return;
    }
    void askForIdeas(index, item.topic, pool, step.showAlt);
  };

  // "Use this idea": the post changes now, and the suggestion is done.
  const approveIdea = (index: number) => {
    const shown = suggestionFor(index);
    if (!shown) return;
    setSuggesting(null);
    setWaiting(null);
    // The post is named by its idea: the open card follows it.
    setOpenKey(postKeyOf({ ...shown.item, topic: shown.alt.topic }));
    swapIdea(index, shown.at, shown.item.topic);
  };

  const keepIdea = () => {
    setSuggesting(null);
    setWaiting(null);
  };

  // ---- making, approving, scheduling --------------------------------------------
  const producing =
    host.producing.has(commandId ?? "") ||
    chatPackage?.runs[commandId ?? ""]?.phase === "running";
  // The pieces a tap can make: a draft's are all still to make; a made plan's
  // are the pieces left in their posts.
  const runPieces: (RunPiece & { formatKey?: string; channel?: ChannelKey })[] =
    draft
      ? draftPieces.flatMap((item, index) => {
          if (item.removed) return [];
          const resolved = resolvePlanItem(item);
          return [
            {
              id: String(index),
              post: postKeyOf(item),
              stage: "PLANNED" as const,
              date: item.date,
              formatKey: resolved?.format.key ?? item.formatKey,
              channel: resolved?.channel,
            },
          ];
        })
      : posts.flatMap((post) =>
          tabsFor(post).flatMap((tab) => {
            const piece = tab.piece;
            if (tab.leftOut || !piece?.creativeId || !piece.stage) return [];
            return [
              {
                id: piece.creativeId,
                post: post.key,
                stage: piece.stage,
                date: piece.when?.slice(0, 10) || post.date,
                formatKey: tab.formatKey,
                channel: tab.channel,
              },
            ];
          }),
        );
  // What one tap makes now: whole posts, at most three (the plan run picks them
  // the same way), and what their pictures cost.
  const nextRun = nextRunOf(runPieces);
  const producibleNow = nextRun.posts;
  const runIds = new Set(nextRun.ids);
  const costNote = produceCostNote(
    runPieces.filter((piece) => runIds.has(piece.id)),
  );
  const costLine = costNote
    ? copyText("plan.costNote", { cost: costNote.replace(/^about /, "") })
    : null;

  const save = (produce: boolean) => {
    if (!commandId) return;
    startTransition(async () => {
      const result = await saveContentPlanAction(commandId);
      if (!result.ok) {
        toast.error(result.message);
        if (isStale(result)) setStale(true);
        router.refresh();
        return;
      }
      toast.success(copyText("plan.savedToast", { n: posts.length }));
      router.refresh();
      // The run streams for a while: start it without holding this transition
      // (the chat shows each piece live).
      if (produce && chatPackage) void chatPackage.startPlan({ commandId });
    });
  };

  const makeMore = () => {
    if (!commandId || !chatPackage) return;
    void chatPackage.startPlan({ commandId });
  };

  const approveAll = () => {
    if (!commandId) return;
    // Only the pieces this pane actually shows right now (approvePlansAction
    // itself then also drops any with unchosen picture alternatives): a
    // piece that finished producing after this last loaded is neither
    // approved nor silently skipped — the whole call is refused instead, so
    // a refresh brings it into view before anything is decided.
    const shown = (card.savedCreativeIds ?? []).filter(
      (id, index) => id && !card.items[index]?.removed && !leftOutAt(index),
    );
    startTransition(async () => {
      const result = await approvePlansAction(projectId, {
        planIds: [commandId],
        creativeIds: shown,
      });
      if (result.ok) {
        toast.success(COPY.approvedToast(result.approved, result.failed));
        setApproved(false);
        setPicked(null);
      } else {
        toast.error(result.message);
      }
      router.refresh();
    });
  };

  const turnOnSchedule = async () => {
    setScheduleBusy(true);
    try {
      const result = await enablePlanPublishingAction(projectId);
      if (result.ok) {
        toast.success(COPY.scheduledOn);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error(COPY.failedGeneric);
    } finally {
      setScheduleBusy(false);
    }
  };

  const planAgain = () => {
    if (!sendChat) return;
    void sendChat(
      COPY.planAgainMessage(
        platforms.map((key) => CHANNELS[key].label).join(", "),
      ),
    );
  };

  // ---- derived views of the last step ---------------------------------------------
  // One row per post, one line per channel left in it.
  const reviewPosts: ReviewPost[] = posts.map((post) => ({
    key: post.key,
    date: post.date,
    topic: post.topic,
    pieces: tabsFor(post)
      .filter(isLiveDelivery)
      .map((tab) => ({
        channel: tab.channel,
        formatKey: tab.formatKey,
        stage: tab.piece?.stage,
        when: tab.piece?.when ?? `${post.date}T${post.time}`,
        mode: worksPublishMode({
          channel: tab.channel,
          formatKey: tab.formatKey,
          publish:
            (tab.formatKey
              ? resolveFormat(tab.channel, tab.formatKey)?.publish
              : undefined) ?? "manual",
        }),
        connected: connected.includes(tab.channel),
      })),
  }));
  // The person counts posts: one made once every channel left in it is, one to
  // approve while something of it waits.
  const postsMade = posts.filter((post) =>
    isPostMade(liveStagesOf(tabsFor(post))),
  ).length;
  const postsToApprove = posts.filter((post) =>
    liveStagesOf(tabsFor(post)).includes("IN_REVIEW"),
  ).length;
  const heldChannels = platforms.filter((key) => !connected.includes(key));
  const instagramNeedsSchedule =
    card.scheduleEnabled === false &&
    reviewPosts.some((post) =>
      post.pieces.some(
        (piece) =>
          piece.channel === "instagram" &&
          piece.connected &&
          (piece.stage === "APPROVED" || piece.stage === "PUBLISHED"),
      ),
    );

  const goal =
    card.goal && isPlanGoal(card.goal) ? PLAN_GOAL_LABEL[card.goal].label : "";
  const meta = [
    host.projectName,
    rangeLabel(posts.map((post) => post.date)),
    goal,
  ]
    .filter(Boolean)
    .join(" · ");
  const connectHrefOf = (key?: ChannelKey) =>
    integrationsHref(projectId, key, { fromWorkId: workId });
  const calendarHref = `/projects/${projectId}/takvim`;

  // ---- the footer of each step --------------------------------------------------
  // Posts one tap cannot make at once (the rest is made after them).
  const overBatch = Math.max(0, posts.length - nextRun.posts);
  let footer: ReactNode = null;
  if (!superseded && shown === "plan") {
    footer = draft ? (
      <PaneFooter
        summary={COPY.planSummary(posts.length, pieceCount)}
        helper={
          overBatch
            ? `${COPY.planHelper} ${COPY.planHelperBatch(nextRun.posts)}`
            : COPY.planHelper
        }
        note={
          reason ?? [COPY.prepareNote, costLine].filter(Boolean).join(" · ")
        }
      >
        <Button
          type="button"
          variant="outline"
          className="min-h-11 rounded-lg px-4"
          onClick={() => save(false)}
          disabled={pending || blocked}
          title={reason ?? undefined}
        >
          {COPY.addToCalendar}
        </Button>
        <Button
          type="button"
          className="min-h-11 rounded-lg px-4"
          onClick={() => save(true)}
          disabled={pending || blocked || !chatPackage}
          title={reason ?? undefined}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          {COPY.prepare}
        </Button>
      </PaneFooter>
    ) : (
      <PaneFooter
        summary={COPY.planSummary(posts.length, pieceCount)}
        helper={COPY.reviewHelper}
      >
        <Button
          type="button"
          className="min-h-11 rounded-lg px-4"
          onClick={() => setPicked("content")}
        >
          {COPY.continue}
          <ArrowRight className="size-4" />
        </Button>
      </PaneFooter>
    );
  } else if (!superseded && shown === "content") {
    footer = (
      <PaneFooter
        summary={COPY.readyOf(postsMade, posts.length)}
        helper={COPY.reviewHelper}
        note={
          reason ??
          (producibleNow > 0 && !producing
            ? (costLine ?? undefined)
            : undefined)
        }
      >
        {producing || progress.making > 0 ? (
          <Button type="button" className="min-h-11 rounded-lg px-4" disabled>
            <Loader2 className="size-4 animate-spin" />
            {COPY.making}
          </Button>
        ) : (
          <>
            {producibleNow > 0 && chatPackage ? (
              <Button
                type="button"
                variant={canPlanPublishing(progress) ? "outline" : "default"}
                className="min-h-11 rounded-lg px-4"
                onClick={makeMore}
                disabled={pending || blocked}
                title={reason ?? undefined}
              >
                <Sparkles className="size-4" />
                {COPY.makeMore(producibleNow)}
              </Button>
            ) : null}
            <Button
              type="button"
              className="min-h-11 rounded-lg px-4"
              onClick={() => setPicked("publish")}
              disabled={!canPlanPublishing(progress)}
            >
              {COPY.planPublishing}
              <ArrowRight className="size-4" />
            </Button>
          </>
        )}
      </PaneFooter>
    );
  } else if (!superseded && shown === "publish" && !progress.allApproved) {
    footer = (
      <PaneFooter
        summary={COPY.toApprove(postsToApprove)}
        helper={COPY.connectedOf(
          platforms.filter((key) => connected.includes(key)).length,
          platforms.length,
        )}
      >
        <Button
          type="button"
          className="min-h-11 rounded-lg px-4"
          onClick={approveAll}
          disabled={!approved || pending || blocked || progress.ready === 0}
          title={reason ?? undefined}
        >
          {pending ? COPY.approving : COPY.approve}
        </Button>
      </PaneFooter>
    );
  }

  return (
    <div
      data-plan-pane
      data-step={shown}
      className="w-full space-y-5 px-1 pb-2"
      style={{ opacity: superseded ? 0.6 : 1 }}
    >
      <PaneHeader
        meta={meta}
        accountsOpen={accountsOpen}
        onAccounts={() => setAccountsOpen((open) => !open)}
      />
      {superseded ? (
        <WsStatusPill label={COPY.replaced} tone="waiting" />
      ) : null}
      <PlanStepper
        states={states}
        openable={openable}
        onPick={(step) => setPicked(step)}
      />

      {accountsOpen ? (
        <AccountsPanel
          connections={card.connections}
          connected={connected}
          hrefOf={(key) => connectHrefOf(key)}
          onClose={() => setAccountsOpen(false)}
        />
      ) : null}

      <ChannelChips
        active={platforms}
        connected={connected}
        locked={!draft || !editable}
        onToggle={togglePlatform}
        story={{ on: story, onToggle: toggleStory }}
        connectHrefOf={(key) => connectHrefOf(key)}
        accountOf={(key) =>
          host.accountLabels?.[key] ?? card.connections?.[key]?.accountLabel
        }
      />
      {draft && heldChannels.length > 0 ? (
        <p className="-mt-2 text-xs" style={{ color: "var(--ws-text-2)" }}>
          {COPY.notConnectedLine(
            heldChannels.map((key) => CHANNELS[key].label).join(", "),
          )}
        </p>
      ) : null}

      {shown === "publish" ? (
        progress.allApproved ? (
          <PublishCalendar
            posts={reviewPosts}
            scheduleEnabled={card.scheduleEnabled}
            instagramNeedsSchedule={instagramNeedsSchedule}
            scheduleBusy={scheduleBusy}
            onTurnOnSchedule={turnOnSchedule}
            onSeeContent={() => setPicked("content")}
            calendarHref={calendarHref}
          />
        ) : (
          <PublishReview
            posts={reviewPosts}
            toApprove={postsToApprove}
            timezone={timezone}
            scheduleEnabled={card.scheduleEnabled}
            heldChannels={heldChannels}
            approved={approved}
            onApprovedChange={setApproved}
            onEdit={() => setPicked("content")}
          />
        )
      ) : (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px]" style={{ color: "var(--ws-text-2)" }}>
              <span
                className="font-semibold"
                style={{ color: "var(--ws-text)" }}
              >
                {COPY.postsCount(posts.length)}
              </span>
              {` · ${COPY.channelCount(pieceCount)}`}
            </p>
            <ViewToggle view={view} onChange={setView} />
          </div>
          {view === "week" && week ? (
            <WeekStrip
              days={week.days}
              counts={dayCounts}
              selected={selectedDay}
              label={rangeLabel(week.days)}
              onSelect={setDayPick}
              onPrevious={
                weeks.length > 1 && weekIndex > 0
                  ? () => {
                      setWeekIndex(weekIndex - 1);
                      setDayPick(null);
                    }
                  : undefined
              }
              onNext={
                weeks.length > 1 && weekIndex < weeks.length - 1
                  ? () => {
                      setWeekIndex(weekIndex + 1);
                      setDayPick(null);
                    }
                  : undefined
              }
            />
          ) : null}
          {shownPosts.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
              {COPY.nothingThatDay}
            </p>
          ) : (
            <ul className="space-y-2.5">
              {shownPosts.map((post) => {
                const tabs = tabsFor(post);
                // The pieces the post still has (a left-out channel stays put).
                const livePieces = tabs
                  .filter(isLiveDelivery)
                  .map((tab) => tab.piece);
                const postId = draft ? undefined : postIdOf(post);
                const index = post.indices[0] ?? 0;
                const item = sourceItems[index];
                // A draft's post changes its idea; a saved one only while its single
                // piece is still waiting for content (the server checks again).
                const swappable =
                  !superseded &&
                  !blocked &&
                  !!item &&
                  post.indices.length === 1 &&
                  (draft ||
                    (tabs.length === 1 && tabs[0]?.piece?.stage === "PLANNED"));
                const shownFor = suggestionFor(index);
                return (
                  <PostCard
                    key={post.key}
                    topic={post.topic}
                    purpose={item?.purpose}
                    idea={post.captionIdea}
                    date={post.date}
                    time={post.time}
                    tabs={tabs}
                    state={draft ? "idea" : stateOfTabs(tabs)}
                    open={openNow === post.key}
                    onToggle={() =>
                      setOpenKey(openNow === post.key ? "" : post.key)
                    }
                    step={shown === "content" ? "content" : "plan"}
                    connected={connected}
                    connections={card.connections}
                    timezone={timezone}
                    today={today}
                    move={
                      draft && editable
                        ? {
                            canRemove: posts.length > 1,
                            onMove: (date, time) => {
                              // The post is named by its day: the open card follows it.
                              if (openNow === post.key) {
                                setOpenKey(
                                  postKeyOf({ date, time, topic: post.topic }),
                                );
                              }
                              edit(
                                () =>
                                  applyDraft({
                                    type: "move",
                                    indices: post.indices,
                                    date,
                                    time,
                                  }),
                                (id) =>
                                  movePlanPostAction(
                                    id,
                                    post.indices,
                                    post.topic,
                                    date,
                                    time,
                                  ),
                              );
                            },
                            onRemove: () =>
                              edit(
                                () =>
                                  applyDraft({
                                    type: "remove",
                                    indices: post.indices,
                                  }),
                                (id) =>
                                  removePlanPostAction(
                                    id,
                                    post.indices,
                                    post.topic,
                                  ),
                              ),
                          }
                        : !draft &&
                            !superseded &&
                            host.active &&
                            canMovePost(livePieces)
                          ? {
                              canRemove: false,
                              onMove: (date, time) =>
                                moveMade(post, livePieces, date, time),
                              // A made post does not leave the plan from here.
                              onRemove: () => undefined,
                            }
                          : undefined
                    }
                    newIdea={
                      swappable
                        ? {
                            onNew: () => newIdeaFor(index, post.key),
                            busy:
                              generating === index ||
                              (waiting?.index === index && !arrived),
                            disabled:
                              generating !== null && generating !== index,
                            suggestion: shownFor
                              ? {
                                  topic: shownFor.alt.topic,
                                  captionIdea: shownFor.alt.captionIdea,
                                  from: shownFor.alt.from,
                                  position: shownFor.at + 1,
                                  total: item?.alternatives?.length ?? 1,
                                }
                              : undefined,
                            onUse: () => approveIdea(index),
                            onKeep: keepIdea,
                          }
                        : undefined
                    }
                    edit={
                      !draft && !superseded
                        ? { projectId, workId, active: host.active }
                        : undefined
                    }
                    onLeaveOut={
                      !superseded && !blocked
                        ? (tab) => toggleLeftOut(post, tab)
                        : undefined
                    }
                    approve={
                      postId &&
                      shown === "content" &&
                      !superseded &&
                      host.active &&
                      canApprovePost(liveStagesOf(tabs))
                        ? {
                            onApprove: () => void approvePost(postId),
                            busy: approvingPost === postId,
                          }
                        : undefined
                    }
                  />
                );
              })}
            </ul>
          )}
        </section>
      )}

      {!superseded ? (
        <BrandCheck card={card} commandId={commandId} host={host} />
      ) : null}

      {stale ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {COPY.stale}
          </p>
          {sendChat ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11 rounded-lg px-4"
              onClick={planAgain}
            >
              {COPY.planAgain}
            </Button>
          ) : null}
        </div>
      ) : null}

      {footer}
    </div>
  );
}

function PaneFooter({
  summary,
  helper,
  note,
  children,
}: {
  summary: string;
  helper?: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className="border-t pt-4" style={{ borderColor: "var(--ws-border)" }}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p
            className="text-sm font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {summary}
          </p>
          {helper ? (
            <p className="mt-0.5 text-xs" style={{ color: "var(--ws-text-2)" }}>
              {helper}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {children}
        </div>
      </div>
      {note ? (
        <p
          className="mt-2 text-right text-xs"
          style={{ color: "var(--ws-text-3)" }}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}

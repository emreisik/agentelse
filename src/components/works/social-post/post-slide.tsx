"use client";

import {
  useId,
  useState,
  useTransition,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  ImageIcon,
  Loader2,
  MoreHorizontal,
  PenLine,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { ChannelMark } from "@/components/commands/channel-badge";
import { useChatPackage } from "@/components/commands/chat-package-context";
import type { LivePlanPiece } from "@/components/commands/package-run";
import type { WsTone } from "@/components/commands/ws-event-card";
import { FacebookShareRow } from "@/components/integrations/facebook-share-row";
import { ImageLightbox } from "@/components/shared/image-lightbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OutputPreviewDialog } from "@/components/workspace/output-preview-dialog";
import { CreativePublishLine } from "@/components/works/creative-publish-line";
import { CreativeRating } from "@/components/works/creative-rating";
import { PostResult } from "@/components/works/post-result";
import { StageDot } from "@/components/works/stage-dot";
import {
  disabledReasonOf,
  useWorkCardHost,
} from "@/components/works/work-card-host";
import { assetUrl } from "@/lib/asset-url";
import type { PlanItemStage } from "@/lib/journey";
import { boostAdHref, boostCreativeOf } from "@/lib/module-flows/ads/boost";
import { MODULES } from "@/lib/modules/catalog";
import { cn } from "@/lib/utils";
import { postStateOf, type PostState } from "@/lib/works/plan-pane";
import {
  CONTENT_STAGES,
  channelCountOf,
  deliveryNameOf,
  leaveOutOf,
  postPrimaryOf,
  postWhenOf,
  slidePictureOf,
  type SlideDelivery,
  type SlidePicture,
  type SlidePost,
} from "@/lib/works/plan-posts";
import { pieceTextOf } from "@/lib/works/piece-text";
import { integrationsHref } from "@/lib/works/starter-cards";
import { approveApprovalAction } from "@/server/actions/approval-actions";
import { reviseCreativeAction } from "@/server/actions/creative-actions";
import {
  approvePostAction,
  publishPostNowAction,
  setDeliveryExcludedAction,
} from "@/server/actions/post-actions";

import { CreatingImage } from "./creating-image";
import {
  Caption,
  PostHeader,
  PostShell,
  SOCIAL_POST_COPY,
  STATUS_PILLS,
} from "./social-post-card";

// One post of a saved plan in the chat (docs/works.md "Posts"): one idea, one
// card. Its channels (Instagram post, Story, Facebook...) are its deliveries,
// one tab each, every one in its own format and words, made from the post's
// one picture. The slide carries ONE main button for the whole post: make what
// is missing, then approve it all. What concerns one delivery (its picture,
// caption, rating, revise, publish line, Facebook row, leaving it out) shows
// for the selected tab.

export type PlanSlidePost = SlidePost<LivePlanPiece>;
type Delivery = SlideDelivery<LivePlanPiece>;

export const POST_SLIDE_COPY = {
  tabs: "Channels of this post",
  channelCount: (n: number) => `${n} ${n === 1 ? "channel" : "channels"}`,
  leftOut: "Left out",
  leftOutNote: "Left out of this post: it is not made or posted.",
  leaveOut: "Leave out",
  include: "Include",
  leftOutToast: (label: string) => `${label} is left out of this post.`,
  includedToast: (label: string) => `${label} is back in this post.`,
  posted: "Already posted",
  beingMade: "Wait until it is made",
  lastChannel: "A post keeps at least one channel.",
  make: "Make post",
  retry: "Try again",
  making: "Making…",
  approve: "Approve post",
  // A plan saved before posts approves its channels one by one.
  approveSingle: "Approve",
  approveOne: (label: string) => `Approve ${label}`,
  approved: "Post approved",
  approvedOne: "Approved",
  postNow: "Post now",
  // Opens the Ads Manager with this post as the ad's source.
  boost: "Boost with an ad",
  postConfirm: "Post it now on its approved channels? It goes live right away.",
  posting: "Posting now.",
  cancel: "Cancel",
  declinedHint:
    "Revise the declined channel or leave it out to approve the post.",
  connectFacebook: "Connect Facebook",
  revise: SOCIAL_POST_COPY.revise,
  revisePlaceholder: SOCIAL_POST_COPY.revisePlaceholder,
  revising: SOCIAL_POST_COPY.revising,
  details: SOCIAL_POST_COPY.details,
  more: SOCIAL_POST_COPY.more,
  failed: SOCIAL_POST_COPY.failed,
} as const;

const COPY = POST_SLIDE_COPY;

// The one pill of a post, from where its deliveries stand together.
const POST_PILL: Record<PostState, { label: string; tone: WsTone }> = {
  idea: { label: "Needs content", tone: "neutral" },
  needs: { label: "Needs content", tone: "neutral" },
  making: { label: "Making…", tone: "waiting" },
  failed: { label: "Couldn't make it", tone: "danger" },
  declined: STATUS_PILLS.REJECTED!,
  ready: STATUS_PILLS.IN_REVIEW!,
  scheduled: STATUS_PILLS.APPROVED!,
  published: STATUS_PILLS.PUBLISHED!,
};

const STAGE_LABEL: Record<PlanItemStage, string> = {
  PLANNED: "Needs content",
  PRODUCING: "Making",
  FAILED: "Couldn't make it",
  IN_REVIEW: "In review",
  REJECTED: "Declined",
  APPROVED: "Approved",
  PUBLISHED: "Published",
};

// A picture never makes the slide taller than this: a 9:16 story or a 3:4 post
// sits inside the frame (object-contain) instead of stretching the row.
const PICTURE_MAX_HEIGHT = 320;

const ICON_BUTTON =
  "inline-flex size-8 items-center justify-center rounded-lg outline-none transition-colors hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50";

const PRIMARY =
  "inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-xl text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50";

const QUIET =
  "inline-flex min-h-8 items-center rounded-lg px-2 text-[12px] font-medium outline-none transition-colors hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 disabled:hover:bg-transparent";

// A delivery's words: its made version, else what the plan holds for it.
function textOf(delivery: Delivery): string | undefined {
  const card = delivery.card;
  if (card) {
    return pieceTextOf({
      assetId: card.assetId,
      caption: card.caption,
      copy: card.copy,
    });
  }
  return delivery.slot?.text;
}

function hasContent(delivery: Delivery): boolean {
  return (
    delivery.card !== undefined ||
    CONTENT_STAGES.has(delivery.stage) ||
    delivery.stage === "REJECTED"
  );
}

// The key an optimistic approval is held under: a revised delivery (a new
// version) waits for a decision again.
function approvalKeyOf(delivery: Delivery): string {
  return `${delivery.id}@${delivery.card?.versionNumber ?? ""}`;
}

export function PostSlide({
  post,
  commandId,
  topic,
  onOpenPlan,
}: {
  post: PlanSlidePost;
  // The plan's Command: its runs make the post.
  commandId?: string;
  // The post's idea, shown while it has no picture yet.
  topic: string;
  onOpenPlan?: () => void;
}) {
  const router = useRouter();
  const host = useWorkCardHost();
  const chatPackage = useChatPackage();
  const baseId = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const [pressed, setPressed] = useState(false);
  const [approvedKeys, setApprovedKeys] = useState<readonly string[]>([]);
  const [confirmPost, setConfirmPost] = useState(false);
  const [details, setDetails] = useState<string | null>(null);
  const [showRevise, setShowRevise] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [acting, startActing] = useTransition();
  const [revising, startRevising] = useTransition();

  // A delivery approved here reads as approved until the page catches up.
  const deliveries = post.deliveries.map((delivery) =>
    delivery.stage === "IN_REVIEW" &&
    approvedKeys.includes(approvalKeyOf(delivery))
      ? { ...delivery, stage: "APPROVED" as const }
      : delivery,
  );
  const live = deliveries.filter((delivery) => !delivery.excluded);
  const stages = live.map((delivery) => delivery.stage);
  const selected =
    deliveries.find((delivery) => delivery.id === picked) ??
    live[0] ??
    deliveries[0]!;

  const blocked = disabledReasonOf(host, {
    kind: "server",
    planId: commandId,
  });
  const primary = pressed ? { kind: "making" as const } : postPrimaryOf(stages);
  const state: PostState = pressed ? "making" : postStateOf(stages);
  const brand = selected.card?.brandName ?? host?.projectName ?? "Your brand";
  const handle =
    (selected.channel && host?.accountLabels?.[selected.channel]) || brand;
  const sub = [
    postWhenOf(deliveries),
    COPY.channelCount(channelCountOf(live.map((delivery) => delivery.item))),
  ]
    .filter(Boolean)
    .join(" · ");

  const fail = (message: string) => {
    setError(message);
    toast.error(message);
  };

  const pick = (id: string) => {
    setPicked(id);
    setShowRevise(false);
    setError(null);
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, at: number) => {
    const last = deliveries.length - 1;
    const next =
      event.key === "ArrowRight"
        ? at === last
          ? 0
          : at + 1
        : event.key === "ArrowLeft"
          ? at === 0
            ? last
            : at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    const target = next === null ? undefined : deliveries[next];
    if (next === null || !target) return;
    event.preventDefault();
    pick(target.id);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
  };

  // ---- the post's actions ----------------------------------------------------

  const make = () => {
    if (!chatPackage || !commandId || blocked) return;
    setError(null);
    setPressed(true);
    // Only this post's channels; a plan saved before posts makes its nearest
    // posts. The run streams for a while: the button reads "Making…" until it
    // ends, the pieces show their progress in their tabs.
    void chatPackage
      .startPlan(
        post.postId ? { commandId, postId: post.postId } : { commandId },
      )
      .finally(() => setPressed(false));
  };

  const approvePost = () => {
    const postId = post.postId;
    if (!postId || blocked) return;
    const waiting = live
      .filter((delivery) => delivery.stage === "IN_REVIEW")
      .map(approvalKeyOf);
    setError(null);
    startActing(async () => {
      try {
        const result = await approvePostAction(postId);
        if (!result.ok) return fail(result.message);
        setApprovedKeys((current) => [...current, ...waiting]);
        toast.success(COPY.approved);
        host?.announce(COPY.approved);
        router.refresh();
      } catch {
        fail(COPY.failed);
      }
    });
  };

  // A plan saved before posts: its channels are approved one by one, the
  // selected one first.
  const legacyTarget = post.postId
    ? undefined
    : [selected, ...live].find(
        (delivery) =>
          !delivery.excluded &&
          delivery.stage === "IN_REVIEW" &&
          Boolean(delivery.card?.approvalId),
      );

  const approveOne = (delivery: Delivery) => {
    const approvalId = delivery.card?.approvalId;
    if (!approvalId || blocked) return;
    setError(null);
    startActing(async () => {
      try {
        const formData = new FormData();
        formData.set("approvalId", approvalId);
        const result = await approveApprovalAction(formData);
        if (!result.ok) return fail(result.message);
        setApprovedKeys((current) => [...current, approvalKeyOf(delivery)]);
        toast.success(COPY.approvedOne);
        host?.announce(COPY.approvedOne);
        router.refresh();
      } catch {
        fail(COPY.failed);
      }
    });
  };

  const postNow = () => {
    const postId = post.postId;
    if (!postId || blocked) return;
    setError(null);
    startActing(async () => {
      try {
        const result = await publishPostNowAction(postId);
        if (!result.ok) return fail(result.message);
        setConfirmPost(false);
        toast.success(COPY.posting);
        // A channel that could not go (posted by hand, not connected) says so.
        if (result.message) toast.info(result.message);
        host?.announce(COPY.posting);
        router.refresh();
      } catch {
        fail(COPY.failed);
      }
    });
  };

  const toggleExcluded = (delivery: Delivery) => {
    if (blocked) return;
    const excluded = !delivery.excluded;
    setError(null);
    startActing(async () => {
      try {
        const result = await setDeliveryExcludedAction(delivery.id, excluded);
        if (!result.ok) return fail(result.message);
        const message = excluded
          ? COPY.leftOutToast(deliveryNameOf(delivery))
          : COPY.includedToast(deliveryNameOf(delivery));
        toast.success(message);
        host?.announce(message);
        router.refresh();
      } catch {
        fail(COPY.failed);
      }
    });
  };

  const revise = () => {
    const wanted = instruction.trim();
    if (!wanted || blocked) return;
    setError(null);
    startRevising(async () => {
      try {
        const result = await reviseCreativeAction(selected.id, wanted);
        if (!result.ok) return fail(result.message);
        setInstruction("");
        setShowRevise(false);
        toast.success(COPY.revising);
        router.refresh();
      } catch {
        fail(COPY.failed);
      }
    });
  };

  // ---- the parts ---------------------------------------------------------------

  const canPostNow = Boolean(post.postId) && stages.includes("APPROVED");
  const canDetails = hasContent(selected);
  // An approved or posted post with its picture made can become an ad (the
  // Ads Manager starts from it, its feed picture before its Story).
  const boostId =
    host && MODULES.ads.ready
      ? boostCreativeOf(
          deliveries.map((delivery) => ({
            id: delivery.id,
            stage: delivery.stage,
            excluded: delivery.excluded,
            assetId: slidePictureOf(delivery)?.assetId,
            formatKey: delivery.format?.key,
          })),
        )
      : null;
  const menu =
    canDetails || canPostNow || boostId ? (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={COPY.more}
          className="-mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
          style={{ color: "var(--ws-text-2)" }}
        >
          <MoreHorizontal aria-hidden className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {canDetails ? (
            <DropdownMenuItem onClick={() => setDetails(selected.id)}>
              {COPY.details}
            </DropdownMenuItem>
          ) : null}
          {canPostNow ? (
            <DropdownMenuItem
              disabled={acting || blocked !== null}
              onClick={() => setConfirmPost(true)}
            >
              {COPY.postNow}
            </DropdownMenuItem>
          ) : null}
          {boostId && host ? (
            <DropdownMenuItem
              render={<Link href={boostAdHref(host.projectId, boostId)} />}
            >
              {COPY.boost}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  const panelId = `${baseId}-panel`;
  const tabIdOf = (delivery: Delivery) => `${baseId}-tab-${delivery.id}`;

  const tabs = (
    <div
      role="tablist"
      aria-label={COPY.tabs}
      className="flex flex-wrap gap-1 px-3 pb-2"
    >
      {deliveries.map((delivery, at) => {
        const on = delivery.id === selected.id;
        return (
          <button
            key={delivery.id}
            type="button"
            role="tab"
            id={tabIdOf(delivery)}
            aria-selected={on}
            aria-controls={panelId}
            tabIndex={on ? 0 : -1}
            // The "next step" bar brings a delivery waiting for review into
            // view by its id.
            data-creative-id={delivery.id}
            data-excluded={delivery.excluded ? "" : undefined}
            onClick={() => pick(delivery.id)}
            onKeyDown={(event) => onTabKey(event, at)}
            className={cn(
              "inline-flex min-h-8 items-center gap-1 rounded-full border px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              delivery.excluded && "opacity-55",
            )}
            style={{
              borderColor: on ? "var(--ws-text-3)" : "var(--ws-border)",
              background: on ? "var(--ws-hover)" : "transparent",
              color: on ? "var(--ws-text)" : "var(--ws-text-2)",
            }}
          >
            {delivery.channel ? (
              <ChannelMark
                channel={delivery.channel}
                decorative
                className="size-4"
              />
            ) : null}
            <span>{delivery.label}</span>
            {delivery.excluded ? (
              <span
                className="text-[11px] font-normal"
                style={{ color: "var(--ws-text-3)" }}
              >
                {COPY.leftOut}
              </span>
            ) : (
              <>
                <StageDot stage={delivery.stage} />
                <span className="sr-only">{STAGE_LABEL[delivery.stage]}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );

  const text = textOf(selected);
  const picture = slidePictureOf(selected);
  // Made: its own words. Not made yet: the plan's idea for its caption under
  // the empty frame (which names the post's idea), or the idea itself.
  const caption = hasContent(selected)
    ? text
    : picture
      ? selected.item.captionIdea.trim() || topic
      : topic;
  const card = selected.card;
  const finished =
    selected.stage === "APPROVED" || selected.stage === "PUBLISHED";
  const isFacebook = selected.channel === "facebook";
  const facebookConnected =
    host?.connectedChannels?.includes("facebook") ?? false;
  const toggle = leaveOutOf(selected, { postId: post.postId, stages });
  const toggleReason =
    toggle?.blocked === "posted"
      ? COPY.posted
      : toggle?.blocked === "making"
        ? COPY.beingMade
        : toggle?.blocked === "last"
          ? COPY.lastChannel
          : (blocked ?? undefined);
  const canRevise = card !== undefined && !selected.excluded;
  const canRate = canRevise && CONTENT_STAGES.has(selected.stage);

  const footer = (
    <div className="space-y-2 px-3 pt-1">
      {selected.excluded ? (
        <p className="text-[12px]" style={{ color: "var(--ws-text-3)" }}>
          {COPY.leftOutNote}
        </p>
      ) : null}

      {canRate || canRevise || toggle ? (
        <div className="-ml-1.5 flex flex-wrap items-center gap-0.5">
          {canRate ? (
            <CreativeRating key={selected.id} creativeId={selected.id} inline />
          ) : null}
          {canRevise ? (
            <button
              type="button"
              aria-label={COPY.revise}
              title={COPY.revise}
              aria-pressed={showRevise}
              onClick={() => setShowRevise((open) => !open)}
              className={cn(ICON_BUTTON, showRevise && "bg-[var(--ws-hover)]")}
              style={{ color: "var(--ws-text-2)" }}
            >
              <PenLine aria-hidden className="size-4" />
            </button>
          ) : null}
          {toggle ? (
            <button
              type="button"
              data-leave-out={toggle.kind}
              disabled={
                acting || toggle.blocked !== undefined || blocked !== null
              }
              title={toggleReason}
              onClick={() => toggleExcluded(selected)}
              className={cn(QUIET, "ml-auto")}
              style={{ color: "var(--ws-text-2)" }}
            >
              {toggle.kind === "leave" ? COPY.leaveOut : COPY.include}
            </button>
          ) : null}
        </div>
      ) : null}

      {showRevise && canRevise ? (
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            revise();
          }}
        >
          <input
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder={COPY.revisePlaceholder}
            aria-label={COPY.revise}
            disabled={revising}
            autoFocus
            className="min-h-9 min-w-0 flex-1 rounded-lg border bg-transparent px-2.5 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:text-xs"
            style={{ borderColor: "var(--ws-border)", color: "var(--ws-text)" }}
          />
          <button
            type="submit"
            disabled={revising || !instruction.trim() || blocked !== null}
            title={blocked ?? undefined}
            className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
            style={{
              background: "var(--ws-accent)",
              color: "var(--ws-on-accent)",
            }}
          >
            {revising ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : null}
            {COPY.revise}
          </button>
        </form>
      ) : null}

      {/* Kardeş anahtarları önekli: üçü de seçili parçayla sıfırlanır, ama aynı
          anahtarı paylaşırlarsa React satırları her yenilemede çoğaltır
          (yayınlanmış parçada "Published." yığını). */}
      {card && !selected.excluded && !isFacebook ? (
        <CreativePublishLine key={`line-${selected.id}`} card={card} />
      ) : null}

      {/* The Facebook delivery goes to the Page through its own row, open
          once the post is approved. */}
      {card && !selected.excluded && isFacebook ? (
        facebookConnected ? (
          <FacebookShareRow
            key={`facebook-${selected.id}`}
            creativeId={selected.id}
            collapsed={!finished}
          />
        ) : host ? (
          <Link
            href={integrationsHref(host.projectId, "facebook", {
              fromWorkId: host.workId,
            })}
            className={cn(QUIET, "-ml-2")}
            style={{ color: "var(--ws-text-2)" }}
          >
            {COPY.connectFacebook}
          </Link>
        ) : null
      ) : null}

      {/* A published delivery asks how it did. */}
      {host?.projectId && selected.stage === "PUBLISHED" ? (
        <PostResult
          key={`result-${selected.id}`}
          projectId={host.projectId}
          creativeId={selected.id}
        />
      ) : null}

      {error ? (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );

  // ---- the one main button -------------------------------------------------

  const primaryButton = ((): ReactNode => {
    if (!primary) return null;
    if (primary.kind === "making") {
      return (
        <button
          type="button"
          data-post-primary="making"
          disabled
          className={PRIMARY}
          style={{ background: "var(--ws-hover)", color: "var(--ws-text-2)" }}
        >
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          {COPY.making}
        </button>
      );
    }
    if (primary.kind === "make") {
      if (!chatPackage || !commandId) return null;
      return (
        <button
          type="button"
          data-post-primary={primary.retry ? "retry" : "make"}
          disabled={blocked !== null}
          title={blocked ?? undefined}
          onClick={make}
          className={PRIMARY}
          style={{
            background: "var(--ws-accent)",
            color: "var(--ws-on-accent)",
          }}
        >
          {primary.retry ? (
            <RefreshCw aria-hidden className="size-3.5" />
          ) : (
            <Sparkles aria-hidden className="size-3.5" />
          )}
          {primary.retry ? COPY.retry : COPY.make}
        </button>
      );
    }
    // Approve: the whole post in one tap; a plan saved before posts approves
    // its channels one by one.
    const target = post.postId ? undefined : legacyTarget;
    if (!post.postId && !target) return null;
    const label = post.postId
      ? COPY.approve
      : live.length > 1 && target
        ? COPY.approveOne(deliveryNameOf(target))
        : COPY.approveSingle;
    return (
      <button
        type="button"
        data-post-primary="approve"
        disabled={acting || blocked !== null}
        title={blocked ?? undefined}
        onClick={() => (target ? approveOne(target) : approvePost())}
        className={PRIMARY}
        style={{ background: "var(--ws-accent)", color: "var(--ws-on-accent)" }}
      >
        {acting ? (
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <Check aria-hidden className="size-3.5" />
        )}
        {label}
      </button>
    );
  })();

  const declined = !primary && stages.includes("REJECTED");

  return (
    <PostShell variant="slide">
      <PostHeader
        name={handle}
        sub={sub}
        status={POST_PILL[state]}
        menu={menu}
      />
      {tabs}
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabIdOf(selected)}
        data-delivery={selected.id}
        className="flex flex-1 flex-col"
      >
        {picture ? (
          <DeliveryPicture
            delivery={selected}
            picture={picture}
            post={deliveries}
            topic={topic}
            making={
              selected.stage === "PRODUCING" ||
              (pressed && !hasContent(selected))
            }
            onOpenPlan={onOpenPlan}
          />
        ) : null}
        {caption ? (
          <div className="pt-2">
            <Caption name={handle} text={caption} />
          </div>
        ) : null}
        {footer}
      </div>

      <div className="mt-auto space-y-2 px-3 pt-2 pb-3">
        {confirmPost ? (
          <div
            role="group"
            aria-label={COPY.postNow}
            className="space-y-2 rounded-xl border p-2.5"
            style={{ borderColor: "var(--ws-border)" }}
          >
            <p className="text-[12px]" style={{ color: "var(--ws-text)" }}>
              {COPY.postConfirm}
            </p>
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={acting || blocked !== null}
                onClick={postNow}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
                style={{
                  background: "var(--ws-accent)",
                  color: "var(--ws-on-accent)",
                }}
              >
                {acting ? (
                  <Loader2 aria-hidden className="size-3.5 animate-spin" />
                ) : null}
                {COPY.postNow}
              </button>
              <button
                type="button"
                onClick={() => setConfirmPost(false)}
                className={QUIET}
                style={{ color: "var(--ws-text-2)" }}
              >
                {COPY.cancel}
              </button>
            </div>
          </div>
        ) : null}
        {primaryButton}
        {primaryButton && blocked && primary?.kind !== "making" ? (
          <p className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
            {blocked}
          </p>
        ) : null}
        {declined ? (
          <p className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
            {COPY.declinedHint}
          </p>
        ) : null}
      </div>

      <OutputPreviewDialog
        creativeId={details}
        onOpenChange={(open) => {
          if (!open) setDetails(null);
        }}
      />
    </PostShell>
  );
}

// The selected delivery's own picture at its own shape, never taller than the
// frame; while it (or its post's picture) is made, the live "Creating image".
function DeliveryPicture({
  delivery,
  picture,
  post,
  topic,
  making,
  onOpenPlan,
}: {
  delivery: Delivery;
  picture: SlidePicture;
  post: readonly Delivery[];
  topic: string;
  making: boolean;
  onOpenPlan?: () => void;
}) {
  const frame = {
    aspectRatio: `${picture.width} / ${picture.height}`,
    maxHeight: PICTURE_MAX_HEIGHT,
    background: "var(--ws-hover)",
  };
  const alt = textOf(delivery) ?? topic;
  const assetId = picture.assetId;
  // A channel left out of the post is faded like its tab.
  const faded = delivery.excluded && "opacity-50";

  if (assetId) {
    return (
      <ImageLightbox
        src={assetUrl(assetId, "large")}
        alt={alt}
        title={topic}
        className={cn(
          "block w-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          faded,
        )}
      >
        <span className="relative block w-full" style={frame}>
          {/* eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it */}
          <img
            src={assetUrl(assetId, "card")}
            alt={alt}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full object-contain"
          />
        </span>
      </ImageLightbox>
    );
  }

  // Its own progress, else the post's picture being made for it.
  const progress = making
    ? delivery.making?.imageGen
      ? delivery.making
      : post.find((other) => other.making?.imageGen)?.making
    : undefined;
  return (
    <button
      type="button"
      onClick={onOpenPlan}
      disabled={!onOpenPlan}
      className={cn(
        "relative block w-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        faded,
      )}
      style={frame}
    >
      {progress?.imageGen ? (
        <CreatingImage
          state={progress.imageGen}
          previewUrl={progress.previewUrl}
        />
      ) : (
        <span
          className={cn(
            "absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center",
            making && "animate-pulse",
          )}
          style={{ color: "var(--ws-text-3)" }}
        >
          {making ? (
            <Loader2 aria-hidden className="size-5 animate-spin" />
          ) : delivery.stage === "FAILED" ? (
            <TriangleAlert aria-hidden className="size-5" />
          ) : (
            <ImageIcon aria-hidden className="size-5" />
          )}
          <span
            className="line-clamp-3 text-xs font-medium"
            style={{ color: "var(--ws-text-2)" }}
          >
            {topic}
          </span>
        </span>
      )}
    </button>
  );
}

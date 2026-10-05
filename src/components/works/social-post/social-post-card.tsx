"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  Clock,
  ImageIcon,
  Loader2,
  MoreHorizontal,
  PenLine,
  TriangleAlert,
} from "lucide-react";

import {
  BrandIcon,
  type BrandKey,
} from "@/components/integrations/brand-icons";
import { FacebookShareRow } from "@/components/integrations/facebook-share-row";
import { ImageLightbox } from "@/components/shared/image-lightbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WsStatusPill, type WsTone } from "@/components/commands/ws-event-card";
import { OutputPreviewDialog } from "@/components/workspace/output-preview-dialog";
import {
  CreativePublishLine,
  whenLabelOf,
} from "@/components/works/creative-publish-line";
import { CreativeRating } from "@/components/works/creative-rating";
import { PostResult } from "@/components/works/post-result";
import { CreativeVariantsStrip } from "@/components/works/creative-variants-strip";
import {
  disabledReasonOf,
  useWorkCardHost,
  type WorkCardHostValue,
} from "@/components/works/work-card-host";
import { assetUrl } from "@/lib/asset-url";
import {
  CHANNELS,
  isChannelKey,
  resolveFormat,
  type ChannelKey,
} from "@/lib/content-channels";
import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import type { ImageGenState } from "@/lib/image-progress";
import type { PlanItemStage } from "@/lib/journey";
import { stripCapabilityPrefix } from "@/lib/labels/core";
import { cn } from "@/lib/utils";
import { slotWhenLabel } from "@/lib/works/slot-rules";
import { pieceTextOf } from "@/lib/works/piece-text";
import { integrationsHref } from "@/lib/works/starter-cards";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";
import { reviseCreativeAction } from "@/server/actions/creative-actions";
import type { FacebookShareState } from "@/server/commands/facebook-share";
import type { CreativeCardData } from "@/types/creative-card";

import { CreatingImage } from "./creating-image";

// Every produced piece in a Work is shown as the post it will be (docs/works.md
// "Social post card"): the account on top, the picture, one row of icon
// actions, the caption, and the integrations it goes to as icons. Everything a
// piece needs (approve, revise, learn, publish, share on Facebook) happens
// inside this one card: nothing is stacked under it.

type ReadyCard = Extract<CreativeCardData, { kind: "creative-ready" }>;

export const SOCIAL_POST_COPY = {
  approve: "Approve",
  addToCalendar: "Add to calendar",
  approvePublish: "Approve & publish",
  approved: "Approved",
  approvedPublishing: "Approved — publishing now",
  approvedPlanned: "Approved — it goes out at its planned time",
  addedToCalendar: "Added to the next calendar slot",
  declined: "Declined",
  decline: "Decline",
  revise: "Revise",
  revisePlaceholder: "What should change? e.g. warmer colours",
  reviseGo: "Revise",
  revising: "Revising — the new version replaces this one",
  details: "View details",
  more: "More",
  showMore: "more",
  failed: "Something went wrong, please try again.",
  connect: (channel: string) => `Connect ${channel}`,
  postedOn: (channel: string) => `Published on ${channel}`,
  scheduledOn: (channel: string) => `Scheduled on ${channel}`,
  publishingOn: (channel: string) => `Publishing on ${channel}…`,
  goesTo: (channel: string) => `Goes to ${channel}`,
  facebookShare: "Share on your Facebook Page",
  facebookPosted: "On your Facebook Page",
  facebookSharing: "Sharing on Facebook…",
  facebookLater: "Approve it to share on your Facebook Page",
  facebookReconnect: "Facebook needs reconnecting",
  needsContent: "Needs content",
  making: "Making…",
  makeFailed: "Couldn't make it",
} as const;

const STATUS: Record<string, { label: string; tone: WsTone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  IN_REVIEW: { label: "In review", tone: "waiting" },
  APPROVED: { label: "Approved", tone: "positive" },
  PUBLISHED: { label: "Published", tone: "positive" },
  REJECTED: { label: "Declined", tone: "danger" },
  ARCHIVED: { label: "Replaced", tone: "neutral" },
};

const STAGE: Partial<Record<PlanItemStage, { label: string; tone: WsTone }>> = {
  PLANNED: { label: SOCIAL_POST_COPY.needsContent, tone: "neutral" },
  PRODUCING: { label: SOCIAL_POST_COPY.making, tone: "waiting" },
  FAILED: { label: SOCIAL_POST_COPY.makeFailed, tone: "danger" },
};

// A finished post the client can still pass a verdict on.
const RATED_STATUSES: ReadonlySet<string> = new Set([
  "IN_REVIEW",
  "APPROVED",
  "PUBLISHED",
]);

const BRAND_OF: Partial<Record<ChannelKey, BrandKey>> = {
  instagram: "instagram",
  facebook: "facebook",
  tiktok: "tiktok",
  linkedin: "linkedin",
  x: "x",
};

export type PostVariant = "single" | "slide";

// The picture beside a single post fits this box: a 4:5 post fills it, a
// story is narrower, a landscape post shorter.
const THUMB = { width: 128, height: 160 } as const;

function thumbWidthOf(width: number, height: number): number {
  if (!(width > 0 && height > 0)) return THUMB.width;
  return Math.round(Math.min(THUMB.width, (THUMB.height * width) / height));
}

// ---- shell -----------------------------------------------------------------

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "•";
}

export function PostShell({
  variant,
  children,
  creativeId,
}: {
  variant: PostVariant;
  children: ReactNode;
  creativeId?: string;
}) {
  return (
    <article
      // The "next step" bar scrolls to a piece waiting for review by this id.
      data-creative-id={creativeId}
      data-social-post={variant}
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border",
        variant === "single" ? "mt-1 w-full max-w-[520px]" : "h-full w-full",
      )}
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
        boxShadow: "var(--ws-card-shadow)",
      }}
    >
      {children}
    </article>
  );
}

export function PostHeader({
  name,
  sub,
  status,
  menu,
  compact = false,
}: {
  name: string;
  sub: string;
  status?: { label: string; tone: WsTone };
  menu?: ReactNode;
  // Beside the picture: no avatar (the picture is the post) and no padding of
  // its own.
  compact?: boolean;
}) {
  return (
    <header
      className={cn(
        "flex items-center",
        compact ? "gap-2" : "gap-2.5 px-3 py-2.5",
      )}
    >
      {compact ? null : (
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold"
          style={{
            background: "var(--ws-accent)",
            color: "var(--ws-on-accent)",
          }}
        >
          {initialOf(name)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-[13px] leading-tight font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          {name}
        </span>
        <span
          className="block truncate text-[11px] leading-tight"
          style={{ color: "var(--ws-text-3)" }}
        >
          {sub}
        </span>
      </span>
      {status ? <WsStatusPill label={status.label} tone={status.tone} /> : null}
      {menu}
    </header>
  );
}

// The caption the way a feed shows it: the account in bold, two lines, "more".
// Beside the picture (`compact`) the header right above already names the
// account, so the caption is the text alone, three lines.
function Caption({
  name,
  text,
  compact = false,
}: {
  name: string;
  text?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const long = text.length > (compact ? 140 : 110) || text.includes("\n");
  return (
    <p
      className={cn(
        "text-[13px] leading-snug whitespace-pre-line",
        !compact && "px-3",
        !open && (compact ? "line-clamp-3" : "line-clamp-2"),
      )}
      style={{ color: "var(--ws-text)" }}
    >
      {compact ? null : <span className="font-semibold">{name} </span>}
      {text}
      {long && !open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="ml-1 text-[13px] outline-none hover:underline focus-visible:underline"
          style={{ color: "var(--ws-text-3)" }}
        >
          {SOCIAL_POST_COPY.showMore}
        </button>
      ) : null}
    </p>
  );
}

// ---- destinations ----------------------------------------------------------

export type DestinationState =
  "idle" | "scheduled" | "busy" | "done" | "off" | "failed";

const ICON_BUTTON =
  "relative inline-flex size-8 items-center justify-center rounded-full outline-none transition-colors hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50";

function StateDot({ state }: { state: DestinationState }) {
  if (state === "idle" || state === "off") return null;
  const tone =
    state === "done"
      ? "var(--ws-approved)"
      : state === "failed"
        ? "var(--destructive)"
        : "var(--ws-text-2)";
  return (
    <span
      aria-hidden
      className="absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full border"
      style={{
        background: "var(--ws-surface)",
        borderColor: "var(--ws-border)",
        color: tone,
      }}
    >
      {state === "done" ? (
        <Check className="size-2.5" strokeWidth={3} />
      ) : state === "busy" ? (
        <Loader2 className="size-2.5 animate-spin" />
      ) : state === "failed" ? (
        <TriangleAlert className="size-2.5" />
      ) : (
        <Clock className="size-2.5" />
      )}
    </span>
  );
}

// One integration as an icon: its brand mark and a small state badge. Not
// connected: faded, and a tap goes to connect it.
export function DestinationIcon({
  channel,
  state,
  label,
  href,
  onClick,
  pressed,
}: {
  channel: ChannelKey;
  state: DestinationState;
  label: string;
  href?: string;
  onClick?: () => void;
  pressed?: boolean;
}) {
  const brand = BRAND_OF[channel];
  const mark = brand ? (
    <BrandIcon brand={brand} className="size-[18px]" />
  ) : (
    <span className="text-[10px] font-semibold">{CHANNELS[channel].short}</span>
  );
  const body = (
    <>
      <span className={cn(state === "off" && "opacity-35 grayscale")}>
        {mark}
      </span>
      <StateDot state={state} />
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        aria-label={label}
        title={label}
        className={ICON_BUTTON}
      >
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(ICON_BUTTON, pressed && "bg-[var(--ws-hover)]")}
      >
        {body}
      </button>
    );
  }
  return (
    <span role="img" aria-label={label} title={label} className={ICON_BUTTON}>
      {body}
    </span>
  );
}

export function channelOfPlatform(
  platform?: string | null,
): ChannelKey | undefined {
  const key = platform?.toLowerCase();
  return isChannelKey(key) && CHANNELS[key].group === "social"
    ? key
    : undefined;
}

function isConnected(
  host: WorkCardHostValue | null,
  channel: ChannelKey,
): boolean {
  return host?.connectedChannels?.includes(channel) ?? false;
}

// The piece's own channel, read from its card: the publish line's kind is the
// truth for the pipeline, the status for the decision.
function ownState(card: ReadyCard, connected: boolean): DestinationState {
  if (card.status === "PUBLISHED" || card.publishLine?.kind === "published") {
    return "done";
  }
  if (!connected) return "off";
  switch (card.publishLine?.kind) {
    case "publishing":
      return "busy";
    case "failed":
      return "failed";
    case "scheduled":
      return card.publishLine.released ? "scheduled" : "idle";
    default:
      return "idle";
  }
}

function ownLabel(channel: ChannelKey, state: DestinationState): string {
  const name = CHANNELS[channel].label;
  switch (state) {
    case "done":
      return SOCIAL_POST_COPY.postedOn(name);
    case "scheduled":
      return SOCIAL_POST_COPY.scheduledOn(name);
    case "busy":
      return SOCIAL_POST_COPY.publishingOn(name);
    case "off":
      return SOCIAL_POST_COPY.connect(name);
    default:
      return SOCIAL_POST_COPY.goesTo(name);
  }
}

function facebookIconState(
  kind: FacebookShareState["kind"] | null,
): DestinationState {
  switch (kind) {
    case "posted":
      return "done";
    case "sharing":
      return "busy";
    case "failed":
      return "failed";
    case "reconnect":
    case "unavailable":
      return "off";
    default:
      return "idle";
  }
}

function facebookLabel(kind: FacebookShareState["kind"] | null): string {
  switch (kind) {
    case "posted":
      return SOCIAL_POST_COPY.facebookPosted;
    case "sharing":
      return SOCIAL_POST_COPY.facebookSharing;
    case "reconnect":
      return SOCIAL_POST_COPY.facebookReconnect;
    case "unavailable":
      return SOCIAL_POST_COPY.facebookLater;
    default:
      return SOCIAL_POST_COPY.facebookShare;
  }
}

// ---- the post --------------------------------------------------------------

function subLine(
  channel: ChannelKey | undefined,
  formatLabel: string | undefined,
  plannedFor: string | undefined,
  timezone: string | undefined,
): string {
  return [
    channel ? CHANNELS[channel].label : undefined,
    formatLabel,
    plannedFor ? whenLabelOf(plannedFor, timezone) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function SocialPostCard({
  card,
  variant = "single",
}: {
  card: ReadyCard;
  variant?: PostVariant;
}) {
  const router = useRouter();
  const host = useWorkCardHost();
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deciding, startDeciding] = useTransition();
  const [showRevise, setShowRevise] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [revising, startRevising] = useTransition();
  const [showDetails, setShowDetails] = useState(false);
  const [facebookKind, setFacebookKind] = useState<
    FacebookShareState["kind"] | null
  >(null);
  const [facebookOpen, setFacebookOpen] = useState(false);

  const status = localStatus ?? card.status;
  const channel = channelOfPlatform(card.platform);
  const format = getCreativePlatformFormat(card.platform, card.contentFormat);
  const width = card.assetWidth ?? format.pixelSize.width;
  const height = card.assetHeight ?? format.pixelSize.height;
  const isImage =
    Boolean(card.assetId) && (card.mimeType?.startsWith("image/") ?? true);
  const text = pieceTextOf({
    assetId: card.assetId,
    caption: card.caption,
    copy: card.copy,
  });
  const brand = card.brandName ?? host?.projectName ?? "Your brand";
  const handle = (channel && host?.accountLabels?.[channel]) || brand;
  const formatLabel =
    channel && card.contentFormat
      ? CHANNELS[channel].formats.find(
          (f) => f.contentFormat === card.contentFormat,
        )?.label
      : undefined;
  const blocked = disabledReasonOf(host, { kind: "server" });
  const canDecide = status === "IN_REVIEW" && Boolean(card.approvalId);
  const finished = status === "APPROVED" || status === "PUBLISHED";
  const facebookConnected = isConnected(host, "facebook");
  // Facebook is a destination of its own pieces and a one-tap cross-post of
  // every picture once the Page is connected.
  const showFacebook =
    facebookConnected &&
    (channel === "facebook" || (isImage && channel !== undefined));
  const ownConnected = channel ? isConnected(host, channel) : false;

  const decide = (to: "APPROVED" | "REJECTED") => {
    if (!card.approvalId || blocked) return;
    setError(null);
    startDeciding(async () => {
      try {
        const formData = new FormData();
        formData.set("approvalId", card.approvalId!);
        const action =
          to === "APPROVED" ? approveApprovalAction : rejectApprovalAction;
        const result = await action(formData);
        if (!result.ok) {
          setError(result.message);
          toast.error(result.message);
          return;
        }
        setLocalStatus(to);
        const message =
          to === "REJECTED"
            ? SOCIAL_POST_COPY.declined
            : card.approveIntent === "calendar"
              ? SOCIAL_POST_COPY.addedToCalendar
              : card.approveIntent === "publish"
                ? SOCIAL_POST_COPY.approvedPublishing
                : card.approveIntent === "planned"
                  ? SOCIAL_POST_COPY.approvedPlanned
                  : SOCIAL_POST_COPY.approved;
        toast.success(message);
        host?.announce(message);
        router.refresh();
      } catch {
        setError(SOCIAL_POST_COPY.failed);
        toast.error(SOCIAL_POST_COPY.failed);
      }
    });
  };

  const revise = () => {
    const wanted = instruction.trim();
    if (!wanted || blocked) return;
    setError(null);
    startRevising(async () => {
      try {
        const result = await reviseCreativeAction(card.creativeId, wanted);
        if (!result.ok) {
          setError(result.message);
          toast.error(result.message);
          return;
        }
        setInstruction("");
        setShowRevise(false);
        toast.success(SOCIAL_POST_COPY.revising);
        router.refresh();
      } catch {
        setError(SOCIAL_POST_COPY.failed);
        toast.error(SOCIAL_POST_COPY.failed);
      }
    });
  };

  const own = channel ? ownState({ ...card, status }, ownConnected) : null;
  const connectHref =
    channel && host && !ownConnected
      ? integrationsHref(host.projectId, channel, { fromWorkId: host.workId })
      : undefined;
  const approveLabel =
    card.approveIntent === "calendar"
      ? SOCIAL_POST_COPY.addToCalendar
      : card.approveIntent === "publish"
        ? SOCIAL_POST_COPY.approvePublish
        : SOCIAL_POST_COPY.approve;

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={SOCIAL_POST_COPY.more}
        className="-mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
        style={{ color: "var(--ws-text-2)" }}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={() => setShowRevise(true)}>
          {SOCIAL_POST_COPY.revise}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setShowDetails(true)}>
          {SOCIAL_POST_COPY.details}
        </DropdownMenuItem>
        {canDecide ? (
          <DropdownMenuItem
            variant="destructive"
            disabled={deciding || blocked !== null}
            onClick={() => decide("REJECTED")}
          >
            {SOCIAL_POST_COPY.decline}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const sub = subLine(channel, formatLabel, card.plannedFor, host?.timezone);
  const statusPill = STATUS[status] ?? {
    label: status,
    tone: "neutral" as const,
  };
  const shownText = text ?? stripCapabilityPrefix(card.title);
  // A published post asks how it did (live numbers, the owner's verdict);
  // post-result.tsx renders nothing until it has read the post.
  const result =
    host?.projectId &&
    (status === "PUBLISHED" || card.publishLine?.kind === "published") ? (
      <PostResult
        key={card.creativeId}
        projectId={host.projectId}
        creativeId={card.creativeId}
      />
    ) : null;
  const hasVariants = (card.alternatives?.length ?? 0) > 0;

  // The feed's action row: learn + revise on the left, where it goes on the right.
  const actionRow = (className: string) => (
    <div className={cn("flex flex-wrap items-center gap-0.5", className)}>
      {RATED_STATUSES.has(status) ? (
        <CreativeRating creativeId={card.creativeId} inline />
      ) : null}
      <button
        type="button"
        aria-label={SOCIAL_POST_COPY.revise}
        title={SOCIAL_POST_COPY.revise}
        aria-pressed={showRevise}
        onClick={() => setShowRevise((v) => !v)}
        className={cn(
          ICON_BUTTON,
          "rounded-lg",
          showRevise && "bg-[var(--ws-hover)]",
        )}
        style={{ color: "var(--ws-text-2)" }}
      >
        <PenLine aria-hidden className="size-4" />
      </button>
      <span className="ml-auto flex items-center gap-0.5">
        {channel && own && channel !== "facebook" ? (
          <DestinationIcon
            channel={channel}
            state={own}
            label={ownLabel(channel, own)}
            href={own === "off" ? connectHref : undefined}
          />
        ) : null}
        {showFacebook ? (
          <DestinationIcon
            channel="facebook"
            state={facebookIconState(facebookKind)}
            label={facebookLabel(facebookKind)}
            pressed={facebookOpen}
            onClick={() => setFacebookOpen((v) => !v)}
          />
        ) : channel === "facebook" ? (
          <DestinationIcon
            channel="facebook"
            state="off"
            label={SOCIAL_POST_COPY.connect("Facebook")}
            href={connectHref}
          />
        ) : null}
      </span>
    </div>
  );

  // Revise, approve, publish and share: each only while it applies.
  const controls = (
    <>
      {showRevise ? (
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
            placeholder={SOCIAL_POST_COPY.revisePlaceholder}
            aria-label={SOCIAL_POST_COPY.revise}
            disabled={revising}
            autoFocus
            className="min-h-9 min-w-0 flex-1 rounded-lg border bg-transparent px-2.5 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:text-xs"
            style={{
              borderColor: "var(--ws-border)",
              color: "var(--ws-text)",
            }}
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
            {SOCIAL_POST_COPY.reviseGo}
          </button>
        </form>
      ) : null}

      {canDecide ? (
        <button
          type="button"
          disabled={deciding || blocked !== null}
          title={blocked ?? undefined}
          onClick={() => decide("APPROVED")}
          className="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-xl text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          style={{
            background: "var(--ws-accent)",
            color: "var(--ws-on-accent)",
          }}
        >
          {deciding ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
          ) : (
            <Check aria-hidden className="size-3.5" />
          )}
          {approveLabel}
        </button>
      ) : null}

      {/* Facebook pieces go out through the Facebook icon, not a hand-off line. */}
      {channel !== "facebook" ? <CreativePublishLine card={card} /> : null}

      {showFacebook ? (
        <FacebookShareRow
          creativeId={card.creativeId}
          // A Facebook piece shows its row as soon as it can be shared; a
          // cross-post only when its icon is tapped.
          collapsed={!(facebookOpen || (channel === "facebook" && finished))}
          onState={setFacebookKind}
        />
      ) : null}

      {error ? (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );

  const details = (
    <OutputPreviewDialog
      creativeId={showDetails ? card.creativeId : null}
      onOpenChange={setShowDetails}
    />
  );

  if (variant === "single") {
    // In the chat the post lies on its side: a small picture on the left, the
    // account, caption and actions on the right, so a piece costs little
    // height. The picture keeps its own shape inside a THUMB box.
    const thumbWidth = thumbWidthOf(width, height);
    const thumb =
      isImage && card.assetId ? (
        <ImageLightbox
          src={assetUrl(card.assetId, "large")}
          alt={shownText}
          title={stripCapabilityPrefix(card.title)}
          className="block shrink-0 self-start overflow-hidden rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it */}
          <img
            src={assetUrl(card.assetId, "thumb")}
            alt={shownText}
            loading="lazy"
            decoding="async"
            style={{
              width: thumbWidth,
              aspectRatio: `${width} / ${height}`,
              background: "var(--ws-hover)",
            }}
            className="block object-cover"
          />
        </ImageLightbox>
      ) : !text ? (
        <div
          className="flex shrink-0 items-center justify-center self-start rounded-xl"
          style={{
            width: THUMB.width,
            aspectRatio: "4 / 5",
            background: "var(--ws-hover)",
            color: "var(--ws-text-3)",
          }}
        >
          <ImageIcon aria-hidden className="size-5" />
        </div>
      ) : null;

    return (
      <PostShell variant="single" creativeId={card.creativeId}>
        <div className="flex gap-3 p-3">
          {thumb}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <PostHeader
              name={handle}
              sub={sub}
              status={statusPill}
              menu={menu}
              compact
            />
            <Caption name={handle} text={shownText} compact />
            {result}
            {actionRow("-mr-1 -mb-1 -ml-2 mt-auto")}
          </div>
        </div>

        <div className="space-y-2 px-3 pb-3 empty:hidden">
          {/* Only while a picture can still be picked: after approval the
              card's own picture says it all. */}
          {status === "IN_REVIEW" && hasVariants ? (
            <CreativeVariantsStrip card={card} />
          ) : null}
          {controls}
        </div>

        {details}
      </PostShell>
    );
  }

  return (
    <PostShell variant={variant} creativeId={card.creativeId}>
      <PostHeader name={handle} sub={sub} status={statusPill} menu={menu} />

      {isImage && card.assetId ? (
        <ImageLightbox
          src={assetUrl(card.assetId, "large")}
          alt={shownText}
          title={stripCapabilityPrefix(card.title)}
          className="block"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it */}
          <img
            src={assetUrl(card.assetId, "card")}
            alt={shownText}
            loading="lazy"
            decoding="async"
            style={{
              aspectRatio: `${width} / ${height}`,
              background: "var(--ws-hover)",
            }}
            className="block w-full object-cover"
          />
        </ImageLightbox>
      ) : !text ? (
        <div
          className="flex aspect-[4/5] w-full items-center justify-center"
          style={{ background: "var(--ws-hover)", color: "var(--ws-text-3)" }}
        >
          <ImageIcon aria-hidden className="size-6" />
        </div>
      ) : null}

      {hasVariants ? (
        <div className="px-3">
          <CreativeVariantsStrip card={card} />
        </div>
      ) : null}

      {actionRow("px-1.5 pt-1")}

      {result ? <div className="px-3 pt-1">{result}</div> : null}

      {text ? (
        <div className="flex-1 pt-1">
          <Caption name={handle} text={text} />
        </div>
      ) : null}

      <div className="space-y-2 px-3 pt-2 pb-3">{controls}</div>

      {details}
    </PostShell>
  );
}

// ---- a planned piece that has no content yet --------------------------------

export function PlannedPostCard({
  name,
  channel,
  formatKey,
  date,
  time,
  topic,
  text,
  assetId,
  stage,
  progress,
  onOpen,
}: {
  name: string;
  channel?: ChannelKey;
  formatKey?: string;
  date: string;
  time: string;
  topic: string;
  text?: string;
  assetId?: string;
  stage: PlanItemStage | "PLANNED";
  // A picture being made right now by a run in this chat: its live progress.
  progress?: { imageGen?: ImageGenState; previewUrl?: string };
  onOpen?: () => void;
}) {
  const format =
    channel && formatKey ? resolveFormat(channel, formatKey) : undefined;
  const status = STAGE[stage] ??
    STATUS[stage] ?? { label: stage, tone: "neutral" as const };
  const ratio =
    format?.contentFormat === "STORY" || format?.contentFormat === "REEL"
      ? "9 / 16"
      : "3 / 4";
  const sub = [
    channel ? CHANNELS[channel].label : undefined,
    format?.label,
    slotWhenLabel(date, time),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <PostShell variant="slide">
      <PostHeader name={name} sub={sub} status={status} />
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        className="relative block w-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        style={{ aspectRatio: ratio, background: "var(--ws-hover)" }}
      >
        {assetId ? (
          // eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>
          <img
            src={assetUrl(assetId, "card")}
            alt={topic}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full object-cover"
          />
        ) : stage === "PRODUCING" && progress?.imageGen ? (
          <CreatingImage
            state={progress.imageGen}
            previewUrl={progress.previewUrl}
          />
        ) : (
          <span
            className={cn(
              "absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center",
              stage === "PRODUCING" && "animate-pulse",
            )}
            style={{ color: "var(--ws-text-3)" }}
          >
            {stage === "PRODUCING" ? (
              <Loader2 aria-hidden className="size-5 animate-spin" />
            ) : stage === "FAILED" ? (
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
      <div className="flex items-center px-1.5 pt-1">
        <span className="ml-auto flex items-center">
          {channel ? (
            <DestinationIcon
              channel={channel}
              state="idle"
              label={SOCIAL_POST_COPY.goesTo(CHANNELS[channel].label)}
            />
          ) : null}
        </span>
      </div>
      <div className="flex-1 pt-1 pb-3">
        <Caption name={name} text={text ?? topic} />
      </div>
    </PostShell>
  );
}

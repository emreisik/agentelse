"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowUpRight,
  CalendarPlus,
  Check,
  Clock,
  ImageIcon,
  Loader2,
  PenLine,
  Send,
  Share2,
} from "lucide-react";

import { stripCapabilityPrefix } from "@/lib/labels/core";
import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import { ImageLightbox } from "@/components/shared/image-lightbox";
import { WsTag } from "@/components/commands/ws-event-card";
import { OutputPreviewDialog } from "@/components/workspace/output-preview-dialog";
import { CREATIVE_STATUS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useWorkCardHost } from "@/components/works/work-card-host";
import { Input } from "@/components/ui/input";
import { FacebookShareRow } from "@/components/integrations/facebook-share-row";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";
import { reviseCreativeAction } from "@/server/actions/creative-actions";
import {
  getCreativePublishTargetsAction,
  publishCreativeToInstagramAction,
  publishCreativeToSocialAction,
} from "@/server/actions/publish-actions";
import type { PublishTarget } from "@/server/integrations/meta-connection-status";
import type { CreativeCardData } from "@/types/creative-card";

// Visual representation of a creative/image generation event in the chat —
// the same logic as ChatGPT's "loading" → result card transition while
// generating images. When AssistantMessage in thread.tsx finds this in the
// message's metadata.custom.card field, it shows this card INSTEAD OF the
// normal text/part render (see isCreativeCardData).
export function CreativeCard({ card }: { card: CreativeCardData }) {
  if (card.kind === "creative-loading") {
    return (
      <div
        className="mt-1 w-full max-w-sm overflow-hidden rounded-2xl border"
        style={{
          borderColor: "var(--ws-border)",
          background: "var(--ws-surface)",
          boxShadow: "var(--ws-card-shadow)",
        }}
      >
        <div
          className="relative aspect-square w-full overflow-hidden"
          style={{ background: "var(--ws-hover)" }}
        >
          <div
            className="absolute inset-0 animate-pulse"
            style={{
              background:
                "linear-gradient(135deg, var(--ws-hover), var(--ws-surface-2), var(--ws-hover))",
            }}
          />
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2"
            style={{ color: "var(--ws-text-3)" }}
          >
            <Loader2 className="size-5 animate-spin" />
            <span className="text-xs font-medium">Generating image…</span>
          </div>
        </div>
        <div className="px-3.5 py-2.5">
          <p
            className="truncate text-sm font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            {stripCapabilityPrefix(card.title)}
          </p>
        </div>
      </div>
    );
  }

  if (card.kind === "creative-failed") {
    return (
      <div
        className="mt-1 flex w-full max-w-sm items-start gap-3 rounded-2xl border px-4 py-3.5"
        style={{
          borderColor:
            "color-mix(in oklch, var(--destructive) 25%, transparent)",
          background: "color-mix(in oklch, var(--destructive) 6%, transparent)",
          boxShadow: "var(--ws-card-shadow)",
        }}
      >
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-full"
          style={{
            background:
              "color-mix(in oklch, var(--destructive) 12%, transparent)",
            color: "var(--destructive)",
          }}
        >
          <AlertCircle className="size-4" />
        </span>
        <div className="min-w-0">
          <p
            className="truncate text-sm font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            Image generation failed
          </p>
          <p className="truncate text-xs" style={{ color: "var(--ws-text-3)" }}>
            {stripCapabilityPrefix(card.title)}
          </p>
          {card.message ? (
            <p className="mt-1 text-xs" style={{ color: "var(--destructive)" }}>
              {card.message}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  if (card.kind === "publish-prompt") {
    return (
      <div
        className="mt-1 w-full max-w-sm space-y-2 rounded-2xl border p-3.5"
        style={{
          borderColor: "var(--ws-border)",
          background: "var(--ws-surface)",
          boxShadow: "var(--ws-card-shadow)",
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-lg"
            style={{ background: "var(--ws-hover)" }}
          >
            <Share2 className="size-3.5" style={{ color: "var(--ws-text)" }} />
          </span>
          <p
            className="text-sm font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            {stripCapabilityPrefix(card.title)} approved — would you like to
            share it on social media?
          </p>
        </div>
        <PublishSection creativeId={card.creativeId} />
      </div>
    );
  }

  return <CreativeReadyCard card={card} />;
}

// Separate component for the "creative-ready" card — a hook is only
// needed in this branch (approval state/transition), split out to keep
// the loading/failed branches simple without breaking hook rules.
function CreativeReadyCard({
  card,
}: {
  card: Extract<CreativeCardData, { kind: "creative-ready" }>;
}) {
  const router = useRouter();
  // Null outside a Work: every Works change below is gated on it.
  const host = useWorkCardHost();
  const touch = host ? "min-h-11 rounded-lg" : undefined;
  // The Work's publish line (below this card) owns publishing: this card's
  // own publish surfaces would be a second one.
  const lineOwnsPublish =
    host !== null && "publishLine" in card && card.publishLine != null;
  const [isPending, startTransition] = useTransition();
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [showRevise, setShowRevise] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [isRevising, startRevising] = useTransition();
  const [showPreview, setShowPreview] = useState(false);

  const revise = () => {
    if (!instruction.trim()) return;
    setError(undefined);
    startRevising(async () => {
      try {
        const result = await reviseCreativeAction(card.creativeId, instruction);
        if (result.ok) {
          setInstruction("");
          setShowRevise(false);
          toast.success("Revising — the new version will appear below");
          router.refresh();
        } else {
          setError(result.message);
          toast.error(result.message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Action failed";
        setError(message);
        toast.error(message);
      }
    });
  };

  const src = card.assetId ? `/api/assets/${card.assetId}` : undefined;
  const isImage = card.mimeType?.startsWith("image/") ?? Boolean(src);
  const status = localStatus ?? card.status;
  const canDecide = status === "IN_REVIEW" && Boolean(card.approvalId);
  const title = stripCapabilityPrefix(card.title);
  const format = getCreativePlatformFormat(card.platform, card.contentFormat);
  // Real measured size wins over the target format's nominal size — the
  // sharp normalize step in creative-image.ts is meant to make these equal,
  // but the note should show what the file actually is, not what was asked
  // for.
  const displayWidth = card.assetWidth ?? format.pixelSize.width;
  const displayHeight = card.assetHeight ?? format.pixelSize.height;

  const decide = (to: "APPROVED" | "REJECTED") => {
    if (!card.approvalId) return;
    setError(undefined);
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set("approvalId", card.approvalId!);
        const action =
          to === "APPROVED" ? approveApprovalAction : rejectApprovalAction;
        const result = await action(formData);
        if (result.ok) {
          setLocalStatus(to);
          toast.success(
            to === "REJECTED"
              ? "Rejected"
              : card.approveIntent === "calendar"
                ? "Added to the next calendar slot"
                : card.approveIntent === "publish"
                  ? "Approved — publishing now"
                  : card.approveIntent === "planned"
                    ? "Approved — it goes out at its planned time"
                    : "Approved",
          );
          router.refresh();
        } else {
          setError(result.message);
          toast.error(result.message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Action failed";
        setError(message);
        toast.error(message);
      }
    });
  };

  const statusLabel =
    CREATIVE_STATUS[status as keyof typeof CREATIVE_STATUS]?.label ?? status;
  const statusDot =
    status === "APPROVED" || status === "PUBLISHED"
      ? "var(--ws-approved)"
      : status === "IN_REVIEW"
        ? "var(--ws-pending)"
        : status === "REJECTED"
          ? "var(--destructive)"
          : "var(--ws-text-3)";
  const typeLabel = card.platform
    ? `${format.label} ${format.contentFormatLabel}`
    : "Image";
  const displayTitle = card.caption || title;

  return (
    <div
      // The "next step" bar scrolls to a piece waiting for review by this id.
      data-creative-id={card.creativeId}
      className="mt-1 w-full max-w-2xl overflow-hidden rounded-2xl border transition-shadow"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
        boxShadow: "var(--ws-card-shadow)",
      }}
    >
      <div className="grid sm:grid-cols-[39%_61%]">
        <div
          className="relative w-full overflow-hidden"
          style={{ background: "var(--ws-accent)" }}
        >
          {src && isImage ? (
            <ImageLightbox
              src={src}
              alt={displayTitle}
              title={title}
              className="block h-full"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it */}
              <img
                src={src}
                alt={displayTitle}
                style={{ aspectRatio: `${displayWidth} / ${displayHeight}` }}
                className="w-full object-cover"
              />
            </ImageLightbox>
          ) : (
            <div
              className="flex aspect-[4/5] w-full items-center justify-center"
              style={{ color: "var(--ws-on-accent)", opacity: 0.6 }}
            >
              <ImageIcon className="size-6" />
            </div>
          )}
        </div>

        <div className="flex flex-col p-4">
          <div className="flex items-center justify-between gap-2">
            <span
              className="flex items-center gap-1.5 text-xs"
              style={{ color: "var(--ws-text-2)" }}
            >
              <ImageIcon className="size-3.5" />
              {typeLabel}
            </span>
            {card.versionNumber ? (
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  background: "var(--ws-surface-2)",
                  color: "var(--ws-text-2)",
                }}
              >
                v{card.versionNumber}
              </span>
            ) : null}
          </div>

          <p
            className="mt-2 text-lg leading-tight font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {displayTitle}
          </p>

          {card.copy ? (
            <p
              className="mt-1.5 text-sm leading-snug"
              style={{
                color: "var(--ws-text-2)",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {card.copy}
            </p>
          ) : null}

          {card.assetWidth && card.assetHeight ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <WsTag>
                {card.assetWidth} × {card.assetHeight}
              </WsTag>
              {card.platform ? <WsTag>{format.aspectRatio}</WsTag> : null}
            </div>
          ) : null}

          <div
            className="mt-3 flex items-center gap-1.5 text-xs"
            style={{ color: "var(--ws-text-2)" }}
          >
            <span
              className="size-1.5 rounded-full"
              style={{ background: statusDot }}
            />
            {statusLabel}
          </div>

          {error ? (
            <p className="mt-2 text-xs" style={{ color: "var(--destructive)" }}>
              {error}
            </p>
          ) : null}

          {canDecide ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={isPending}
                className={cn("rounded-[10px]", touch)}
                style={{
                  background: "var(--ws-accent)",
                  color: "var(--ws-on-accent)",
                }}
                onClick={() => decide("APPROVED")}
              >
                {card.approveIntent === "calendar" ? (
                  <CalendarPlus className="size-3.5" />
                ) : card.approveIntent === "publish" ? (
                  <Send className="size-3.5" />
                ) : (
                  <Check className="size-3.5" />
                )}
                {card.approveIntent === "calendar"
                  ? "Add to calendar"
                  : card.approveIntent === "publish"
                    ? "Approve & publish"
                    : "Approve"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn("rounded-[10px]", touch)}
                style={{
                  borderColor: "var(--ws-border)",
                  color: "var(--ws-text)",
                }}
                disabled={isPending}
                onClick={() => setShowRevise((v) => !v)}
              >
                <PenLine className="size-3.5" />
                Revise
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn("rounded-[10px]", touch, host && "ml-auto")}
                style={{ color: "var(--ws-text-3)" }}
                disabled={isPending}
                onClick={() => decide("REJECTED")}
              >
                Reject
              </Button>
            </div>
          ) : status !== "IN_REVIEW" ? (
            // Not currently awaiting a decision (e.g. REJECTED, APPROVED,
            // PUBLISHED) — still revisable, without exposing Approve/Reject
            // for a decision that no longer applies to whatever's shown here.
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn("mt-4 w-fit rounded-[10px]", touch)}
              style={{
                borderColor: "var(--ws-border)",
                color: "var(--ws-text)",
              }}
              disabled={isRevising}
              onClick={() => setShowRevise((v) => !v)}
            >
              <PenLine className="size-3.5" />
              Revise
            </Button>
          ) : null}

          {showRevise ? (
            <div className="mt-2 flex gap-1.5">
              <Input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="What should change? e.g. more vibrant colors"
                disabled={isRevising}
                className="h-8 text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    revise();
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                className="h-8 shrink-0 rounded-[10px]"
                style={{
                  background: "var(--ws-accent)",
                  color: "var(--ws-on-accent)",
                }}
                disabled={isRevising || !instruction.trim()}
                onClick={revise}
              >
                {isRevising ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  "Go"
                )}
              </Button>
            </div>
          ) : null}

          {card.publishState && !lineOwnsPublish ? (
            <div
              className="mt-3 flex items-center gap-1.5 text-xs"
              style={{
                color:
                  card.publishState === "failed"
                    ? "var(--destructive)"
                    : "var(--ws-text-2)",
              }}
            >
              {card.publishState === "queued" ? (
                <>
                  <Clock className="size-3.5" />
                  Queued to publish
                </>
              ) : card.publishState === "publishing" ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Publishing…
                </>
              ) : card.publishState === "published" ? (
                <>
                  <Check className="size-3.5" />
                  Published
                </>
              ) : (
                <>
                  <AlertCircle className="size-3.5" />
                  Failed to publish
                  {card.publishError ? ` — ${card.publishError}` : ""}
                </>
              )}
            </div>
          ) : null}

          {status === "APPROVED" &&
          !lineOwnsPublish &&
          (!card.publishState || card.publishState === "failed") ? (
            <div className="mt-3">
              <PublishSection creativeId={card.creativeId} />
            </div>
          ) : null}
        </div>
      </div>

      <div
        className="flex items-center justify-between border-t px-4 py-2.5 text-[11px]"
        style={{
          borderColor: "var(--ws-border)",
          background: "var(--ws-bg)",
          color: "var(--ws-text-3)",
        }}
      >
        <span className="flex items-center gap-1">
          <Check className="size-3" />
          On-brand
        </span>
        <button
          type="button"
          onClick={() => setShowPreview(true)}
          className="flex items-center gap-1 font-medium transition-colors hover:opacity-70"
        >
          View details
          <ArrowUpRight className="size-3" />
        </button>
      </div>
      <OutputPreviewDialog
        creativeId={showPreview ? card.creativeId : null}
        onOpenChange={setShowPreview}
      />
    </div>
  );
}

// The next step after an approved creative: showing which connected social
// accounts it can be sent to. Replaces the old hidden "quick actions" menu
// in the composer — the card only knows creativeId, and just like
// approveApprovalAction working self-contained from approvalId,
// projectId/ideaId are resolved here server-side from creativeId.
type PublishFormat = "FEED" | "STORIES";
const FORMAT_LABEL: Record<PublishFormat, string> = {
  FEED: "Post",
  STORIES: "Story",
};
const PLATFORM_LABEL: Record<"tiktok" | "linkedin" | "x", string> = {
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  x: "X",
};

function PublishSection({ creativeId }: { creativeId: string }) {
  const router = useRouter();
  const [targets, setTargets] = useState<PublishTarget[] | null>(null);
  const [publishedKeys, setPublishedKeys] = useState<Set<string>>(new Set());
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCreativePublishTargetsAction(creativeId).then((result) => {
      if (!cancelled) setTargets(result);
    });
    return () => {
      cancelled = true;
    };
  }, [creativeId]);

  if (targets === null) return null;

  // Facebook is a cross-post with a row of its own (share, then edit or delete
  // the live post), not one of the one-click Share targets below.
  const hasFacebook = targets.some((t) => t.platform === "facebook");
  const shareTargets = targets.filter(
    (t): t is Exclude<PublishTarget, { platform: "facebook" }> =>
      t.platform !== "facebook",
  );

  if (shareTargets.length === 0 && !hasFacebook) {
    return (
      <p className="pt-0.5 text-xs" style={{ color: "var(--ws-text-3)" }}>
        No connected social accounts yet.
      </p>
    );
  }
  // Facebook alone: its row brings its own label and may render nothing, so
  // no bordered section around it.
  if (shareTargets.length === 0) {
    return <FacebookShareRow creativeId={creativeId} className="mt-1" />;
  }

  // Instagram carries a FEED/STORIES choice; TikTok/LinkedIn/X don't have a
  // format concept, so they get a single "Share" button and a key that's
  // just the platform name (there's at most one connected account per
  // platform — see getSimpleCredentialTarget in meta-connection-status.ts).
  const publishInstagram = (
    target: Extract<PublishTarget, { platform: "instagram" }>,
    format: PublishFormat,
  ) => {
    const key = `${target.pageId}:${format}`;
    setPendingKey(key);
    publishCreativeToInstagramAction(creativeId, format)
      .then((result) => {
        if (result.ok) {
          toast.success(result.message);
          setPublishedKeys((prev) => new Set(prev).add(key));
          router.refresh();
        } else {
          toast.error(result.message);
        }
      })
      .finally(() => setPendingKey(null));
  };

  const publishSocial = (platform: "tiktok" | "linkedin" | "x") => {
    setPendingKey(platform);
    publishCreativeToSocialAction(creativeId, platform)
      .then((result) => {
        if (result.ok) {
          toast.success(result.message);
          setPublishedKeys((prev) => new Set(prev).add(platform));
          router.refresh();
        } else {
          toast.error(result.message);
        }
      })
      .finally(() => setPendingKey(null));
  };

  return (
    <div
      className="space-y-1.5 border-t pt-2.5"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <p className="text-xs font-medium" style={{ color: "var(--ws-text-3)" }}>
        Share on Social Accounts
      </p>
      {shareTargets.map((target) => {
        const rowKey =
          target.platform === "instagram" ? target.pageId : target.platform;
        const title =
          target.platform === "instagram"
            ? target.pageName
            : PLATFORM_LABEL[target.platform];
        const subtitle =
          target.platform === "instagram"
            ? target.igUsername
              ? `@${target.igUsername}`
              : undefined
            : target.accountLabel;

        return (
          <div
            key={rowKey}
            className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5"
            style={{ background: "var(--ws-hover)" }}
          >
            <div className="min-w-0">
              <p
                className="truncate text-xs font-medium"
                style={{ color: "var(--ws-text)" }}
              >
                {title}
              </p>
              {subtitle ? (
                <p
                  className="truncate text-[11px]"
                  style={{ color: "var(--ws-text-3)" }}
                >
                  {subtitle}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-1">
              {target.platform === "instagram" ? (
                (["FEED", "STORIES"] as const).map((format) => {
                  const key = `${target.pageId}:${format}`;
                  const isPublished = publishedKeys.has(key);
                  const isPending = pendingKey === key;
                  return (
                    <Button
                      key={format}
                      type="button"
                      variant={isPublished ? "ghost" : "outline"}
                      size="sm"
                      className="h-7 rounded-full px-2 text-xs"
                      disabled={isPending || isPublished}
                      onClick={() => publishInstagram(target, format)}
                    >
                      {isPublished ? (
                        <Check className="size-3.5" />
                      ) : isPending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Share2 className="size-3.5" />
                      )}
                      {isPublished ? "Sent" : FORMAT_LABEL[format]}
                    </Button>
                  );
                })
              ) : (
                <Button
                  type="button"
                  variant={
                    publishedKeys.has(target.platform) ? "ghost" : "outline"
                  }
                  size="sm"
                  className="h-7 rounded-full px-2 text-xs"
                  disabled={
                    pendingKey === target.platform ||
                    publishedKeys.has(target.platform)
                  }
                  onClick={() => publishSocial(target.platform)}
                >
                  {publishedKeys.has(target.platform) ? (
                    <Check className="size-3.5" />
                  ) : pendingKey === target.platform ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Share2 className="size-3.5" />
                  )}
                  {publishedKeys.has(target.platform) ? "Sent" : "Share"}
                </Button>
              )}
            </div>
          </div>
        );
      })}
      {hasFacebook ? <FacebookShareRow creativeId={creativeId} /> : null}
    </div>
  );
}

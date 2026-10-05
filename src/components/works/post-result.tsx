"use client";

import { useEffect, useState, useTransition } from "react";
import {
  ArrowUpRight,
  Heart,
  MessageCircle,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import type {
  PostResultItem,
  PostResultsResponse,
  PostVerdict,
  RecentComparison,
} from "@/lib/post-results";
import { recordPostVerdictAction } from "@/server/actions/post-result-actions";

// Under a published post: how it did and what the brand should learn from it.
// The likes and comments are read live when this shows (Instagram, never
// stored); the owner's "Worked" / "Didn't work" is what the brand learns: a
// lesson in Brand Memory and, for a post built from a pool idea, that idea
// marked learned. Daily ideas and plans use those lessons.

export const POST_RESULT_COPY = {
  ask: "How did it do?",
  worked: "Worked",
  didnt: "Didn't work",
  learnedWorked: "Noted: more posts like this.",
  learnedDidnt: "Noted: fewer posts like this.",
  likes: "likes",
  comments: "comments",
  above: "Above your recent posts",
  about: "Like your recent posts",
  below: "Below your recent posts",
  view: "View post",
  failed: "That didn't work. Try again.",
} as const;

const COMPARISON_LABEL: Record<RecentComparison, string> = {
  above: POST_RESULT_COPY.above,
  about: POST_RESULT_COPY.about,
  below: POST_RESULT_COPY.below,
};

function formatCount(value: number | null): string {
  if (value === null) return "–";
  return new Intl.NumberFormat("en", { notation: "compact" }).format(value);
}

// The numbers and the verdict buttons for one post (no fetching: the card and
// the dialog hand it the post they read).
export function PostResultView({
  item,
  onVerdict,
  pending = false,
  className,
}: {
  item: Pick<PostResultItem, "stats" | "verdict">;
  onVerdict: (verdict: PostVerdict) => void;
  pending?: boolean;
  className?: string;
}) {
  const COPY = POST_RESULT_COPY;
  const stats = item.stats;
  const verdict = item.verdict;
  return (
    <div
      data-post-result
      className={cn("flex flex-col gap-1.5 text-xs", className)}
      style={{ color: "var(--ws-text-2)" }}
    >
      {stats ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Heart aria-hidden className="size-3.5" />
            {formatCount(stats.likes)}
            <span className="sr-only">{COPY.likes}</span>
          </span>
          <span className="inline-flex items-center gap-1 tabular-nums">
            <MessageCircle aria-hidden className="size-3.5" />
            {formatCount(stats.comments)}
            <span className="sr-only">{COPY.comments}</span>
          </span>
          {stats.comparison ? (
            <span
              data-comparison={stats.comparison}
              style={{
                color:
                  stats.comparison === "above"
                    ? "var(--ws-approved)"
                    : "var(--ws-text-2)",
              }}
            >
              {COMPARISON_LABEL[stats.comparison]}
            </span>
          ) : null}
          {stats.permalink ? (
            <a
              href={stats.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-0.5 hover:underline"
              style={{ color: "var(--ws-text-2)" }}
            >
              {COPY.view}
              <ArrowUpRight aria-hidden className="size-3" />
            </a>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <span>
          {verdict === "WORKED"
            ? COPY.learnedWorked
            : verdict === "DIDNT"
              ? COPY.learnedDidnt
              : COPY.ask}
        </span>
        <span className="ml-auto inline-flex gap-1">
          {(["WORKED", "DIDNT"] as const).map((value) => {
            const Icon = value === "WORKED" ? ThumbsUp : ThumbsDown;
            const label = value === "WORKED" ? COPY.worked : COPY.didnt;
            return (
              <button
                key={value}
                type="button"
                disabled={pending}
                aria-pressed={verdict === value}
                onClick={() => onVerdict(value)}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 transition-colors disabled:opacity-60",
                  verdict === value
                    ? "bg-[var(--ws-hover)]"
                    : "hover:bg-[var(--ws-hover)]",
                )}
                style={{
                  borderColor: "var(--ws-border)",
                  color: "var(--ws-text)",
                }}
              >
                <Icon aria-hidden className="size-3.5" />
                {label}
              </button>
            );
          })}
        </span>
      </div>
    </div>
  );
}

// Records a verdict and keeps the shown one in step: the owner's latest tap
// shows at once (rolled back when the server says no), else what was read.
// `onTap` runs on the tap itself (the dialog notes that the page must refresh
// when it closes, even if the request is still on its way); `onRecorded` runs
// after the server took it (the card refreshes the page so the bar's count
// follows).
export function usePostVerdict(
  creativeId: string,
  initial: PostVerdict | null,
  callbacks: { onTap?: () => void; onRecorded?: () => void } = {},
) {
  const [tapped, setTapped] = useState<PostVerdict | null | undefined>(
    undefined,
  );
  const [pending, startTransition] = useTransition();
  const verdict = tapped === undefined ? initial : tapped;
  const mark = (next: PostVerdict) => {
    const before = tapped;
    setTapped(next);
    callbacks.onTap?.();
    startTransition(async () => {
      const result = await recordPostVerdictAction({
        creativeId,
        verdict: next,
      }).catch(() => null);
      if (!result?.ok) {
        setTapped(before);
        toast.error(
          result?.ok === false ? result.message : POST_RESULT_COPY.failed,
        );
        return;
      }
      callbacks.onRecorded?.();
    });
  };
  return { verdict, pending, mark };
}

// The card's block: reads this one post when it shows. Nothing renders until
// the read answers, and nothing at all for a post that is not published.
export function PostResult({
  projectId,
  creativeId,
  className,
}: {
  projectId: string;
  creativeId: string;
  className?: string;
}) {
  const router = useRouter();
  const [item, setItem] = useState<PostResultItem | null>(null);
  const { verdict, pending, mark } = usePostVerdict(
    creativeId,
    item?.verdict ?? null,
    { onRecorded: () => router.refresh() },
  );

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/post-results?creativeId=${encodeURIComponent(creativeId)}`,
          { signal: controller.signal },
        );
        if (!res.ok) return;
        const body = (await res.json()) as PostResultsResponse;
        setItem(body.items[0] ?? null);
      } catch {
        // A failed read shows nothing: the card stays as it was.
      }
    })();
    return () => controller.abort();
  }, [projectId, creativeId]);

  if (!item) return null;
  return (
    <PostResultView
      item={{ stats: item.stats, verdict }}
      pending={pending}
      onVerdict={mark}
      className={className}
    />
  );
}

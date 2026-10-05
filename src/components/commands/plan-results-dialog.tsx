"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PostResultView, usePostVerdict } from "@/components/works/post-result";
import { assetUrl } from "@/lib/asset-url";
import type { JourneyResult } from "@/lib/journey";
import type { PostResultItem, PostResultsResponse } from "@/lib/post-results";
import { getPlanResultsAction } from "@/server/actions/plan-progress-actions";

// "See results": the posts that went out in the last 30 days, each with its live
// numbers (Instagram, read now and not stored) and the owner's verdict, which is
// what the brand learns ("Worked" / "Didn't work"). Below them, anything the old
// measurement loop reported, as it reported it: nothing there is computed.

export const PLAN_RESULTS_COPY = {
  title: "Results",
  description:
    "How your published posts did. Mark what worked: daily ideas and plans learn from it.",
  empty: "No published posts in the last 30 days.",
  noNumbers:
    "Live numbers are not available right now; you can still mark how each post did.",
  reported: "Reported by measurement",
  planNext: "Plan the next weeks",
  failed: "Could not load the results.",
} as const;

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

export function PlanResultsList({
  results,
}: {
  results: readonly JourneyResult[];
}) {
  if (results.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
        No results yet. They appear a day or more after a piece goes out.
      </p>
    );
  }
  return (
    <ul className="space-y-2.5">
      {results.map((result, index) => (
        <li
          key={`${result.creativeId}-${index}`}
          className="space-y-1 rounded-xl border p-3"
          style={{ borderColor: "var(--ws-border)" }}
        >
          <p
            className="truncate text-sm font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            {result.title}
          </p>
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {result.where} · {result.check} · {formatDay(result.checkedAt)}
          </p>
          <p
            className="text-xs leading-relaxed whitespace-pre-line"
            style={{ color: "var(--ws-text)" }}
          >
            {result.observation}
          </p>
        </li>
      ))}
    </ul>
  );
}

// One published post: picture, title, where and when, then its numbers and the
// verdict buttons.
export function PostResultRow({
  item,
  onTap,
}: {
  item: PostResultItem;
  onTap?: () => void;
}) {
  const { verdict, pending, mark } = usePostVerdict(
    item.creativeId,
    item.verdict,
    { onTap },
  );
  const where = item.formatKey ?? item.channel;
  return (
    <li
      data-post={item.creativeId}
      className="flex gap-3 rounded-xl border p-3"
      style={{ borderColor: "var(--ws-border)" }}
    >
      {item.assetId ? (
        // eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it
        <img
          src={assetUrl(item.assetId, "thumb")}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-14 shrink-0 rounded-lg object-cover"
          style={{ background: "var(--ws-hover)" }}
        />
      ) : null}
      <div className="min-w-0 flex-1 space-y-1.5">
        <div>
          <p
            className="truncate text-sm font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            {item.title}
          </p>
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {where ? `${where} · ` : ""}
            {formatDay(item.publishedAt)}
          </p>
        </div>
        <PostResultView
          item={{ stats: item.stats, verdict }}
          pending={pending}
          onVerdict={mark}
        />
      </div>
    </li>
  );
}

export function PlanResultsDialog({
  projectId,
  onClose,
  onPlanNext,
}: {
  projectId: string;
  onClose: () => void;
  onPlanNext: () => void;
}) {
  const COPY = PLAN_RESULTS_COPY;
  const router = useRouter();
  // A verdict was tapped: the page (the bar's count) is refreshed once the
  // dialog closes, not while it is open (that would remount it). A refresh
  // asked for while the verdict request is still running waits for it in the
  // router's queue, so the count it shows is the new one.
  const [changed, setChanged] = useState(false);
  const close = () => {
    onClose();
    if (changed) router.refresh();
  };
  const [posts, setPosts] = useState<PostResultsResponse | null>(null);
  const [reported, setReported] = useState<JourneyResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/post-results`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        setPosts((await res.json()) as PostResultsResponse);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(COPY.failed);
      });
    void getPlanResultsAction(projectId).then((result) => {
      if (!controller.signal.aborted && result.ok) setReported(result.results);
    });
    return () => controller.abort();
  }, [projectId, COPY.failed]);

  const showNoNumbers =
    posts !== null &&
    posts.items.length > 0 &&
    posts.statsNote !== null &&
    posts.statsNote !== "not_connected";

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{COPY.title}</DialogTitle>
          <DialogDescription>{COPY.description}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          {error ? (
            <p className="text-sm" style={{ color: "var(--destructive)" }}>
              {error}
            </p>
          ) : posts === null ? (
            <Loader2 className="mx-auto size-5 animate-spin" />
          ) : posts.items.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
              {COPY.empty}
            </p>
          ) : (
            <>
              {showNoNumbers ? (
                <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
                  {COPY.noNumbers}
                </p>
              ) : null}
              <ul className="space-y-2.5">
                {posts.items.map((item) => (
                  <PostResultRow
                    key={item.creativeId}
                    item={item}
                    onTap={() => setChanged(true)}
                  />
                ))}
              </ul>
            </>
          )}
          {reported.length > 0 ? (
            <section className="space-y-2">
              <h3
                className="text-xs font-medium"
                style={{ color: "var(--ws-text-2)" }}
              >
                {COPY.reported}
              </h3>
              <PlanResultsList results={reported} />
            </section>
          ) : null}
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              close();
              onPlanNext();
            }}
          >
            {COPY.planNext}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { useChatPackage } from "@/components/commands/chat-package-context";
import { useWorkspaceDetail } from "@/components/workspace/workspace-panel-toggle";
import { compactSpecOf } from "@/lib/works/compact-card";
import { readyPostCount, slidePostsOf } from "@/lib/works/plan-posts";
import { cn } from "@/lib/utils";
import type { IdeaEventCardData } from "@/types/idea-event-card";

import { PostSlide } from "./post-slide";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

export const PLAN_POSTS_COPY = {
  label: "Posts of this plan",
  ready: (ready: number, total: number) => `${ready} of ${total} ready`,
  previous: "Previous post",
  next: "Next post",
} as const;

const SLIDE_WIDTH = "w-[min(78vw,276px)]";

// Under the plan card in the chat: the saved plan's POSTS in its own order, one
// slide each, in one horizontal row (docs/works.md "Plan posts"). A post is one
// idea: its channels (Instagram post, Story, Facebook...) are tabs of its
// slide, never slides of their own, so a 3-post plan on three channels is
// three slides. "k of n ready" counts posts whose every channel left in has
// content.
export function PlanPostsCarousel({
  card,
  commandId,
}: {
  card: PlanCard;
  commandId?: string;
}) {
  const pane = useWorkspaceDetail();
  // Pieces being made right now by a run pressed in this chat.
  const live = useChatPackage()?.pieces;
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const posts = slidePostsOf(card, live);

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 4,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4,
    });
  }, []);

  useEffect(() => {
    measure();
    const el = track.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, posts.length]);

  if (posts.length === 0) return null;

  const ready = readyPostCount(posts);
  const planTitle = compactSpecOf(card)?.title ?? card.title;
  const openPlan =
    pane && commandId ? () => pane.openDetail(commandId, planTitle) : undefined;

  const step = (direction: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    const slide = el.querySelector<HTMLElement>("[data-plan-post]");
    const by = (slide?.offsetWidth ?? 276) + 12;
    el.scrollBy({ left: direction * by, behavior: "smooth" });
  };

  const arrow =
    "inline-flex size-8 items-center justify-center rounded-full border outline-none transition-colors hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <section
      aria-label={PLAN_POSTS_COPY.label}
      data-plan-posts
      className="mt-2 w-full max-w-3xl"
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {PLAN_POSTS_COPY.ready(ready, posts.length)}
        </p>
        {posts.length > 1 ? (
          <span className="ml-auto flex gap-1">
            <button
              type="button"
              aria-label={PLAN_POSTS_COPY.previous}
              disabled={edges.start}
              onClick={() => step(-1)}
              className={arrow}
              style={{
                borderColor: "var(--ws-border)",
                color: "var(--ws-text)",
              }}
            >
              <ChevronLeft aria-hidden className="size-4" />
            </button>
            <button
              type="button"
              aria-label={PLAN_POSTS_COPY.next}
              disabled={edges.end}
              onClick={() => step(1)}
              className={arrow}
              style={{
                borderColor: "var(--ws-border)",
                color: "var(--ws-text)",
              }}
            >
              <ChevronRight aria-hidden className="size-4" />
            </button>
          </span>
        ) : null}
      </div>
      <div
        ref={track}
        onScroll={measure}
        className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {posts.map((post) => (
          <div
            key={post.key}
            data-plan-post
            className={cn("shrink-0 snap-start", SLIDE_WIDTH)}
          >
            <PostSlide
              post={post}
              commandId={commandId}
              topic={post.deliveries[0]?.item.topic ?? planTitle}
              onOpenPlan={openPlan}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { useChatPackage } from "@/components/commands/chat-package-context";
import { useWorkCardHost } from "@/components/works/work-card-host";
import { useWorkspaceDetail } from "@/components/workspace/workspace-panel-toggle";
import { isChannelKey } from "@/lib/content-channels";
import { compactSpecOf } from "@/lib/works/compact-card";
import { cn } from "@/lib/utils";
import type { IdeaEventCardData } from "@/types/idea-event-card";

import { PlannedPostCard, SocialPostCard } from "./social-post-card";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

export const PLAN_POSTS_COPY = {
  label: "Posts of this plan",
  ready: (ready: number, total: number) => `${ready} of ${total} ready`,
  previous: "Previous post",
  next: "Next post",
} as const;

// A piece counts as "ready" once it has content (made, decided or out).
const READY_STAGES: ReadonlySet<string> = new Set([
  "IN_REVIEW",
  "APPROVED",
  "PUBLISHED",
]);

const SLIDE_WIDTH = "w-[min(78vw,276px)]";

// Under the plan card in the chat: every piece of the saved plan as a social
// post card, in the plan's own order, in one horizontal row (docs/works.md
// "Plan posts"). A made piece is its full card (approve, revise, publish,
// share); one still to make shows where it stands and opens the plan.
export function PlanPostsCarousel({
  card,
  commandId,
}: {
  card: PlanCard;
  commandId?: string;
}) {
  const host = useWorkCardHost();
  const pane = useWorkspaceDetail();
  // Pieces being made right now by a run pressed in this chat.
  const live = useChatPackage()?.pieces;
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const ids = card.state === "saved" ? (card.savedCreativeIds ?? []) : [];
  const posts = new Map(
    (card.posts ?? []).map((post) => [post.creativeId, post]),
  );
  const entries = card.items.flatMap((item, index) => {
    const id = ids[index];
    const slot = card.slots?.[index];
    if (!id || item.removed || slot === null) return [];
    const piece = live?.[id];
    // A piece that just finished shows its card at once; the saved one takes
    // over with the next page refresh.
    const made =
      piece?.state === "done" && piece.card?.kind === "creative-ready"
        ? piece.card
        : undefined;
    return [
      {
        id,
        item,
        slot,
        post: posts.get(id) ?? made,
        making: piece?.state === "pending" ? piece : undefined,
      },
    ];
  });

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
  }, [measure, entries.length]);

  if (entries.length === 0) return null;

  const ready = entries.filter((entry) =>
    READY_STAGES.has(entry.post?.status ?? entry.slot?.stage ?? ""),
  ).length;
  const name = host?.projectName ?? "Your brand";
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
          {PLAN_POSTS_COPY.ready(ready, entries.length)}
        </p>
        {entries.length > 1 ? (
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
        {entries.map(({ id, item, slot, post, making }) => (
          <div
            key={id}
            data-plan-post
            className={cn("shrink-0 snap-start", SLIDE_WIDTH)}
          >
            {post ? (
              <SocialPostCard card={post} variant="slide" />
            ) : (
              <PlannedPostCard
                name={
                  (isChannelKey(item.channel) &&
                    host?.accountLabels?.[item.channel]) ||
                  name
                }
                channel={isChannelKey(item.channel) ? item.channel : undefined}
                formatKey={item.formatKey}
                date={slot?.when?.slice(0, 10) ?? item.date}
                time={slot?.when?.slice(11, 16) ?? item.time}
                topic={item.topic}
                text={slot?.text}
                assetId={slot?.assetId}
                stage={making ? "PRODUCING" : (slot?.stage ?? "PLANNED")}
                progress={making}
                onOpen={openPlan}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

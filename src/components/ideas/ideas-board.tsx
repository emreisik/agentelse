"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  isSafeFontName,
  loadGoogleFont,
} from "@/components/brand/font-specimen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { timeAgo } from "@/lib/dates";
import {
  BOARD_STATUSES,
  DEFAULT_FILTERS,
  countByModule,
  countByStatus,
  filterIdeas,
  sortIdeas,
  type BoardFilters,
  type BoardIdea,
  type BoardSort,
} from "@/lib/ideas/board";
import { IDEA_SOURCES, type DismissReason } from "@/lib/ideas/concept";
import { ideaPlanHref } from "@/lib/idea-pool";
import { boostAdHref } from "@/lib/module-flows/ads/boost";
import { cn } from "@/lib/utils";
import {
  anotherAngleAction,
  archiveIdeaBoardAction,
  dismissIdeaAction,
  generateIdeasAction,
  makeIdeaPostAction,
  saveIdeaAction,
  turnIntoPostIdeaAction,
  updateIdeaDraftAction,
  type IdeaDraftPatch,
} from "@/server/actions/idea-board-actions";
import type { IdeaBoardData } from "@/server/ideas/idea-board";
import { IDEAS_COPY as COPY } from "./copy";
import {
  IdeaCardSkeleton,
  IdeaCardView,
  type IdeaCardContext,
  type IdeaCardHandlers,
} from "./idea-card";
import { IdeaDetailSheet } from "./idea-detail";

// The Ideas board (docs/ideas.md): the idea pool as the posts, articles and
// ads it can become, filtered and sorted in the browser, with every action on
// the card. Opening it tops a low pool up once (the server decides whether a
// run is due), so the pool fills even while the background worker is idle.

const SKELETONS = 3;
const MODULE_TABS = ["all", "social", "seo", "ads", "untyped"] as const;

type Busy = Record<string, string>;

function mergeIdeas(
  current: readonly BoardIdea[],
  incoming: readonly BoardIdea[],
): BoardIdea[] {
  const byId = new Map(current.map((idea) => [idea.id, idea]));
  for (const idea of incoming) byId.set(idea.id, idea);
  return [...byId.values()];
}

function Chip({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        !active && "hover:bg-[var(--ws-hover)]",
      )}
      style={
        active
          ? { background: "var(--ws-accent)", color: "var(--ws-on-accent)" }
          : { color: "var(--ws-text-2)" }
      }
    >
      {children}
      {count !== undefined ? (
        <span className="tabular-nums opacity-70">{count}</span>
      ) : null}
    </button>
  );
}

export function IdeasBoard({
  data,
  initialSelected,
}: {
  data: IdeaBoardData;
  initialSelected?: string | null;
}) {
  const router = useRouter();
  const { projectId } = data;
  const [ideas, setIdeas] = useState<BoardIdea[]>(data.ideas);
  const [filters, setFilters] = useState<BoardFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<BoardSort>("best");
  const [busy, setBusy] = useState<Busy>({});
  const [selected, setSelected] = useState<string | null>(
    initialSelected ?? null,
  );
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(new Set());
  // A low pool is topped up as soon as the board opens (effect below).
  const [generating, setGenerating] = useState<"manual" | "refill" | null>(
    data.health.due ? "refill" : null,
  );
  const [genOpen, setGenOpen] = useState(false);
  const [focus, setFocus] = useState("");
  const [count, setCount] = useState(6);
  const [genKind, setGenKind] = useState<"social" | "seo">("social");
  const [fontFamily, setFontFamily] = useState<string | undefined>(undefined);
  const [lastRunAt, setLastRunAt] = useState(data.health.lastRunAt);
  const refilled = useRef(false);
  const [now] = useState(() => new Date());

  // The server's newer list (after a revalidation) wins, ideas added here stay.
  const [serverIdeas, setServerIdeas] = useState(data.ideas);
  if (serverIdeas !== data.ideas) {
    setServerIdeas(data.ideas);
    setIdeas((current) => mergeIdeas(current, data.ideas));
  }

  // Idea cards are set in the brand's font, as the posts are.
  const brandFont = data.kit?.fonts[0];
  useEffect(() => {
    if (!brandFont || !isSafeFontName(brandFont)) return;
    let cancelled = false;
    void loadGoogleFont(brandFont).then((ok) => {
      if (!cancelled && ok)
        setFontFamily(`"${brandFont}", var(--font-sans), sans-serif`);
    });
    return () => {
      cancelled = true;
    };
  }, [brandFont]);

  function addIdeas(fresh: readonly BoardIdea[]) {
    if (fresh.length === 0) return;
    setIdeas((current) => mergeIdeas(current, fresh));
    setNewIds(
      (current) => new Set([...current, ...fresh.map((idea) => idea.id)]),
    );
  }

  // Top a low pool up once when the board opens (the server checks again
  // whether a run is due).
  const due = data.health.due;
  useEffect(() => {
    if (!due || refilled.current) return;
    refilled.current = true;
    void generateIdeasAction(projectId, { trigger: "refill" })
      .then((result) => {
        if (!result.ok || result.ideas.length === 0) return;
        setIdeas((current) => mergeIdeas(current, result.ideas));
        setNewIds(
          (current) => new Set([...current, ...result.ideas.map((idea) => idea.id)]),
        );
        setLastRunAt(new Date().toISOString());
      })
      .finally(() => setGenerating(null));
  }, [due, projectId]);

  function setBusyFor(id: string, what: string | null) {
    setBusy((current) => {
      const next = { ...current };
      if (what) next[id] = what;
      else delete next[id];
      return next;
    });
  }

  function patchIdea(id: string, patch: Partial<BoardIdea>) {
    setIdeas((current) =>
      current.map((idea) => (idea.id === id ? { ...idea, ...patch } : idea)),
    );
  }

  async function generate() {
    setGenOpen(false);
    setGenerating("manual");
    const kind = data.modules.seo ? genKind : "social";
    const result = await generateIdeasAction(projectId, {
      focus: focus.trim() || undefined,
      count,
      module: kind,
    });
    setGenerating(null);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    addIdeas(result.ideas);
    setLastRunAt(new Date().toISOString());
    setFilters((current) => ({
      ...current,
      status: "fresh",
      module:
        current.module === "all" || current.module === kind
          ? current.module
          : kind,
    }));
    setFocus("");
  }

  const byId = useMemo(
    () => new Map(ideas.map((idea) => [idea.id, idea])),
    [ideas],
  );

  const handlers: IdeaCardHandlers = {
    onOpen: (id) => setSelected(id),
    onMake: async (id) => {
      setBusyFor(id, "make");
      const result = await makeIdeaPostAction(projectId, id);
      if (!result.ok) {
        setBusyFor(id, null);
        toast.error(result.message);
        return;
      }
      router.push(
        `/projects/${projectId}?work=${encodeURIComponent(result.workId)}`,
      );
    },
    onSave: async (id, saved) => {
      const before = byId.get(id);
      if (!before) return;
      setBusyFor(id, "save");
      patchIdea(id, {
        status: saved
          ? "APPROVED"
          : before.concept
            ? "VALIDATED"
            : "SHORTLISTED",
      });
      const result = await saveIdeaAction(projectId, id, saved);
      setBusyFor(id, null);
      if (!result.ok) {
        patchIdea(id, { status: before.status });
        toast.error(result.message);
        return;
      }
      patchIdea(id, { status: result.status });
      toast.success(saved ? COPY.savedToast : COPY.unsavedToast);
    },
    onAngle: async (id) => {
      setBusyFor(id, "angle");
      const result = await anotherAngleAction(projectId, id);
      setBusyFor(id, null);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      addIdeas(result.ideas);
      toast.success(COPY.angleToast(result.ideas.length));
    },
    onDismiss: async (id: string, reason: DismissReason) => {
      const before = byId.get(id);
      if (!before) return;
      patchIdea(id, { status: "REJECTED" });
      const result = await dismissIdeaAction(projectId, id, reason);
      if (!result.ok) {
        patchIdea(id, { status: before.status });
        toast.error(result.message);
        return;
      }
      toast.success(COPY.dismissed);
    },
    onArchive: async (id) => {
      const before = byId.get(id);
      if (!before) return;
      patchIdea(id, { status: "ARCHIVED" });
      const result = await archiveIdeaBoardAction(projectId, id);
      if (!result.ok) {
        patchIdea(id, { status: before.status });
        toast.error(result.message);
        return;
      }
      toast.success(COPY.archived);
    },
    onConvert: async (id) => {
      setBusyFor(id, "convert");
      const result = await turnIntoPostIdeaAction(projectId, id);
      setBusyFor(id, null);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      patchIdea(id, { status: "ARCHIVED" });
      addIdeas(result.ideas);
      toast.success(COPY.converted);
    },
    onPlanInChat: (id) => router.push(ideaPlanHref(projectId, id)),
    onWriteArticle: (id) =>
      router.push(
        `/projects/${projectId}?module=seo&idea=${encodeURIComponent(id)}`,
      ),
    onBoost: (id) => {
      const concept = byId.get(id)?.concept;
      if (concept?.module === "ads")
        router.push(boostAdHref(projectId, concept.draft.creativeId));
    },
  };

  async function saveDraft(
    id: string,
    patch: IdeaDraftPatch,
  ): Promise<boolean> {
    const result = await updateIdeaDraftAction(projectId, id, patch);
    if (!result.ok) {
      toast.error(result.message);
      return false;
    }
    patchIdea(id, result.idea);
    toast.success(COPY.changesSaved);
    return true;
  }

  const ctx: IdeaCardContext = {
    kit: data.kit,
    brandName: data.brandName,
    handle: data.handle,
    fontFamily,
    timezone: data.timezone,
    now,
  };

  const statusCounts = countByStatus(ideas, now);
  const moduleCounts = countByModule(ideas);
  const shown = sortIdeas(filterIdeas(ideas, filters, now), sort);
  const freshNow = statusCounts.fresh + statusCounts.saved;
  const filtered =
    filters.module !== "all" ||
    filters.source !== "all" ||
    filters.channel !== "all" ||
    filters.query.trim() !== "";
  const selectedIdea = selected ? (byId.get(selected) ?? null) : null;
  const sourcesInUse = IDEA_SOURCES.filter((source) =>
    ideas.some((idea) => idea.concept?.source === source),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-3 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
              {COPY.subtitle(data.brandName)}
            </p>
            <p
              className="flex items-center gap-1.5 text-[12px]"
              style={{ color: "var(--ws-text-3)" }}
            >
              {generating === "refill" ? (
                <>
                  <Loader2 aria-hidden className="size-3 animate-spin" />
                  {COPY.toppingUp}
                </>
              ) : (
                <>
                  {COPY.health(freshNow)} ·{" "}
                  {lastRunAt
                    ? COPY.toppedUp(timeAgo(new Date(lastRunAt)))
                    : COPY.neverToppedUp}
                </>
              )}
            </p>
          </div>
          <Popover open={genOpen} onOpenChange={setGenOpen}>
            <PopoverTrigger render={<Button disabled={generating !== null} />}>
              {generating === "manual" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              {generating === "manual" ? COPY.generating : COPY.generate}
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void generate();
                }}
              >
                <p className="text-sm font-medium">{COPY.generateTitle}</p>
                {data.modules.seo && (
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="text-[12px]"
                      style={{ color: "var(--ws-text-2)" }}
                    >
                      {COPY.forLabel}
                    </span>
                    <span className="flex gap-1">
                      {(["social", "seo"] as const).map((kind) => (
                        <Chip
                          key={kind}
                          active={genKind === kind}
                          onClick={() => setGenKind(kind)}
                        >
                          {COPY.forKind[kind]}
                        </Chip>
                      ))}
                    </span>
                  </div>
                )}
                <label className="flex flex-col gap-1.5">
                  <span
                    className="text-[12px]"
                    style={{ color: "var(--ws-text-2)" }}
                  >
                    {COPY.aboutLabel}
                  </span>
                  <Textarea
                    value={focus}
                    onChange={(event) => setFocus(event.target.value)}
                    placeholder={COPY.aboutPlaceholder}
                    rows={2}
                    maxLength={300}
                  />
                </label>
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="text-[12px]"
                    style={{ color: "var(--ws-text-2)" }}
                  >
                    {COPY.howMany}
                  </span>
                  <span className="flex gap-1">
                    {[3, 6].map((n) => (
                      <Chip
                        key={n}
                        active={count === n}
                        onClick={() => setCount(n)}
                      >
                        {n}
                      </Chip>
                    ))}
                  </span>
                </div>
                <Button type="submit">{COPY.generateGo}</Button>
              </form>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            className="-mx-1 flex gap-1 overflow-x-auto px-1"
            role="group"
            aria-label={COPY.title}
          >
            {MODULE_TABS.filter(
              (tab) =>
                tab === "all" || tab === "social" || moduleCounts[tab] > 0,
            ).map((tab) => (
              <Chip
                key={tab}
                active={filters.module === tab}
                count={tab === "all" ? ideas.length : moduleCounts[tab]}
                onClick={() =>
                  setFilters((current) => ({ ...current, module: tab }))
                }
              >
                {COPY.modules[tab]}
              </Chip>
            ))}
          </div>
          <div
            className="-mx-1 flex gap-1 overflow-x-auto px-1"
            role="group"
            aria-label={COPY.sortLabel}
          >
            {BOARD_STATUSES.map((status) => (
              <Chip
                key={status}
                active={filters.status === status}
                count={statusCounts[status]}
                onClick={() =>
                  setFilters((current) => ({ ...current, status }))
                }
              >
                {COPY.status[status]}
              </Chip>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1 sm:max-w-[280px]">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
              style={{ color: "var(--ws-text-3)" }}
            />
            <Input
              value={filters.query}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  query: event.target.value,
                }))
              }
              placeholder={COPY.searchPlaceholder}
              aria-label={COPY.searchPlaceholder}
              className="h-8 pl-8 text-[13px]"
            />
          </div>
          <div className="-mx-1 flex gap-1 overflow-x-auto px-1">
            <Chip
              active={filters.source === "all"}
              onClick={() =>
                setFilters((current) => ({ ...current, source: "all" }))
              }
            >
              {COPY.sourceAll}
            </Chip>
            {sourcesInUse.map((source) => (
              <Chip
                key={source}
                active={filters.source === source}
                onClick={() =>
                  setFilters((current) => ({ ...current, source }))
                }
              >
                {COPY.source[source]}
              </Chip>
            ))}
          </div>
          {data.channels.length > 1 ? (
            <div className="-mx-1 flex gap-1 overflow-x-auto px-1">
              <Chip
                active={filters.channel === "all"}
                onClick={() =>
                  setFilters((current) => ({ ...current, channel: "all" }))
                }
              >
                {COPY.channelAll}
              </Chip>
              {data.channels.map((channel) => (
                <Chip
                  key={channel}
                  active={filters.channel === channel}
                  onClick={() =>
                    setFilters((current) => ({ ...current, channel }))
                  }
                >
                  {channel.charAt(0).toUpperCase() + channel.slice(1)}
                </Chip>
              ))}
            </div>
          ) : null}
          <div className="ml-auto flex gap-1">
            {(["best", "newest", "ending"] as const).map((key) => (
              <Chip
                key={key}
                active={sort === key}
                onClick={() => setSort(key)}
              >
                {COPY.sort[key]}
              </Chip>
            ))}
          </div>
        </div>
        {!data.kit?.hasIdentity ? (
          <p
            className="rounded-xl px-3 py-2 text-[12.5px]"
            style={{
              background: "var(--ws-surface-2)",
              color: "var(--ws-text-2)",
            }}
          >
            {COPY.noKit}
          </p>
        ) : null}
      </div>

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-6">
        {shown.length === 0 && generating === null ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p
              className="text-base font-semibold"
              style={{ color: "var(--ws-text)" }}
            >
              {COPY.emptyTitle}
            </p>
            <p
              className="max-w-sm text-sm"
              style={{ color: "var(--ws-text-2)" }}
            >
              {filtered ? COPY.emptyFiltered : COPY.emptyFresh}
            </p>
            {filtered ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFilters(DEFAULT_FILTERS)}
              >
                {COPY.clearFilters}
              </Button>
            ) : (
              <Button size="sm" onClick={() => setGenOpen(true)}>
                <Sparkles className="size-3.5" />
                {COPY.generate}
              </Button>
            )}
          </div>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
            {generating !== null
              ? Array.from({ length: SKELETONS }, (_, index) => (
                  <li key={`skeleton-${index}`}>
                    <IdeaCardSkeleton />
                  </li>
                ))
              : null}
            {shown.map((idea) => (
              <li key={idea.id}>
                <IdeaCardView
                  idea={idea}
                  ctx={ctx}
                  handlers={handlers}
                  busy={busy[idea.id] ?? null}
                  isNew={newIds.has(idea.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <IdeaDetailSheet
        idea={selectedIdea}
        ctx={ctx}
        handlers={handlers}
        onSaveDraft={saveDraft}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

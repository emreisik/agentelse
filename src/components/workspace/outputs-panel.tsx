"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  CalendarDays,
  Check,
  CheckSquare,
  Copy,
  Download,
  Inbox,
  Loader2,
  Search,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";

import { SourceMark } from "@/components/calendar/calendar-bits";
import { OutputPreviewDialog } from "@/components/workspace/output-preview-dialog";
import { assetUrl } from "@/lib/asset-url";
import { addDaysToKey, formatDayLong } from "@/lib/calendar/grid";
import {
  applyDecision,
  assetsOf,
  countOutputEntries,
  decisionOf,
  filterOutputEntries,
  groupOutputs,
  sortOutputEntries,
  type OutputDecision,
  type OutputDelivery,
  type OutputEntry,
  type OutputPostsPayload,
  type OutputVerdict,
} from "@/lib/calendar/output-posts";
import { relativeDayLabel } from "@/lib/calendar/panel-view";
import type { CalendarSource } from "@/lib/calendar/types";
import {
  EMPTY_OUTPUT_FILTER,
  KIND_LABEL,
  KIND_ORDER,
  OUTPUT_SORTS,
  PHASE_META,
  PHASE_ORDER,
  activeOutputFilters,
  type OutputFilter,
  type OutputPhase,
  type OutputSort,
} from "@/lib/outputs/panel";
import { dayKeyInTimezone } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";
import { approvePostAction } from "@/server/actions/post-actions";

// Sağ panelin Outputs sekmesi: projenin ürettiği her şey (arşiv hariç), post
// başına tek kart (docs/works.md "Posts"): bir postun mecra teslimatları
// (Instagram post, Story, Facebook...) aynı kartta, postun görseli ve her
// mecranın simgesiyle; postu olmayan parça kendi kartıdır
// (lib/calendar/output-posts.ts). İstemcide arama, durum/platform/biçim
// süzgeçleri (teslimatlarından biri uyan post görünür), sıralama, kart
// üstünden onay (postun onayı bütün postu onaylar) ve ret, metin kopyalama,
// indirme ve çoklu seçimle toplu onay/indirme. Veri kendi hafif ucundan gelir
// (/api/projects/[id]/outputs) ve 30 sn'de bir tazelenir; eskiden sayfayla
// gelen son 24 parçaydı ve sayfa yenilenmeden değişmiyordu.

const POLL_MS = 30_000;
const PAGE = 24;
const STORAGE_PREFIX = "ws-outputs:";

const PHASE_COLOR: Record<(typeof PHASE_META)[OutputPhase]["tone"], string> = {
  muted: "var(--ws-text-3)",
  pending: "var(--ws-pending)",
  ok: "var(--ws-approved)",
  active: "var(--ws-accent)",
  danger: "var(--destructive)",
};

function readSort(projectId: string): OutputSort | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + projectId);
    return OUTPUT_SORTS.some((s) => s.key === raw) ? (raw as OutputSort) : null;
  } catch {
    return null;
  }
}

function writeSort(projectId: string, sort: OutputSort) {
  try {
    localStorage.setItem(STORAGE_PREFIX + projectId, sort);
  } catch {
    // Depolama kapalı: tercih yalnız bu oturumda kalır.
  }
}

async function fetchOutputs(
  projectId: string,
  signal?: AbortSignal,
): Promise<OutputPostsPayload | null> {
  try {
    const response = await fetch(`/api/projects/${projectId}/outputs`, {
      signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as OutputPostsPayload;
  } catch {
    return null;
  }
}

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function headline(item: OutputDelivery): string {
  return item.title ?? item.preview ?? item.label;
}

function downloadAsset(assetId: string) {
  const link = document.createElement("a");
  link.href = `/api/assets/${assetId}`;
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// Tarayıcı art arda indirmeleri engellemesin diye aralıklı.
function downloadAssets(assetIds: readonly string[]) {
  assetIds.forEach((assetId, index) =>
    setTimeout(() => downloadAsset(assetId), index * 350),
  );
}

function copyText(text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success("Copied"))
    .catch(() => toast.error("Couldn't copy"));
}

type DecisionResult = { ok: true } | { ok: false; message: string };

async function sendDecision(decision: OutputDecision): Promise<DecisionResult> {
  try {
    if (decision.kind === "approve-post") {
      return await approvePostAction(decision.postId);
    }
    const formData = new FormData();
    formData.set("approvalId", decision.approvalId);
    return await (decision.kind === "approve"
      ? approveApprovalAction(formData)
      : rejectApprovalAction(formData));
  } catch {
    return { ok: false, message: "Couldn't reach the server. Try again." };
  }
}

// Kartları sırayla karara bağlar (decisionOf): bir postun onayı mecra sayısı
// kadar değil, tek approvePostAction çağrısıdır. Her başarılı kartta
// `onDecided` (iyimser güncelleme); kararı olmayan kart atlanır.
export async function decideEntries(
  entries: readonly OutputEntry[],
  to: OutputVerdict,
  onDecided?: (entry: OutputEntry) => void,
): Promise<{ done: number; failure: string | null }> {
  let done = 0;
  let failure: string | null = null;
  for (const entry of entries) {
    const decision = decisionOf(entry, to);
    if (!decision) continue;
    const result = await sendDecision(decision);
    if (!result.ok) {
      failure = result.message;
      continue;
    }
    done += 1;
    onDecided?.(entry);
  }
  return { done, failure };
}

export function OutputsPanel({
  projectId,
  timezone,
}: {
  projectId: string;
  timezone: string;
}) {
  // ── Veri ───────────────────────────────────────────────────────────────────
  // Sunucu teslimat başına satır verir; kartlar (post başına bir) istemcide.
  const [items, setItems] = useState<OutputDelivery[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const busy = useRef(0);

  const settle = useCallback((payload: OutputPostsPayload | null) => {
    if (payload) {
      setItems(payload.items);
      setTruncated(payload.truncated);
      setStatus("ready");
    } else {
      setStatus((prev) => (prev === "ready" ? prev : "error"));
    }
  }, []);
  const reload = useCallback(async () => {
    settle(await fetchOutputs(projectId));
  }, [projectId, settle]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchOutputs(projectId, controller.signal).then((payload) => {
      if (!controller.signal.aborted) settle(payload);
    });
    return () => controller.abort();
  }, [projectId, settle]);

  useEffect(() => {
    const tick = () => {
      if (document.hidden || busy.current > 0) return;
      void reload();
    };
    const timer = setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  const entries = useMemo(() => groupOutputs(items), [items]);

  // ── Süzgeçler ──────────────────────────────────────────────────────────────
  const [filter, setFilter] = useState<OutputFilter>(EMPTY_OUTPUT_FILTER);
  // Panel yalnız sekme açılınca bağlanır (Base UI pasif sekmeyi render etmez).
  const [sort, setSort] = useState<OutputSort>(
    () => readSort(projectId) ?? "newest",
  );
  useEffect(() => writeSort(projectId, sort), [projectId, sort]);
  const [showFilters, setShowFilters] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const visible = useMemo(
    () => sortOutputEntries(filterOutputEntries(entries, filter), sort),
    [entries, filter, sort],
  );
  // Şerit sayıları kart sayar: bir post, uyan her durumda bir kez. "All" o
  // yüzden durumların toplamı değil, durum süzgeci olmadan uyan kartlardır.
  const phaseCounts = useMemo(
    () => countOutputEntries(entries, filter, "phases", (d) => d.phase),
    [entries, filter],
  );
  const phaseTotal = useMemo(
    () => filterOutputEntries(entries, filter, "phases").length,
    [entries, filter],
  );
  const sourceCounts = useMemo(
    () => countOutputEntries(entries, filter, "sources", (d) => d.source.key),
    [entries, filter],
  );
  const kindCounts = useMemo(
    () => countOutputEntries(entries, filter, "kinds", (d) => d.kind),
    [entries, filter],
  );
  // Platform şeridi: teslimatlarda geçen her kaynak, en çok kartı olan önce.
  const sources = useMemo(() => {
    const seen = new Map<string, CalendarSource>();
    for (const item of items) {
      if (!seen.has(item.source.key)) seen.set(item.source.key, item.source);
    }
    const total = countOutputEntries(
      entries,
      EMPTY_OUTPUT_FILTER,
      "sources",
      (d) => d.source.key,
    );
    return [...seen.values()].sort(
      (a, b) => (total.get(b.key) ?? 0) - (total.get(a.key) ?? 0),
    );
  }, [items, entries]);

  // "Needs review" şeridiyle aynı sayım: bir mecrası onay bekleyen kart.
  const reviewable = entries.filter((entry) =>
    entry.deliveries.some((delivery) => delivery.phase === "review"),
  );
  const filterCount = filter.kinds.size + (filter.query.trim() ? 1 : 0);
  const anyFilter = activeOutputFilters(filter) > 0;
  const shown = visible.slice(0, limit);

  // ── Onay / ret (iyimser) ───────────────────────────────────────────────────
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(new Set());
  const decide = useCallback(
    async (targets: readonly OutputEntry[], to: OutputVerdict) => {
      const ready = targets.filter((entry) => decisionOf(entry, to) !== null);
      if (ready.length === 0) return;
      const ids = new Set(ready.map((entry) => entry.id));
      setDeciding((prev) => new Set([...prev, ...ids]));
      busy.current += 1;
      const { done, failure } = await decideEntries(ready, to, (entry) =>
        setItems((prev) => applyDecision(prev, entry, to)),
      );
      busy.current -= 1;
      setDeciding((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      if (done > 0) {
        const verb = to === "APPROVED" ? "Approved" : "Rejected";
        toast.success(done === 1 ? verb : `${verb} ${done} outputs`);
      }
      if (failure) toast.error(failure);
      void reload();
    },
    [reload],
  );

  // ── Çoklu seçim ────────────────────────────────────────────────────────────
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const picked = entries.filter((entry) => selected.has(entry.id));
  const pickedApprovable = picked.filter(
    (entry) => decisionOf(entry, "APPROVED") !== null,
  );
  // Postun her biçimi kendi görselidir (post 3:4, story 9:16): hepsi iner.
  const pickedFiles = [...new Set(picked.flatMap((entry) => assetsOf(entry)))];
  const allPicked =
    visible.length > 0 && visible.every((entry) => selected.has(entry.id));
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const [previewId, setPreviewId] = useState<string | null>(null);
  const todayKey = dayKeyInTimezone(new Date(), timezone);

  return (
    <div className="flex flex-col gap-3 px-4 py-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div
            className="text-[10px] font-semibold tracking-[0.1em]"
            style={{ color: "var(--ws-text-3)" }}
          >
            FROM IDEA TO OUTPUT
          </div>
          <div
            className="mt-0.5 text-base font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            Made for your brand.
          </div>
        </div>
        {entries.length > 0 ? (
          <button
            type="button"
            aria-pressed={selecting}
            onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium transition-colors hover:bg-[var(--ws-hover)]"
            style={{
              borderColor: selecting ? "var(--ws-text)" : "var(--ws-border)",
              color: "var(--ws-text-2)",
            }}
          >
            {selecting ? (
              <>
                <X className="size-3" /> Done
              </>
            ) : (
              <>
                <CheckSquare className="size-3" /> Select
              </>
            )}
          </button>
        ) : null}
      </div>

      {/* Bekleyen onaylar */}
      {reviewable.length > 0 && !filter.phases.has("review") ? (
        <div
          className="flex items-center gap-2 rounded-xl border px-3 py-2 text-[11px]"
          style={{
            borderColor: "var(--ws-border)",
            background: "var(--ws-surface-2)",
            color: "var(--ws-text)",
          }}
        >
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: "var(--ws-pending)" }}
          />
          <span className="min-w-0 flex-1">
            {reviewable.length === 1
              ? "1 output is waiting for your review."
              : `${reviewable.length} outputs are waiting for your review.`}
          </span>
          <button
            type="button"
            onClick={() => {
              setFilter((prev) => ({ ...prev, phases: new Set(["review"]) }));
              setLimit(PAGE);
            }}
            className="shrink-0 font-medium underline underline-offset-2"
          >
            Review
          </button>
        </div>
      ) : null}

      {/* Durum şeridi (çoklu seçim) */}
      <div
        className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5"
        aria-label="Status"
      >
        <Chip
          active={filter.phases.size === 0}
          onClick={() => setFilter((prev) => ({ ...prev, phases: new Set() }))}
        >
          All
          <Count>{phaseTotal}</Count>
        </Chip>
        {PHASE_ORDER.filter(
          (phase) => phaseCounts.has(phase) || filter.phases.has(phase),
        ).map((phase) => (
          <Chip
            key={phase}
            active={filter.phases.has(phase)}
            onClick={() => {
              setFilter((prev) => ({
                ...prev,
                phases: toggled(prev.phases, phase),
              }));
              setLimit(PAGE);
            }}
          >
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: PHASE_COLOR[PHASE_META[phase].tone] }}
            />
            {PHASE_META[phase].label}
            <Count>{phaseCounts.get(phase) ?? 0}</Count>
          </Chip>
        ))}
      </div>

      {/* Platform şeridi (çoklu seçim) */}
      {sources.length > 1 || filter.sources.size > 0 ? (
        <div
          className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5"
          aria-label="Platforms"
        >
          {sources.map((source) => (
            <Chip
              key={source.key}
              active={filter.sources.has(source.key)}
              onClick={() => {
                setFilter((prev) => ({
                  ...prev,
                  sources: toggled(prev.sources, source.key),
                }));
                setLimit(PAGE);
              }}
            >
              <SourceMark
                source={source}
                decorative
                className="size-4 rounded"
              />
              {source.label}
              <Count>{sourceCounts.get(source.key) ?? 0}</Count>
            </Chip>
          ))}
        </div>
      ) : null}

      {/* Arama + biçim + sıralama */}
      <div className="flex items-center gap-1.5">
        <label
          className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border px-2"
          style={{ borderColor: "var(--ws-border)" }}
        >
          <Search
            className="size-3.5 shrink-0"
            style={{ color: "var(--ws-text-3)" }}
          />
          <input
            type="search"
            value={filter.query}
            onChange={(event) => {
              setFilter((prev) => ({ ...prev, query: event.target.value }));
              setLimit(PAGE);
            }}
            placeholder="Search titles and captions"
            aria-label="Search outputs"
            className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none"
            style={{ color: "var(--ws-text)" }}
          />
        </label>
        <button
          type="button"
          aria-expanded={showFilters}
          onClick={() => setShowFilters((v) => !v)}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium transition-colors hover:bg-[var(--ws-hover)]"
          style={{
            borderColor:
              filter.kinds.size > 0 ? "var(--ws-text)" : "var(--ws-border)",
            color: "var(--ws-text-2)",
          }}
        >
          <SlidersHorizontal className="size-3.5" />
          {OUTPUT_SORTS.find((s) => s.key === sort)?.label}
          {filter.kinds.size > 0 ? (
            <span
              className="rounded-full px-1.5 text-[10px] font-semibold tabular-nums"
              style={{
                background: "var(--ws-accent)",
                color: "var(--ws-on-accent)",
              }}
            >
              {filter.kinds.size}
            </span>
          ) : null}
        </button>
      </div>

      {showFilters ? (
        <div
          className="space-y-2.5 rounded-xl border p-2.5"
          style={{
            borderColor: "var(--ws-border)",
            background: "var(--ws-surface)",
          }}
        >
          <FilterGroup label="Format">
            {KIND_ORDER.filter(
              (kind) => kindCounts.has(kind) || filter.kinds.has(kind),
            ).map((kind) => (
              <Chip
                key={kind}
                small
                active={filter.kinds.has(kind)}
                onClick={() =>
                  setFilter((prev) => ({
                    ...prev,
                    kinds: toggled(prev.kinds, kind),
                  }))
                }
              >
                {KIND_LABEL[kind]}
                <Count>{kindCounts.get(kind) ?? 0}</Count>
              </Chip>
            ))}
          </FilterGroup>
          <FilterGroup label="Sort">
            {OUTPUT_SORTS.map((option) => (
              <Chip
                key={option.key}
                small
                active={sort === option.key}
                onClick={() => setSort(option.key)}
              >
                {option.label}
              </Chip>
            ))}
          </FilterGroup>
        </div>
      ) : null}

      {anyFilter ? (
        <div
          className="flex items-center justify-between text-[11px]"
          style={{ color: "var(--ws-text-3)" }}
        >
          <span>
            {visible.length} of {entries.length}
            {filterCount > 0 && !showFilters
              ? ` · ${filterCount} more filter${filterCount === 1 ? "" : "s"}`
              : ""}
          </span>
          <button
            type="button"
            onClick={() => {
              setFilter(EMPTY_OUTPUT_FILTER);
              setLimit(PAGE);
            }}
            className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
            style={{ color: "var(--ws-text-2)" }}
          >
            <X className="size-3" /> Clear
          </button>
        </div>
      ) : null}

      {status === "loading" ? (
        <div className="grid grid-cols-2 gap-3" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="aspect-[4/6] animate-pulse rounded-xl"
              style={{ background: "var(--ws-surface-2)" }}
            />
          ))}
        </div>
      ) : status === "error" ? (
        <div
          className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-xs"
          style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
        >
          Couldn&apos;t load your outputs.
          <button
            type="button"
            onClick={() => {
              setStatus("loading");
              void reload();
            }}
            className="font-medium underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div
          className="flex items-center gap-2.5 rounded-xl border border-dashed px-3 py-3"
          style={{ borderColor: "var(--ws-border)" }}
        >
          <Inbox
            className="size-4 shrink-0"
            style={{ color: "var(--ws-text-3)" }}
          />
          <div>
            <p
              className="text-xs font-medium"
              style={{ color: "var(--ws-text)" }}
            >
              {entries.length === 0
                ? "It starts with an idea."
                : "Nothing matches these filters."}
            </p>
            <p className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
              {entries.length === 0
                ? "Ask Agentelse to create something."
                : "Try another status, platform or search."}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            {shown.map((entry) => (
              <OutputCard
                key={entry.id}
                item={entry}
                projectId={projectId}
                todayKey={todayKey}
                selecting={selecting}
                selected={selected.has(entry.id)}
                deciding={deciding.has(entry.id)}
                onOpen={setPreviewId}
                onToggle={() => setSelected((prev) => toggled(prev, entry.id))}
                onDecide={(to) => void decide([entry], to)}
              />
            ))}
          </div>
          {visible.length > shown.length ? (
            <button
              type="button"
              onClick={() => setLimit((n) => n + PAGE)}
              className="rounded-xl border py-2 text-xs font-medium transition-colors hover:bg-[var(--ws-hover)]"
              style={{
                borderColor: "var(--ws-border)",
                color: "var(--ws-text-2)",
              }}
            >
              Show more ({visible.length - shown.length})
            </button>
          ) : null}
          {truncated && visible.length <= shown.length ? (
            <p
              className="text-center text-[10.5px]"
              style={{ color: "var(--ws-text-3)" }}
            >
              Showing your latest {entries.length} outputs.
            </p>
          ) : null}
        </>
      )}

      {/* Toplu işlem çubuğu */}
      {selecting ? (
        <div
          className="sticky bottom-2 z-10 flex flex-wrap items-center gap-1.5 rounded-xl border p-2 shadow-[0_6px_20px_rgba(0,0,0,0.12)]"
          style={{
            borderColor: "var(--ws-border)",
            background: "var(--ws-surface)",
          }}
        >
          <span
            className="mr-auto pl-1 text-[11px] font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            {picked.length} selected
          </span>
          <button
            type="button"
            onClick={() =>
              setSelected(
                allPicked ? new Set() : new Set(visible.map((i) => i.id)),
              )
            }
            className="rounded-lg px-2 py-1 text-[11px] font-medium hover:bg-[var(--ws-hover)]"
            style={{ color: "var(--ws-text-2)" }}
          >
            {allPicked ? "None" : "All"}
          </button>
          <button
            type="button"
            disabled={pickedApprovable.length === 0}
            onClick={() => {
              void decide(pickedApprovable, "APPROVED").then(stopSelecting);
            }}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium disabled:opacity-40"
            style={{
              background: "var(--ws-accent)",
              color: "var(--ws-on-accent)",
            }}
          >
            <Check className="size-3" /> Approve
            {pickedApprovable.length > 0 ? ` ${pickedApprovable.length}` : ""}
          </button>
          <button
            type="button"
            disabled={pickedFiles.length === 0}
            onClick={() => downloadAssets(pickedFiles)}
            className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium disabled:opacity-40"
            style={{ borderColor: "var(--ws-border)", color: "var(--ws-text)" }}
          >
            <Download className="size-3" /> Download
            {pickedFiles.length > 0 ? ` ${pickedFiles.length}` : ""}
          </button>
        </div>
      ) : null}

      <OutputPreviewDialog
        creativeId={previewId}
        onOpenChange={(open) => {
          if (!open) setPreviewId(null);
        }}
        onChanged={() => void reload()}
      />
    </div>
  );
}

// ── Parçalar ──────────────────────────────────────────────────────────────────

function Chip({
  active,
  onClick,
  small = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  small?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border font-medium whitespace-nowrap transition-colors hover:bg-[var(--ws-hover)]",
        small ? "h-6 px-2 text-[10.5px]" : "h-7 px-2.5 text-[11px]",
      )}
      style={
        active
          ? {
              borderColor: "var(--ws-text)",
              background: "var(--ws-hover)",
              color: "var(--ws-text)",
            }
          : { borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }
      }
    >
      {children}
    </button>
  );
}

function Count({ children }: { children: React.ReactNode }) {
  return (
    <span className="tabular-nums" style={{ color: "var(--ws-text-3)" }}>
      {children}
    </span>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="mb-1 text-[10px] font-semibold tracking-[0.08em] uppercase"
        style={{ color: "var(--ws-text-3)" }}
      >
        {label}
      </div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function whenLabel(item: OutputDelivery, todayKey: string): string | null {
  if (!item.scheduledLocal) return null;
  const day = item.scheduledLocal.slice(0, 10);
  const time = item.scheduledLocal.slice(11, 16);
  const relative = relativeDayLabel(day, todayKey, addDaysToKey);
  return `${relative ?? formatDayLong(day).replace(/^\w+, /, "")} · ${time}`;
}

// Postun ekran okuyucu metni: her mecra ve kendi durumu.
function deliveriesText(deliveries: readonly OutputDelivery[]): string {
  return deliveries
    .map((delivery) => `${delivery.label}: ${PHASE_META[delivery.phase].label}`)
    .join("; ");
}

// Bir kart: bir post (mecra teslimatları birlikte) ya da postu olmayan tek
// parça. Kartın onayı postu onaylar; ret yalnız tek mecralı kartta, çok
// mecralı postun bir mecrası simgesine dokunup kendi önizlemesinde reddedilir.
export function OutputCard({
  item,
  projectId,
  todayKey,
  selecting,
  selected,
  deciding,
  onOpen,
  onToggle,
  onDecide,
}: {
  item: OutputEntry;
  projectId: string;
  todayKey: string;
  selecting: boolean;
  selected: boolean;
  deciding: boolean;
  // Açılacak parça: kartın kendisi (postun ilk mecrası) ya da simgesine
  // dokunulan mecra.
  onOpen: (creativeId: string) => void;
  onToggle: () => void;
  onDecide: (to: OutputVerdict) => void;
}) {
  const phase = PHASE_META[item.phase];
  const when = whenLabel(item, todayKey);
  const multi = item.deliveries.length > 1;
  const files = assetsOf(item);
  const canApprove = decisionOf(item, "APPROVED") !== null;
  const canReject = decisionOf(item, "REJECTED") !== null;
  // Çok mecralı postun erişilebilir adı her mecrayı ve durumunu sayar.
  const name = multi
    ? `${headline(item)}. ${deliveriesText(item.deliveries)}`
    : headline(item);

  return (
    <div
      className="group relative flex flex-col overflow-hidden rounded-xl border shadow-[0_1px_3px_rgba(52,75,29,0.04)] transition-colors"
      style={{
        borderColor: selected ? "var(--ws-text)" : "var(--ws-border)",
        background: "var(--ws-surface)",
      }}
    >
      <button
        type="button"
        onClick={selecting ? onToggle : () => onOpen(item.id)}
        aria-label={selecting ? `Select ${name}` : `Open ${name}`}
        aria-pressed={selecting ? selected : undefined}
        className="relative block aspect-[4/5] w-full overflow-hidden text-left"
        style={{ background: "var(--ws-surface-2)" }}
      >
        {item.assetId ? (
          // eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image can't optimize it
          <img
            // A ~150px tile in a two-column grid: the 320px preview covers 2x
            // screens (the 768px "card" size was ~5x the pixels).
            src={assetUrl(item.assetId, "thumb")}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : item.preview ? (
          // Metin parçaları (caption, copy, plan): görsel yerine metnin başı.
          <span
            className="line-clamp-[8] block p-3 text-[11px] leading-snug"
            style={{ color: "var(--ws-text-body)" }}
          >
            {item.preview}
          </span>
        ) : null}

        {/* Tek mecralı kartta mecra görselin köşesinde; postun mecraları
            aşağıda simge sırasıyla. */}
        {multi ? null : (
          <SourceMark
            source={item.source}
            decorative
            className="absolute top-2 left-2 size-5 rounded-md shadow-sm ring-1 ring-black/5"
          />
        )}
        {item.version && item.version > 1 ? (
          <span
            className="absolute bottom-2 left-2 rounded-full px-1.5 py-px text-[9.5px] font-medium backdrop-blur-sm"
            style={{ background: "rgba(0,0,0,0.45)", color: "#fff" }}
          >
            v{item.version}
          </span>
        ) : null}
        {selecting ? (
          <span className="absolute top-2 right-2 rounded bg-white/90 text-black shadow-sm">
            {selected ? (
              <CheckSquare className="size-4" />
            ) : (
              <Square className="size-4" />
            )}
          </span>
        ) : null}
      </button>

      {/* Hızlı eylemler: fare üstündeyken ya da klavyeyle odaklanınca */}
      {!selecting && (item.text || files.length > 0 || item.scheduledFor) ? (
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {item.text ? (
            <QuickAction label="Copy text" onClick={() => copyText(item.text!)}>
              <Copy className="size-3" />
            </QuickAction>
          ) : null}
          {files.length > 0 ? (
            <QuickAction
              label={
                files.length > 1
                  ? `Download ${files.length} images`
                  : "Download image"
              }
              onClick={() => downloadAssets(files)}
            >
              <Download className="size-3" />
            </QuickAction>
          ) : null}
          {item.scheduledFor ? (
            <a
              href={`/projects/${projectId}/takvim?creative=${item.id}`}
              title="Show in calendar"
              aria-label="Show in calendar"
              className="flex size-6 items-center justify-center rounded-full bg-white/90 text-black shadow-sm hover:bg-white"
            >
              <CalendarDays className="size-3" />
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-0.5 p-2.5">
        {multi ? (
          <ChannelMarks
            deliveries={item.deliveries}
            onOpen={selecting ? undefined : onOpen}
          />
        ) : (
          <span
            className="truncate text-[10px] font-medium tracking-wide uppercase"
            style={{ color: "var(--ws-text-3)" }}
          >
            {item.label}
          </span>
        )}
        <span
          className="truncate text-xs font-medium"
          style={{ color: "var(--ws-text)" }}
          title={headline(item)}
        >
          {item.title ?? "Untitled"}
        </span>
        <span
          className="flex min-w-0 items-center gap-1 text-[10px]"
          style={{ color: "var(--ws-text-3)" }}
        >
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: PHASE_COLOR[phase.tone] }}
          />
          <span className="shrink-0">{phase.label}</span>
          {when ? <span className="truncate">· {when}</span> : null}
        </span>

        {canApprove && !selecting ? (
          <div className="mt-1.5 flex gap-1">
            <button
              type="button"
              disabled={deciding}
              onClick={() => onDecide("APPROVED")}
              title={
                multi
                  ? "Approves every waiting channel of this post"
                  : undefined
              }
              className="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded-md text-[10.5px] font-medium disabled:opacity-50"
              style={{
                background: "var(--ws-accent)",
                color: "var(--ws-on-accent)",
              }}
            >
              {deciding ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
              {multi ? "Approve post" : "Approve"}
            </button>
            {canReject ? (
              <button
                type="button"
                disabled={deciding}
                onClick={() => onDecide("REJECTED")}
                aria-label="Reject"
                title="Reject"
                className="inline-flex h-6 items-center justify-center rounded-md border px-1.5 disabled:opacity-50"
                style={{
                  borderColor: "var(--ws-border)",
                  color: "var(--ws-text-3)",
                }}
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Postun mecraları: her teslimatın simgesi, köşesinde o teslimatın kendi
// durumunun küçük noktası (takvimdeki DeliveryMarks gibi). Story yuvarlak
// simgeyle aynı mecradaki posttan ayrılır. Dokununca o mecra kendi
// önizlemesinde açılır (metni, uyarlanmış görseli, tek başına ret).
function ChannelMarks({
  deliveries,
  onOpen,
}: {
  deliveries: readonly OutputDelivery[];
  // Yoksa (seçim kipi) simgeler yalnız gösterilir.
  onOpen?: (creativeId: string) => void;
}) {
  return (
    <span className="-mx-0.5 -my-0.5 flex min-w-0 flex-wrap items-center gap-0.5">
      {deliveries.map((delivery) => {
        const label = `${delivery.label} · ${PHASE_META[delivery.phase].label}`;
        const mark = (
          <>
            <SourceMark
              source={delivery.source}
              decorative
              className={cn(
                "size-4 rounded",
                delivery.kind === "story" && "rounded-full",
              )}
            />
            <span
              aria-hidden
              className="absolute right-0 bottom-0 size-1.5 rounded-full ring-1 ring-[var(--ws-surface)]"
              style={{
                background: PHASE_COLOR[PHASE_META[delivery.phase].tone],
              }}
            />
          </>
        );
        return onOpen ? (
          <button
            key={delivery.id}
            type="button"
            data-delivery={delivery.id}
            title={label}
            aria-label={`Open ${label}`}
            onClick={() => onOpen(delivery.id)}
            className="relative inline-flex rounded-md p-0.5 transition-colors hover:bg-[var(--ws-hover)]"
          >
            {mark}
          </button>
        ) : (
          <span
            key={delivery.id}
            data-delivery={delivery.id}
            title={label}
            className="relative inline-flex p-0.5"
          >
            {mark}
          </span>
        );
      })}
    </span>
  );
}

function QuickAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-full bg-white/90 text-black shadow-sm hover:bg-white"
    >
      {children}
    </button>
  );
}

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
  countOutputs,
  filterOutputs,
  phaseOf,
  sortOutputs,
  type OutputFilter,
  type OutputItem,
  type OutputPhase,
  type OutputSort,
  type OutputsPayload,
} from "@/lib/outputs/panel";
import { dayKeyInTimezone } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";

// Sağ panelin Outputs sekmesi: projenin ürettiği her parça (arşiv hariç),
// istemcide arama, durum/platform/biçim süzgeçleri, sıralama, kart üstünden
// onay/ret, metin kopyalama, indirme ve çoklu seçimle toplu onay/indirme.
// Veri kendi hafif ucundan gelir (/api/projects/[id]/outputs) ve 30 sn'de bir
// tazelenir; eskiden sayfayla gelen son 24 parçaydı ve sayfa yenilenmeden
// değişmiyordu.

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
): Promise<OutputsPayload | null> {
  try {
    const response = await fetch(`/api/projects/${projectId}/outputs`, {
      signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as OutputsPayload;
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

function headline(item: OutputItem): string {
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

function copyText(text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success("Copied"))
    .catch(() => toast.error("Couldn't copy"));
}

export function OutputsPanel({
  projectId,
  timezone,
}: {
  projectId: string;
  timezone: string;
}) {
  // ── Veri ───────────────────────────────────────────────────────────────────
  const [items, setItems] = useState<OutputItem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const busy = useRef(0);

  const settle = useCallback((payload: OutputsPayload | null) => {
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
    () => sortOutputs(filterOutputs(items, filter), sort),
    [items, filter, sort],
  );
  const phaseCounts = useMemo(
    () => countOutputs(filterOutputs(items, filter, "phases"), (i) => i.phase),
    [items, filter],
  );
  const sourcePool = useMemo(
    () => filterOutputs(items, filter, "sources"),
    [items, filter],
  );
  const sourceCounts = useMemo(
    () => countOutputs(sourcePool, (i) => i.source.key),
    [sourcePool],
  );
  const kindCounts = useMemo(
    () => countOutputs(filterOutputs(items, filter, "kinds"), (i) => i.kind),
    [items, filter],
  );
  // Platform şeridi: listede geçen her kaynak, en çok parçası olan önce.
  const sources = useMemo(() => {
    const seen = new Map<string, CalendarSource>();
    for (const item of items) {
      if (!seen.has(item.source.key)) seen.set(item.source.key, item.source);
    }
    const total = countOutputs(items, (i) => i.source.key);
    return [...seen.values()].sort(
      (a, b) => (total.get(b.key) ?? 0) - (total.get(a.key) ?? 0),
    );
  }, [items]);

  const reviewable = items.filter((i) => i.phase === "review");
  const filterCount = filter.kinds.size + (filter.query.trim() ? 1 : 0);
  const anyFilter = activeOutputFilters(filter) > 0;
  const shown = visible.slice(0, limit);

  // ── Onay / ret (iyimser) ───────────────────────────────────────────────────
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(new Set());
  const decide = useCallback(
    async (targets: OutputItem[], to: "APPROVED" | "REJECTED") => {
      const ready = targets.filter((t) => t.approvalId);
      if (ready.length === 0) return;
      const ids = new Set(ready.map((t) => t.id));
      setDeciding((prev) => new Set([...prev, ...ids]));
      busy.current += 1;
      let done = 0;
      let failure: string | null = null;
      for (const target of ready) {
        const formData = new FormData();
        formData.set("approvalId", target.approvalId!);
        try {
          const result = await (to === "APPROVED"
            ? approveApprovalAction(formData)
            : rejectApprovalAction(formData));
          if (!result.ok) {
            failure = result.message;
            continue;
          }
        } catch {
          failure = "Couldn't reach the server. Try again.";
          continue;
        }
        done += 1;
        setItems((prev) =>
          prev.map((i) =>
            i.id === target.id
              ? {
                  ...i,
                  status: to,
                  phase: phaseOf(to, i.scheduledFor),
                  approvalId: null,
                }
              : i,
          ),
        );
      }
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
  const picked = items.filter((i) => selected.has(i.id));
  const pickedApprovable = picked.filter((i) => i.approvalId);
  const pickedDownloadable = picked.filter((i) => i.assetId);
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const bulkDownload = () => {
    // Tarayıcı art arda indirmeleri engellemesin diye aralıklı.
    pickedDownloadable.forEach((item, index) =>
      setTimeout(() => downloadAsset(item.assetId!), index * 350),
    );
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
        {items.length > 0 ? (
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
          <Count>{[...phaseCounts.values()].reduce((a, b) => a + b, 0)}</Count>
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
            {visible.length} of {items.length}
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
              {items.length === 0
                ? "It starts with an idea."
                : "Nothing matches these filters."}
            </p>
            <p className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
              {items.length === 0
                ? "Ask Agentelse to create something."
                : "Try another status, platform or search."}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            {shown.map((item) => (
              <OutputCard
                key={item.id}
                item={item}
                projectId={projectId}
                todayKey={todayKey}
                selecting={selecting}
                selected={selected.has(item.id)}
                deciding={deciding.has(item.id)}
                onOpen={() => setPreviewId(item.id)}
                onToggle={() => setSelected((prev) => toggled(prev, item.id))}
                onDecide={(to) => void decide([item], to)}
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
              Showing your latest {items.length} outputs.
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
            {selected.size} selected
          </span>
          <button
            type="button"
            onClick={() =>
              setSelected(
                selected.size === visible.length
                  ? new Set()
                  : new Set(visible.map((i) => i.id)),
              )
            }
            className="rounded-lg px-2 py-1 text-[11px] font-medium hover:bg-[var(--ws-hover)]"
            style={{ color: "var(--ws-text-2)" }}
          >
            {selected.size === visible.length && visible.length > 0
              ? "None"
              : "All"}
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
            disabled={pickedDownloadable.length === 0}
            onClick={bulkDownload}
            className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium disabled:opacity-40"
            style={{ borderColor: "var(--ws-border)", color: "var(--ws-text)" }}
          >
            <Download className="size-3" /> Download
            {pickedDownloadable.length > 0
              ? ` ${pickedDownloadable.length}`
              : ""}
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

function whenLabel(item: OutputItem, todayKey: string): string | null {
  if (!item.scheduledLocal) return null;
  const day = item.scheduledLocal.slice(0, 10);
  const time = item.scheduledLocal.slice(11, 16);
  const relative = relativeDayLabel(day, todayKey, addDaysToKey);
  return `${relative ?? formatDayLong(day).replace(/^\w+, /, "")} · ${time}`;
}

function OutputCard({
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
  item: OutputItem;
  projectId: string;
  todayKey: string;
  selecting: boolean;
  selected: boolean;
  deciding: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onDecide: (to: "APPROVED" | "REJECTED") => void;
}) {
  const phase = PHASE_META[item.phase];
  const when = whenLabel(item, todayKey);
  const primary = selecting ? onToggle : onOpen;

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
        onClick={primary}
        aria-label={
          selecting ? `Select ${headline(item)}` : `Open ${headline(item)}`
        }
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

        <SourceMark
          source={item.source}
          decorative
          className="absolute top-2 left-2 size-5 rounded-md shadow-sm ring-1 ring-black/5"
        />
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
      {!selecting && (item.assetId || item.text || item.scheduledFor) ? (
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {item.text ? (
            <QuickAction label="Copy text" onClick={() => copyText(item.text!)}>
              <Copy className="size-3" />
            </QuickAction>
          ) : null}
          {item.assetId ? (
            <QuickAction
              label="Download image"
              onClick={() => downloadAsset(item.assetId!)}
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
        <span
          className="truncate text-[10px] font-medium tracking-wide uppercase"
          style={{ color: "var(--ws-text-3)" }}
        >
          {item.label}
        </span>
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

        {item.approvalId && !selecting ? (
          <div className="mt-1.5 flex gap-1">
            <button
              type="button"
              disabled={deciding}
              onClick={() => onDecide("APPROVED")}
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
              Approve
            </button>
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
          </div>
        ) : null}
      </div>
    </div>
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

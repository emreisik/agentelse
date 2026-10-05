"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
} from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Inbox,
  Plug,
  Settings2,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import {
  addDaysToKey,
  formatDayLong,
  formatShortRange,
  type CalendarView,
} from "@/lib/calendar/grid";
import {
  mergeFresh,
  reuseUnchanged,
  type ItemCache,
} from "@/lib/calendar/item";
import { isDroppableDay, resolveDrop } from "@/lib/calendar/move";
import {
  EMPTY_FILTER,
  countEntries,
  filterItems,
  type PanelFilter,
} from "@/lib/calendar/panel-view";
import {
  groupPosts,
  postGroupOf,
  reschedulePost,
  type EntryCache,
} from "@/lib/calendar/posts";
import {
  STAGE_META,
  STAGE_ORDER,
  type CalendarStage,
} from "@/lib/calendar/stage";
import type {
  CalendarDetail,
  CalendarPayload,
  CalendarSource,
} from "@/lib/calendar/types";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { rescheduleCreativeAction } from "@/server/actions/creative-calendar-actions";

import { fetchCalendar, fetchDetail } from "./api";
import { SourceMark, StageIcon, TONE_PILL } from "./calendar-bits";
import { DayCell, DRAG_TYPE, WEEKDAYS, type BoardDay } from "./calendar-day";
import {
  RichCard,
  TrayCard,
  type BoardEntry,
  type BoardItem,
  type DragHandlers,
} from "./calendar-items";
import { CreativeDetail } from "./creative-detail";

export type { BoardDay };

export type BoardHrefs = {
  prev: string;
  next: string;
  today: string;
  month: string;
  week: string;
  // Parça kimliği sonuna eklenerek paylaşılabilir adres olur (?creative=).
  creativePrefix: string;
  integrations: string;
  settings: string;
  chat: string;
};

type BoardProps = {
  projectId: string;
  timezone: string;
  todayKey: string;
  view: CalendarView;
  title: string;
  days: BoardDay[];
  focusMonth: number | null;
  isCurrent: boolean;
  hrefs: BoardHrefs;
  // Sunucunun ilk yüklemedeki verisi; sonrası hafif yoklama ucundan gelir.
  data: CalendarPayload;
  initialOpenId?: string;
  initialSource?: string;
};

const POLL_MS = 30_000;
// Detay iki kez art arda okunmasın: bu süre içinde eldeki taze sayılır.
const HOVER_FRESH_MS = 60_000;
const OPEN_FRESH_MS = 15_000;
// Hover'da ayrıntıyı önceden çekmek için fare bir kartta bu kadar durmalı.
const HOVER_INTENT_MS = 120;
// Atanmamış tepsisinde ilk gösterilen kart sayısı (gerisi "Show all").
const TRAY_LIMIT = 30;

const NO_ITEMS: BoardEntry[] = [];

// Panel açıkken adres paylaşılabilir/yenilenebilir olsun diye `?creative=`
// adrese yazılır; ama Next yönlendiricisi tetiklenmez: `replaceState` sayfayı
// sunucuda yeniden render ettirmez (eskiden her açılış tam sayfa render'ıydı).
function syncUrl(creativeId: string | null) {
  const url = new URL(window.location.href);
  if (creativeId) url.searchParams.set("creative", creativeId);
  else url.searchParams.delete("creative");
  window.history.replaceState(null, "", url);
}

// Hafta görünümü satırları: 7'şer günlük dilimler (Pazartesi başlar).
function weekRows(days: readonly BoardDay[]): BoardDay[][] {
  const rows: BoardDay[][] = [];
  for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));
  return rows;
}

// Bugünün haftasına göre satır başlığı ("This week", "Next week"...).
function weekRowLabel(row: readonly BoardDay[], todayKey: string): string {
  const has = (key: string | null) =>
    key !== null && row.some((day) => day.key === key);
  if (has(todayKey)) return "This week";
  if (has(addDaysToKey(todayKey, 7))) return "Next week";
  if (has(addDaysToKey(todayKey, -7))) return "Last week";
  return "Week";
}

function byTime(a: BoardEntry, b: BoardEntry): number {
  return (
    (a.localTime ?? "").localeCompare(b.localTime ?? "") ||
    (a.title ?? a.label).localeCompare(b.title ?? b.label)
  );
}

export function CalendarBoard(props: BoardProps) {
  const {
    projectId,
    timezone,
    todayKey,
    view,
    title,
    days,
    focusMonth,
    isCurrent,
    hrefs,
    data,
  } = props;
  const firstKey = days[0]!.key;
  const lastKey = days[days.length - 1]!.key;

  // ── Veri: sunucudan gelen ilk durum + yerel değişiklikler ───────────────────
  const [cache] = useState<ItemCache>(() => new Map());
  const [items, setItems] = useState<BoardItem[]>(() =>
    reuseUnchanged(data.items, cache),
  );
  const [meta, setMeta] = useState({
    connections: data.connections,
    scheduleEnabled: data.scheduleEnabled,
  });
  // Bir parçaya en son kendi yazdığımız an: bundan ÖNCE okunmaya başlamış bir
  // yoklama yanıtı o parçanın yerel halini ezmez (bkz. mergeFresh).
  const stamps = useRef(new Map<string, number>());
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  // Uçuştaki yazma sayısı: bu sürerken yoklama yapılmaz.
  const busy = useRef(0);

  // Post başına bir kart (docs/works.md "Posts"): aynı postun mecra
  // teslimatları tek girdi olur; değişmeyen girdi aynı nesne kalır.
  const [entryCache] = useState<EntryCache<BoardItem>>(() => new Map());
  const entries = useMemo(
    () => groupPosts(items, entryCache),
    [items, entryCache],
  );

  const applyPayload = useCallback(
    (payload: CalendarPayload) => {
      setItems((prev) =>
        reuseUnchanged(mergeFresh(prev, payload, stamps.current), cache),
      );
      setMeta({
        connections: payload.connections,
        scheduleEnabled: payload.scheduleEnabled,
      });
    },
    [cache],
  );

  // Sunucu ay/hafta değişince ya da bir eylem sayfayı yeniden render edince
  // yeni veri verir; yerel durumla birleştir.
  const lastData = useRef(data);
  useEffect(() => {
    if (lastData.current === data) return;
    lastData.current = data;
    applyPayload(data);
  }, [data, applyPayload]);

  // Hafif yoklama: yalnız takvim verisi (sayfayı komple yeniden render etmez).
  const refreshNow = useCallback(async () => {
    const payload = await fetchCalendar(projectId, firstKey, lastKey);
    if (payload) applyPayload(payload);
  }, [projectId, firstKey, lastKey, applyPayload]);

  const dragRef = useRef<string | null>(null);
  useEffect(() => {
    const tick = () => {
      if (document.hidden || busy.current > 0 || dragRef.current !== null) {
        return;
      }
      void refreshNow();
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
  }, [refreshNow]);

  // ── Süzgeçler ──────────────────────────────────────────────────────────────
  const [stageFilter, setStageFilter] = useState<CalendarStage | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string | null>(
    props.initialSource ?? null,
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [trayAll, setTrayAll] = useState(false);

  // Süzgeçler teslimat başına çalışır: mecralarından biri uyan post görünür.
  // Her şerit diğer süzgece göre sayar (durum sayıları seçili platformu,
  // platform sayıları seçili durumu yansıtır); post her değerde bir kez.
  const filter = useMemo<PanelFilter>(
    () => ({
      ...EMPTY_FILTER,
      sources: new Set(sourceFilter ? [sourceFilter] : []),
      stages: new Set(stageFilter ? [stageFilter] : []),
    }),
    [sourceFilter, stageFilter],
  );
  const visible = useMemo(
    () => filterItems(entries, filter),
    [entries, filter],
  );

  const stageCounts = useMemo(
    () => countEntries(entries, filter, "stages", (d) => d.stage),
    [entries, filter],
  );

  const { connections, scheduleEnabled } = meta;
  const sourceRows = useMemo(() => {
    const scopedCount = countEntries(
      entries,
      filter,
      "sources",
      (d) => d.source.key,
    );
    const totalCount = countEntries(
      entries,
      EMPTY_FILTER,
      "sources",
      (d) => d.source.key,
    );
    type Row = {
      source: CalendarSource;
      // null: bağlanacak bir hesabı yok (Blog/SEO gibi elle kanallar)
      connected: boolean | null;
      account: string | null;
      count: number;
    };
    const rows: Row[] = connections
      .filter((c) => c.connected || (totalCount.get(c.source.key) ?? 0) > 0)
      .map((c) => ({
        source: c.source,
        connected: c.connected,
        account: c.account,
        count: scopedCount.get(c.source.key) ?? 0,
      }));
    const known = new Set(connections.map((c) => c.source.key));
    const seen = new Set<string>();
    for (const item of items) {
      if (known.has(item.source.key) || seen.has(item.source.key)) continue;
      seen.add(item.source.key);
      rows.push({
        source: item.source,
        connected: null,
        account: null,
        count: scopedCount.get(item.source.key) ?? 0,
      });
    }
    return rows;
  }, [connections, items, entries, filter]);

  const byDay = useMemo(() => {
    const map = new Map<string, BoardEntry[]>();
    for (const item of visible) {
      if (!item.localDay) continue;
      const bucket = map.get(item.localDay);
      if (bucket) bucket.push(item);
      else map.set(item.localDay, [item]);
    }
    for (const bucket of map.values()) bucket.sort(byTime);
    return map;
  }, [visible]);
  const unscheduled = useMemo(
    () => visible.filter((i) => !i.localDay),
    [visible],
  );

  // Dar ekranda ızgara yalnız nokta gösterir; seçili günün listesi altta açılır.
  const defaultDay = days.some((d) => d.key === todayKey)
    ? todayKey
    : (days.find((d) => d.month === focusMonth) ?? days[0]!).key;
  const selectedDay =
    pickedDay && days.some((d) => d.key === pickedDay) ? pickedDay : defaultDay;

  // ── Yazma: taşı / planla ───────────────────────────────────────────────────
  // Yerel yeni hal ANINDA ekrana yazılır (durum aynı kurallarla istemcide
  // yeniden türetilir); arkada tek bir yazma gider. Sayfa yeniden render
  // edilmez. Hata olursa eski hale dönülür. Bir postun bütün mecraları
  // birlikte taşınır (sunucu da postu tek parça taşır); ret hepsini geri alır.
  const commitMove = async (
    item: BoardItem,
    localDateTime: string | null,
    restore = false,
  ) => {
    const previous =
      item.localDay && item.localTime
        ? `${item.localDay}T${item.localTime}`
        : null;
    const plan = reschedulePost(itemsRef.current, item, localDateTime, {
      timezone,
      scheduleEnabled,
      now: new Date(),
    });
    if (!plan.ok) {
      toast.error(plan.reason);
      return;
    }
    const moved = new Map<string, BoardItem>(
      plan.moved.map((next) => [next.id, { ...next, pending: true }]),
    );
    const before = new Map<string, BoardItem>(
      postGroupOf(itemsRef.current, item).map((prior) => [
        prior.id,
        { ...prior, pending: false },
      ]),
    );
    const write = (next: ReadonlyMap<string, BoardItem>) =>
      setItems((prev) => prev.map((i) => next.get(i.id) ?? i));
    const stamp = () => {
      const now = Date.now();
      for (const id of moved.keys()) stamps.current.set(id, now);
    };

    stamp();
    write(moved);
    busy.current += 1;
    let result: Awaited<ReturnType<typeof rescheduleCreativeAction>>;
    try {
      result = await rescheduleCreativeAction({
        creativeId: item.id,
        localDateTime,
        restore,
      });
    } catch {
      result = { ok: false, message: "Couldn't reach the server. Try again." };
    } finally {
      busy.current -= 1;
    }
    stamp();

    if (!result.ok) {
      toast.error(result.message);
      write(before);
      return;
    }
    const settled = new Map<string, BoardItem>(
      [...moved].map(([id, next]) => [id, { ...next, pending: false }]),
    );
    write(settled);
    const lead = settled.get(item.id) ?? item;
    toast.success(
      localDateTime
        ? `Moved to ${formatDayLong(localDateTime.slice(0, 10))} · ${localDateTime.slice(11, 16)}`
        : "Moved to Unscheduled",
      restore
        ? undefined
        : {
            action: {
              label: "Undo",
              onClick: () => void moveRef.current(lead, previous, true),
            },
          },
    );
  };
  // Kararlı sarmalayıcı: memo'lu çocuklara her render'da yeni işlev gitmesin.
  const moveRef = useRef(commitMove);
  useEffect(() => {
    moveRef.current = commitMove;
  });
  const onMove = useCallback(
    (item: BoardItem, localDateTime: string | null) =>
      void moveRef.current(item, localDateTime),
    [],
  );

  // ── Detay paneli: sunucuya gitmeden anında açılır ──────────────────────────
  const [openId, setOpenId] = useState<string | null>(
    props.initialOpenId ?? null,
  );
  const [details, setDetails] = useState<Record<string, CalendarDetail | null>>(
    {},
  );
  const fetchedAt = useRef(new Map<string, number>());

  const loadDetail = useCallback(
    (id: string, maxAgeMs: number) => {
      const at = fetchedAt.current.get(id);
      if (at !== undefined && Date.now() - at < maxAgeMs) return;
      fetchedAt.current.set(id, Date.now());
      void fetchDetail(projectId, id).then((detail) => {
        if (detail) {
          setDetails((prev) => ({ ...prev, [id]: detail }));
        } else {
          // Yüklenemedi: bir sonraki açılışta yeniden denensin.
          fetchedAt.current.delete(id);
          setDetails((prev) => (prev[id] ? prev : { ...prev, [id]: null }));
        }
      });
    },
    [projectId],
  );

  const openDetail = useCallback(
    (id: string) => {
      setOpenId(id);
      syncUrl(id);
      loadDetail(id, OPEN_FRESH_MS);
    },
    [loadDetail],
  );
  const closeDetail = useCallback(() => {
    setOpenId(null);
    syncUrl(null);
  }, []);

  // Sayfa doğrudan `?creative=` ile açıldıysa ayrıntıyı hemen iste.
  const initialOpen = props.initialOpenId;
  useEffect(() => {
    if (initialOpen) loadDetail(initialOpen, OPEN_FRESH_MS);
  }, [initialOpen, loadDetail]);

  // Fare bir kartta kısa süre durursa ayrıntı önceden çekilir: tıklayınca hazır.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const onHover = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;
      const id = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-item-id]",
      )?.dataset.itemId;
      clearTimeout(hoverTimer.current);
      if (id) {
        hoverTimer.current = setTimeout(
          () => loadDetail(id, HOVER_FRESH_MS),
          HOVER_INTENT_MS,
        );
      }
    },
    [loadDetail],
  );
  const onHoverEnd = useCallback(() => clearTimeout(hoverTimer.current), []);

  // Onay/ret ya da "paylaştım" sonrası: ayrıntıyı ve takvim verisini tazele.
  const onDecided = useCallback(() => {
    if (openId) {
      fetchedAt.current.delete(openId);
      loadDetail(openId, 0);
    }
    void refreshNow();
  }, [openId, loadDetail, refreshNow]);

  const openItem = openId ? items.find((i) => i.id === openId) : undefined;
  // Açık teslimatın postu: detayda mecralar arasında geçilir, panoda postun
  // kartı vurgulanır.
  const openDeliveries = useMemo(
    () => (openItem ? postGroupOf(items, openItem) : []),
    [items, openItem],
  );
  const openEntryId = openItem
    ? (entries.find((entry) =>
        entry.deliveries.some((delivery) => delivery.id === openItem.id),
      )?.id ?? null)
    : null;

  // ── Sürükle-bırak ──────────────────────────────────────────────────────────
  const [dragId, setDragId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    setDragId(null);
    setOverKey(null);
  }, []);

  const drag = useMemo<DragHandlers>(
    () => ({
      onDragStart(event, item) {
        if (!item.movable) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.setData(DRAG_TYPE, item.id);
        // Firefox, sürüklemenin başlaması için herhangi bir veri ister.
        event.dataTransfer.setData("text/plain", item.id);
        event.dataTransfer.effectAllowed = "move";
        dragRef.current = item.id;
        // Sürüklenen düğümü dragstart içinde değiştirmek bazı tarayıcılarda
        // sürüklemeyi iptal eder; görünüm değişimini bir sonraki tura bırak.
        setTimeout(() => setDragId(item.id), 0);
      },
      onDragEnd: endDrag,
    }),
    [endDrag],
  );

  const itemFromDrop = useCallback((event: DragEvent) => {
    const id =
      event.dataTransfer.getData(DRAG_TYPE) ||
      event.dataTransfer.getData("text/plain") ||
      dragRef.current;
    return id ? itemsRef.current.find((i) => i.id === id) : undefined;
  }, []);

  const dropOnDay = useCallback(
    (event: DragEvent, dayKey: string) => {
      event.preventDefault();
      const item = itemFromDrop(event);
      endDrag();
      if (!item || !item.movable || item.localDay === dayKey) return;
      const decision = resolveDrop({
        targetDay: dayKey,
        currentTime: item.localTime,
        nowLocal: utcToZonedDateTimeLocal(new Date(), timezone),
      });
      if (!decision.ok) {
        toast.error(decision.reason);
        return;
      }
      onMove(item, decision.localDateTime);
    },
    [itemFromDrop, endDrag, onMove, timezone],
  );

  const dropOnTray = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const item = itemFromDrop(event);
      endDrag();
      if (!item || !item.movable || !item.localDay) return;
      onMove(item, null);
    },
    [itemFromDrop, endDrag, onMove],
  );

  const toggleExpand = useCallback((dayKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dayKey)) next.delete(dayKey);
      else next.add(dayKey);
      return next;
    });
  }, []);

  const dragged = dragId ? entries.find((e) => e.id === dragId) : undefined;
  const filtersOn = stageFilter !== null || sourceFilter !== null;
  const scheduleOffNote =
    !scheduleEnabled &&
    items.some(
      (i) => i.stage === "held" && i.source.key === "instagram" && i.localDay,
    );
  const trayItems = trayAll ? unscheduled : unscheduled.slice(0, TRAY_LIMIT);
  const only = (list: BoardEntry[], id: string | null) =>
    id && list.some((i) => i.id === id) ? id : null;

  const cell = (day: BoardDay, cellView: CalendarView) => {
    const dayItems = byDay.get(day.key) ?? NO_ITEMS;
    return (
      <DayCell
        key={day.key}
        day={day}
        view={cellView}
        items={dayItems}
        inFocus={cellView === "week" ? true : day.month === focusMonth}
        todayKey={todayKey}
        dimmed={dragId !== null && !isDroppableDay(day.key, todayKey)}
        over={overKey === day.key}
        selected={cellView === "month" && day.key === selectedDay}
        expanded={cellView === "week" ? true : expanded.has(day.key)}
        activeId={only(dayItems, openEntryId)}
        draggingId={only(dayItems, dragId)}
        hrefPrefix={hrefs.creativePrefix}
        drag={drag}
        onOpen={openDetail}
        onSelect={setPickedDay}
        onToggleExpand={toggleExpand}
        onOver={setOverKey}
        onDropDay={dropOnDay}
      />
    );
  };

  return (
    <div className="space-y-4">
      {/* Gezinti ve görünüm */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <Link
            href={hrefs.prev}
            scroll={false}
            aria-label={view === "week" ? "Previous week" : "Previous month"}
            className={buttonVariants({ variant: "outline", size: "icon-sm" })}
          >
            <ChevronLeft className="size-4" />
          </Link>
          <h2 className="min-w-40 text-center font-heading text-lg font-semibold tracking-tight">
            {title}
          </h2>
          <Link
            href={hrefs.next}
            scroll={false}
            aria-label={view === "week" ? "Next week" : "Next month"}
            className={buttonVariants({ variant: "outline", size: "icon-sm" })}
          >
            <ChevronRight className="size-4" />
          </Link>
          <Link
            href={hrefs.today}
            scroll={false}
            aria-disabled={isCurrent}
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "ml-1",
              isCurrent && "pointer-events-none opacity-50",
            )}
          >
            Today
          </Link>
        </div>

        <div className="flex items-center gap-3">
          {/* Durağan nokta: sonsuz animasyon, arkada panel açıkken bile her
              karede yeniden boyama demekti. */}
          <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
            <span className="size-2 rounded-full bg-success" aria-hidden />
            Live
          </span>
          <div
            role="group"
            aria-label="Calendar view"
            className="inline-flex rounded-lg border border-border bg-muted/50 p-0.5"
          >
            {(["month", "week"] as const).map((v) => (
              <Link
                key={v}
                href={v === "month" ? hrefs.month : hrefs.week}
                scroll={false}
                aria-current={view === v ? "true" : undefined}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  view === v
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v === "month" ? "Month" : "2 weeks"}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Durum şeridi: ne durumda? (aynı zamanda gösterge ve süzgeç) */}
      {stageCounts.size > 0 || stageFilter ? (
        <div
          className="flex flex-wrap items-center gap-1.5"
          aria-label="Status"
        >
          {STAGE_ORDER.filter(
            (stage) => stageCounts.has(stage) || stage === stageFilter,
          ).map((stage) => {
            const stageMeta = STAGE_META[stage];
            const active = stageFilter === stage;
            return (
              <button
                key={stage}
                type="button"
                aria-pressed={active}
                title={stageMeta.hint}
                onClick={() => setStageFilter(active ? null : stage)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 transition",
                  active
                    ? "bg-foreground text-background ring-foreground"
                    : cn(TONE_PILL[stageMeta.tone], "hover:brightness-95"),
                )}
              >
                <StageIcon
                  stage={stage}
                  className={cn("size-3", active && "text-background")}
                />
                {stageMeta.label}
                <span className="tabular-nums opacity-80">
                  {stageCounts.get(stage) ?? 0}
                </span>
              </button>
            );
          })}
          {filtersOn ? (
            <button
              type="button"
              onClick={() => {
                setStageFilter(null);
                setSourceFilter(null);
              }}
              className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" /> Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Entegrasyon şeridi: nereye gidiyor, hesap bağlı mı? */}
      <div
        className="flex flex-wrap items-center gap-1.5"
        aria-label="Platforms"
      >
        {sourceRows.map((row) => {
          const active = sourceFilter === row.source.key;
          const missing = row.connected === false;
          return (
            <button
              key={row.source.key}
              type="button"
              aria-pressed={active}
              onClick={() => setSourceFilter(active ? null : row.source.key)}
              title={
                row.connected
                  ? `${row.source.label} connected${row.account ? ` as ${row.account}` : ""}`
                  : missing
                    ? `${row.source.label} isn't connected`
                    : row.source.label
              }
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border bg-card pr-3 pl-1.5 text-xs transition-colors",
                active
                  ? "border-foreground bg-accent"
                  : "border-border hover:bg-accent",
                missing && !active && "border-warning/40",
              )}
            >
              <SourceMark source={row.source} decorative className="size-5" />
              <span className="font-medium">{row.source.label}</span>
              {row.account ? (
                <span className="hidden max-w-28 truncate text-muted-foreground sm:inline">
                  {row.account}
                </span>
              ) : null}
              {row.connected !== null ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 text-[11px]",
                    row.connected ? "text-success" : "text-warning",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full",
                      row.connected ? "bg-success" : "bg-warning",
                    )}
                  />
                  {row.connected ? "Connected" : "Not connected"}
                </span>
              ) : null}
              <span className="tabular-nums text-muted-foreground">
                {row.count}
              </span>
            </button>
          );
        })}
        <Link
          href={hrefs.integrations}
          className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plug className="size-3.5" />
          Integrations
        </Link>
      </div>

      {scheduleOffNote ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
          <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
          <p className="min-w-0 flex-1 text-foreground">
            Scheduled posting is off, so approved Instagram posts with a date
            won&apos;t go out on their own.
          </p>
          <Link
            href={hrefs.settings}
            className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
          >
            <Settings2 className="size-3.5" /> Turn it on
          </Link>
        </div>
      ) : null}

      {/* Kart ve ızgara üstünde fare duruşu: ayrıntıyı önceden çeker */}
      <div
        className="space-y-4"
        onPointerOver={onHover}
        onPointerLeave={onHoverEnd}
      >
        {/* Günü atanmamışlar: buradan günlere sürükle, günden buraya bırakıp kaldır */}
        {unscheduled.length > 0 || dragged?.localDay ? (
          <section
            aria-label="Unscheduled"
            onDragOver={(event) => {
              if (
                !dragged?.localDay ||
                !event.dataTransfer.types.includes(DRAG_TYPE)
              ) {
                return;
              }
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setOverKey("tray");
            }}
            onDragLeave={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              )
                setOverKey(null);
            }}
            onDrop={dropOnTray}
            className={cn(
              "rounded-xl border bg-card p-3 transition-colors",
              overKey === "tray"
                ? "border-primary bg-primary/5"
                : dragged?.localDay
                  ? "border-dashed"
                  : "border-border",
            )}
          >
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="text-xs font-semibold">
                Unscheduled
                <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">
                  {unscheduled.length}
                </span>
              </h3>
              <p className="text-[11px] text-muted-foreground">
                {dragged?.localDay
                  ? "Drop here to take it off the calendar"
                  : "Drag a piece onto a day to schedule it"}
              </p>
            </div>
            {trayItems.length > 0 ? (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {trayItems.map((item) => (
                  <TrayCard
                    key={item.id}
                    item={item}
                    href={`${hrefs.creativePrefix}${item.id}`}
                    active={item.id === openEntryId}
                    dragging={item.id === dragId}
                    drag={drag}
                    onOpen={openDetail}
                  />
                ))}
                {!trayAll && unscheduled.length > TRAY_LIMIT ? (
                  <button
                    type="button"
                    onClick={() => setTrayAll(true)}
                    className="w-24 shrink-0 rounded-lg border border-dashed text-[11px] font-medium text-muted-foreground hover:bg-accent"
                  >
                    Show all {unscheduled.length}
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {items.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 px-4 py-3">
            <Inbox className="size-5 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Nothing planned here yet</p>
              <p className="text-xs text-muted-foreground">
                Plan a week of content in chat and every piece lands on its day.
              </p>
            </div>
            <Link
              href={hrefs.chat}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Sparkles className="size-3.5" /> Plan content
            </Link>
          </div>
        ) : null}

        {/* Izgara */}
        <div
          role="grid"
          aria-label={`${view === "week" ? "Two-week" : "Month"} calendar`}
          className="overflow-hidden rounded-xl border border-border bg-border"
        >
          {view === "month" ? (
            <div className="grid grid-cols-7 gap-px">
              {WEEKDAYS.map((label) => (
                <div
                  key={label}
                  className="bg-muted/50 px-2 py-1.5 text-center text-[11px] font-medium text-muted-foreground uppercase"
                >
                  <span className="md:hidden">{label[0]}</span>
                  <span className="hidden md:inline">{label}</span>
                </div>
              ))}
              {days.map((day) => cell(day, "month"))}
            </div>
          ) : (
            // İki hafta alt alta: her hafta kendi satırında, kendi başlığıyla.
            <div className="flex flex-col gap-px">
              {weekRows(days).map((row) => (
                <div key={row[0]!.key}>
                  <div className="flex items-center justify-between gap-2 bg-muted/50 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
                    <span className="uppercase">
                      {weekRowLabel(row, todayKey)}
                    </span>
                    <span>
                      {formatShortRange(row[0]!.key, row[row.length - 1]!.key)}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-px bg-border md:grid-cols-7">
                    {row.map((day) => cell(day, "week"))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Dar ekran: seçili günün listesi */}
        {view === "month" ? (
          <section aria-label="Selected day" className="space-y-2 md:hidden">
            <h3 className="text-xs font-semibold">
              {formatDayLong(selectedDay)}
              {selectedDay === todayKey ? (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  Today
                </span>
              ) : null}
            </h3>
            {(byDay.get(selectedDay) ?? NO_ITEMS).length > 0 ? (
              <div className="space-y-1.5">
                {(byDay.get(selectedDay) ?? NO_ITEMS).map((item) => (
                  <RichCard
                    key={item.id}
                    item={item}
                    href={`${hrefs.creativePrefix}${item.id}`}
                    active={item.id === openEntryId}
                    dragging={false}
                    drag={drag}
                    onOpen={openDetail}
                  />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Nothing planned for this day.
              </p>
            )}
          </section>
        ) : null}
      </div>

      {openItem ? (
        <CreativeDetail
          // Post başına anahtar: postun mecraları arasında geçince panel
          // yeniden açılıp kapanmaz.
          key={openItem.postId ?? openItem.id}
          item={openItem}
          deliveries={openDeliveries}
          onSwitch={openDetail}
          detail={details[openItem.id]}
          projectId={projectId}
          timezone={timezone}
          onSchedule={(localDateTime) => onMove(openItem, localDateTime)}
          onClose={closeDetail}
          onDecided={onDecided}
        />
      ) : null}
    </div>
  );
}

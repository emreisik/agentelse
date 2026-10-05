"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Inbox,
  LoaderCircle,
  Lock,
  Maximize2,
  Plug,
  Search,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";

import {
  DeliveryMarks,
  SourceMark,
  StageIcon,
  StagePill,
  ItemThumb,
  deliveriesText,
} from "@/components/calendar/calendar-bits";
import { DRAG_TYPE, WEEKDAYS } from "@/components/calendar/calendar-day";
import { fetchCalendar, fetchDetail } from "@/components/calendar/api";
import { CreativeDetail } from "@/components/calendar/creative-detail";
import {
  addDaysToKey,
  formatDayLong,
  formatShortRange,
  monthGridDays,
  parseDayKey,
  shiftMonthParam,
  weekGridDays,
  weekdayShort,
} from "@/lib/calendar/grid";
import {
  mergeFresh,
  reuseUnchanged,
  type ItemCache,
} from "@/lib/calendar/item";
import { isDroppableDay, resolveDrop } from "@/lib/calendar/move";
import {
  ATTENTION_STAGES,
  EMPTY_FILTER,
  GLYPH_LABEL,
  PANEL_SORTS,
  countEntries,
  dayDots,
  filterItems,
  groupForSort,
  isFiltering,
  relativeDayLabel,
  sortItems,
  type ItemGroup,
  type PanelFilter,
  type PanelSort,
} from "@/lib/calendar/panel-view";
import {
  deliveriesOf,
  groupPosts,
  postGroupOf,
  reschedulePost,
  sourcesOf,
  type EntryCache,
  type PostEntry,
} from "@/lib/calendar/posts";
import {
  STAGE_META,
  STAGE_ORDER,
  type CalendarStage,
} from "@/lib/calendar/stage";
import type {
  CalendarDetail,
  CalendarItem,
  CalendarPayload,
  CalendarSource,
} from "@/lib/calendar/types";
import type { FormatGlyph } from "@/lib/content-channels";
import { dayKeyInTimezone, utcToZonedDateTimeLocal } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { submitProjectCommandAction } from "@/server/actions/command-actions";
import { rescheduleCreativeAction } from "@/server/actions/creative-calendar-actions";

// Sağ panelin Calendar sekmesi: /takvim panosunun verisini (aynı hafif uç,
// aynı durum hesabı, aynı detay paneli) 400 px'lik panele sığdırır. Ay / Hafta
// / Liste görünümü, platform (entegrasyon) çoklu süzgeci, durum ve biçim
// süzgeçleri, arama, sıralama, sürükle-bırakla gün değiştirme. Gezinti ve
// süzgeçler tamamen istemcide: eskiden her ay değişimi (`?calMonth=`) proje
// sayfasını komple sunucuda yeniden render ediyordu. Panoda olduğu gibi post
// başına bir satır (docs/works.md "Posts"): mecraları simgeleriyle, süzgeçler
// teslimat başına; sürükleme bütün postu taşır.

type PanelView = "month" | "week" | "list";
type PanelItem = CalendarItem & { pending?: boolean };
export type PanelEntry = PostEntry<PanelItem>;

const POLL_MS = 30_000;
const STORAGE_PREFIX = "ws-calendar:";
const TRAY_LIMIT = 24;
const TRAY_KEY = "tray";

const VIEWS: readonly { key: PanelView; label: string }[] = [
  { key: "month", label: "Month" },
  { key: "week", label: "Week" },
  { key: "list", label: "List" },
];

const MONTH_TITLE = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

type Prefs = { view: PanelView; sort: PanelSort; sources: string[] };

function readPrefs(projectId: string): Partial<Prefs> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + projectId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      view: VIEWS.some((v) => v.key === parsed.view) ? parsed.view : undefined,
      sort: PANEL_SORTS.some((s) => s.key === parsed.sort)
        ? parsed.sort
        : undefined,
      sources: Array.isArray(parsed.sources)
        ? parsed.sources.filter((s): s is string => typeof s === "string")
        : undefined,
    };
  } catch {
    return {};
  }
}

function writePrefs(projectId: string, prefs: Prefs) {
  try {
    localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify(prefs));
  } catch {
    // Gizli pencere / engelli depolama: tercih yalnız bu oturumda kalır.
  }
}

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function headline(item: CalendarItem): string {
  return item.title ?? item.preview ?? item.label;
}

function isMulti(item: PanelEntry): boolean {
  return item.deliveries.length > 1;
}

// Satırın üstüne gelince okunan tam durum: postta her mecra kendi satırında.
function rowTitle(item: PanelEntry, when: string): string {
  const status = `${STAGE_META[item.stage].label}${item.reason ? ` — ${item.reason}` : ""}`;
  if (!isMulti(item)) {
    return [headline(item), `${item.label} · ${when}`, status].join("\n");
  }
  return [
    headline(item),
    `${when} · ${status}`,
    ...item.deliveries.map(
      (delivery) => `${delivery.label}: ${STAGE_META[delivery.stage].label}`,
    ),
  ].join("\n");
}

// Görünür aralık: ay görünümü ve liste ayın tam haftalarını, hafta görünümü
// Pazartesi-Pazar haftasını okur.
function rangeOf(view: PanelView, anchor: string) {
  const ymd = parseDayKey(anchor)!;
  if (view === "week") {
    const days = weekGridDays(ymd);
    return {
      days,
      focusMonth: null as number | null,
      title: formatShortRange(days[0]!.key, days[6]!.key),
    };
  }
  return {
    days: monthGridDays(ymd.year, ymd.month),
    focusMonth: ymd.month,
    title: MONTH_TITLE.format(new Date(Date.UTC(ymd.year, ymd.month - 1, 1))),
  };
}

function shiftAnchor(view: PanelView, anchor: string, delta: number): string {
  if (view === "week") return addDaysToKey(anchor, delta * 7) ?? anchor;
  const ymd = parseDayKey(anchor)!;
  return `${shiftMonthParam(ymd.year, ymd.month, delta)}-01`;
}

export function CalendarPanel({
  projectId,
  timezone,
}: {
  projectId: string;
  timezone: string;
}) {
  const [todayKey, setTodayKey] = useState(() =>
    dayKeyInTimezone(new Date(), timezone),
  );

  // ── Görünüm, gezinti, süzgeçler ────────────────────────────────────────────
  // Tercihler (görünüm, sıralama, platformlar) bu tarayıcıda hatırlanır. Panel
  // yalnız sekme açılınca bağlanır (Base UI pasif sekmeyi render etmez), yani
  // sunucu render'ıyla çakışmaz; sunucuda okuma sessizce boş döner.
  const [initialPrefs] = useState(() => readPrefs(projectId));
  const [view, setView] = useState<PanelView>(initialPrefs.view ?? "month");
  const [anchor, setAnchor] = useState(todayKey);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [filter, setFilter] = useState<PanelFilter>(() =>
    initialPrefs.sources?.length
      ? { ...EMPTY_FILTER, sources: new Set(initialPrefs.sources) }
      : EMPTY_FILTER,
  );
  const [sort, setSort] = useState<PanelSort>(initialPrefs.sort ?? "soonest");
  const [showFilters, setShowFilters] = useState(false);
  const [trayOpen, setTrayOpen] = useState(true);
  const [trayAll, setTrayAll] = useState(false);

  useEffect(() => {
    writePrefs(projectId, { view, sort, sources: [...filter.sources] });
  }, [projectId, view, sort, filter.sources]);

  const range = useMemo(() => rangeOf(view, anchor), [view, anchor]);
  const firstKey = range.days[0]!.key;
  const lastKey = range.days[range.days.length - 1]!.key;
  const containsToday = range.days.some(
    (d) =>
      d.key === todayKey &&
      (range.focusMonth === null || d.month === range.focusMonth),
  );

  // ── Veri: hafif uçtan okuma + yerel değişiklikler ──────────────────────────
  const [cache] = useState<ItemCache>(() => new Map());
  const [items, setItems] = useState<PanelItem[]>([]);
  const [meta, setMeta] = useState<{
    connections: CalendarPayload["connections"];
    scheduleEnabled: boolean;
  }>({ connections: [], scheduleEnabled: false });
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  // Ekrandaki verinin ait olduğu aralık; görünür aralıktan farklıysa yeni
  // aralık okunuyor demektir.
  const [loadedRange, setLoadedRange] = useState<string | null>(null);
  const rangeKey = `${firstKey}|${lastKey}`;
  const refreshing = loadedRange !== rangeKey;
  const stamps = useRef(new Map<string, number>());
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const busy = useRef(0);
  const dragRef = useRef<string | null>(null);

  // Post başına bir girdi; değişmeyen girdi aynı nesne kalır (memo'lu satırlar).
  const [entryCache] = useState<EntryCache<PanelItem>>(() => new Map());
  const entries = useMemo(
    () => groupPosts(items, entryCache),
    [items, entryCache],
  );

  const applyPayload = useCallback(
    (payload: CalendarPayload, loaded: string) => {
      setItems((prev) =>
        reuseUnchanged(mergeFresh(prev, payload, stamps.current), cache),
      );
      setMeta({
        connections: payload.connections,
        scheduleEnabled: payload.scheduleEnabled,
      });
      setStatus("ready");
      setLoadedRange(loaded);
    },
    [cache],
  );

  const settle = useCallback(
    (payload: CalendarPayload | null, loaded: string) => {
      if (payload) applyPayload(payload, loaded);
      else setStatus((prev) => (prev === "ready" ? prev : "error"));
    },
    [applyPayload],
  );
  const load = useCallback(async () => {
    settle(await fetchCalendar(projectId, firstKey, lastKey), rangeKey);
  }, [projectId, firstKey, lastKey, rangeKey, settle]);

  // Aralık değişince hemen oku (öncekini iptal et).
  useEffect(() => {
    const controller = new AbortController();
    void fetchCalendar(projectId, firstKey, lastKey, controller.signal).then(
      (payload) => {
        if (!controller.signal.aborted) settle(payload, rangeKey);
      },
    );
    return () => controller.abort();
  }, [projectId, firstKey, lastKey, rangeKey, settle]);

  // Hafif yoklama; sekme gizliyken, yazma ya da sürükleme sürerken durur.
  useEffect(() => {
    const tick = () => {
      if (document.hidden || busy.current > 0 || dragRef.current !== null) {
        return;
      }
      setTodayKey(dayKeyInTimezone(new Date(), timezone));
      void load();
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
  }, [load, timezone]);

  // ── Süzme ──────────────────────────────────────────────────────────────────
  // Ay görünümü ve liste yalnız odaktaki ayın günlerini sayar (ızgaranın
  // komşu ay günleri soluk gösterilir ama özete ve listeye girmez).
  const inFocus = useCallback(
    (item: CalendarItem) => {
      if (!item.localDay) return true;
      if (item.localDay < firstKey || item.localDay > lastKey) return false;
      if (range.focusMonth === null) return true;
      return Number(item.localDay.slice(5, 7)) === range.focusMonth;
    },
    [firstKey, lastKey, range.focusMonth],
  );
  const scoped = useMemo(() => entries.filter(inFocus), [entries, inFocus]);
  const visible = useMemo(() => filterItems(scoped, filter), [scoped, filter]);

  // Sayılar post sayar: bir post, uyan teslimatlarının her değerinde bir kez.
  const sourceCounts = useMemo(
    () => countEntries(scoped, filter, "sources", (d) => d.source.key),
    [scoped, filter],
  );
  const sourceTotal = useMemo(
    () => filterItems(scoped, filter, "sources").length,
    [scoped, filter],
  );
  const stagePool = useMemo(
    () => filterItems(scoped, filter, "stages"),
    [scoped, filter],
  );
  const stageCounts = useMemo(
    () => countEntries(scoped, filter, "stages", (d) => d.stage),
    [scoped, filter],
  );
  const glyphCounts = useMemo(
    () => countEntries(scoped, filter, "glyphs", (d) => d.glyph),
    [scoped, filter],
  );

  const scheduledVisible = useMemo(
    () => visible.filter((i) => i.localDay),
    [visible],
  );
  const unscheduled = useMemo(
    () =>
      sortItems(
        visible.filter((i) => !i.localDay),
        "soonest",
      ),
    [visible],
  );
  const byDay = useMemo(() => {
    const map = new Map<string, PanelEntry[]>();
    for (const item of sortItems(scheduledVisible, "soonest")) {
      const bucket = map.get(item.localDay!);
      if (bucket) bucket.push(item);
      else map.set(item.localDay!, [item]);
    }
    return map;
  }, [scheduledVisible]);
  // Ay ızgarasının noktaları odak dışı günleri de gösterir (soluk).
  const gridByDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const item of filterItems(entries, filter)) {
      if (!item.localDay) continue;
      const bucket = map.get(item.localDay);
      if (bucket) bucket.push(item);
      else map.set(item.localDay, [item]);
    }
    return map;
  }, [entries, filter]);

  // Platform şeridi: bağlı hesaplar + bu aralıkta parçası olan her kaynak.
  const sourceRows = useMemo(() => {
    type Row = {
      source: CalendarSource;
      connected: boolean | null;
      account: string | null;
    };
    const present = new Set(
      scoped.flatMap((entry) => sourcesOf(entry).map((source) => source.key)),
    );
    const rows: Row[] = meta.connections
      .filter(
        (c) =>
          c.connected ||
          present.has(c.source.key) ||
          filter.sources.has(c.source.key),
      )
      .map((c) => ({
        source: c.source,
        connected: c.connected,
        account: c.account,
      }));
    const known = new Set(meta.connections.map((c) => c.source.key));
    const seen = new Set<string>();
    for (const source of scoped.flatMap(sourcesOf)) {
      if (known.has(source.key) || seen.has(source.key)) continue;
      seen.add(source.key);
      rows.push({ source, connected: null, account: null });
    }
    return rows;
  }, [meta.connections, scoped, filter.sources]);

  const disconnectedWithPosts = sourceRows.filter(
    (row) => row.connected === false && (sourceCounts.get(row.source.key) ?? 0),
  );
  const scheduleOffNote =
    !meta.scheduleEnabled &&
    scoped.some((entry) =>
      deliveriesOf(entry).some(
        (d) => d.stage === "held" && d.source.key === "instagram" && d.localDay,
      ),
    );

  // Özet kutucukları: süzgeçlerin geri kalanına göre sayılır (durum hariç);
  // her kutucuk, dokununca kaç post göstereceğini söyler.
  const tiles = useMemo(() => {
    const count = (stages: ReadonlySet<CalendarStage>) =>
      filterItems(stagePool, { ...filter, stages }).length;
    return [
      {
        key: "all",
        label: "Planned",
        value: stagePool.length,
        stages: new Set<CalendarStage>(),
      },
      {
        key: "attention",
        label: "Needs you",
        value: count(ATTENTION_STAGES),
        stages: new Set(ATTENTION_STAGES),
        tone: "warn" as const,
      },
      {
        key: "scheduled",
        label: "Scheduled",
        value: count(new Set<CalendarStage>(["scheduled", "publishing"])),
        stages: new Set<CalendarStage>(["scheduled", "publishing"]),
      },
      {
        key: "published",
        label: "Published",
        value: count(new Set<CalendarStage>(["published"])),
        stages: new Set<CalendarStage>(["published"]),
      },
    ];
  }, [stagePool, filter]);
  const sameSet = (
    a: ReadonlySet<CalendarStage>,
    b: ReadonlySet<CalendarStage>,
  ) => a.size === b.size && [...a].every((x) => b.has(x));

  const problems = useMemo(
    () =>
      filterItems(stagePool, {
        ...filter,
        stages: new Set<CalendarStage>(["failed", "missed"]),
      }).length,
    [stagePool, filter],
  );

  // ── Yazma: taşı / planla (iyimser, geri alınabilir) ────────────────────────
  // Bir postun bütün mecraları birlikte taşınır; ret hepsini geri alır.
  const commitMove = async (
    item: PanelItem,
    localDateTime: string | null,
    restore = false,
  ) => {
    const previous =
      item.localDay && item.localTime
        ? `${item.localDay}T${item.localTime}`
        : null;
    const plan = reschedulePost(itemsRef.current, item, localDateTime, {
      timezone,
      scheduleEnabled: meta.scheduleEnabled,
      now: new Date(),
    });
    if (!plan.ok) {
      toast.error(plan.reason);
      return;
    }
    const moved = new Map<string, PanelItem>(
      plan.moved.map((next) => [next.id, { ...next, pending: true }]),
    );
    const before = new Map<string, PanelItem>(
      postGroupOf(itemsRef.current, item).map((prior) => [
        prior.id,
        { ...prior, pending: false },
      ]),
    );
    const write = (next: ReadonlyMap<string, PanelItem>) =>
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
    const settled = new Map<string, PanelItem>(
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
  const moveRef = useRef(commitMove);
  useEffect(() => {
    moveRef.current = commitMove;
  });
  const onMove = useCallback(
    (item: PanelItem, localDateTime: string | null) =>
      void moveRef.current(item, localDateTime),
    [],
  );

  // ── Detay paneli (/takvim ile aynı) ────────────────────────────────────────
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, CalendarDetail | null>>(
    {},
  );
  const loadDetail = useCallback(
    (id: string) => {
      void fetchDetail(projectId, id).then((detail) =>
        setDetails((prev) => ({ ...prev, [id]: detail })),
      );
    },
    [projectId],
  );
  const openDetail = (id: string) => {
    setOpenId(id);
    loadDetail(id);
  };
  const onDecided = useCallback(() => {
    if (openId) loadDetail(openId);
    void load();
  }, [openId, loadDetail, load]);
  const openItem = openId ? items.find((i) => i.id === openId) : undefined;
  const openDeliveries = useMemo(
    () => (openItem ? postGroupOf(items, openItem) : []),
    [items, openItem],
  );

  // ── Sürükle-bırak ──────────────────────────────────────────────────────────
  const [dragId, setDragId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const endDrag = useCallback(() => {
    dragRef.current = null;
    setDragId(null);
    setOverKey(null);
  }, []);
  const onDragStart = useCallback((event: DragEvent, item: PanelEntry) => {
    if (!item.movable) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(DRAG_TYPE, item.id);
    event.dataTransfer.setData("text/plain", item.id);
    event.dataTransfer.effectAllowed = "move";
    dragRef.current = item.id;
    setTimeout(() => setDragId(item.id), 0);
  }, []);
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
  // Her bırakma alanı (gün hücresi, hafta günü, tepsi) aynı sabit işleyicileri
  // alır; hangi alan olduğu `data-drop-key`ten okunur.
  const zone = useMemo<DropZone>(
    () => ({
      onDragOver(event) {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const key = event.currentTarget.dataset.dropKey ?? null;
        setOverKey((prev) => (prev === key ? prev : key));
      },
      onDragLeave(event) {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          const key = event.currentTarget.dataset.dropKey;
          setOverKey((prev) => (prev === key ? null : prev));
        }
      },
      onDrop(event) {
        const key = event.currentTarget.dataset.dropKey;
        if (key === TRAY_KEY) dropOnTray(event);
        else if (key) dropOnDay(event, key);
      },
    }),
    [dropOnDay, dropOnTray],
  );
  const dragged = dragId ? entries.find((e) => e.id === dragId) : undefined;

  const rowProps = {
    projectId,
    todayKey,
    openId,
    dragId,
    onOpen: openDetail,
    onDragStart,
    onDragEnd: endDrag,
  };

  // ── Gezinti ────────────────────────────────────────────────────────────────
  const goto = (nextAnchor: string) => {
    setAnchor(nextAnchor);
    setPickedDay(null);
  };
  const changeView = (next: PanelView) => {
    if (next === view) return;
    // Bağlamı koru: aydan haftaya geçerken bugün bu aydaysa bugünün haftası,
    // değilse seçili gün ya da ayın ilk günü.
    if (next === "week") {
      setAnchor(pickedDay ?? (containsToday ? todayKey : anchor));
    } else if (view === "week") {
      setAnchor(range.days[3]!.key);
    }
    setView(next);
    setPickedDay(null);
  };
  const selectedDay =
    view === "month" && pickedDay && range.days.some((d) => d.key === pickedDay)
      ? pickedDay
      : null;

  const activeFilterCount =
    filter.stages.size + filter.glyphs.size + (filter.query.trim() ? 1 : 0);
  const anyFilter = isFiltering(filter);
  const glyphs = [...glyphCounts.keys()] as FormatGlyph[];
  const stagesShown = STAGE_ORDER.filter(
    (s) => stageCounts.has(s) || filter.stages.has(s),
  );

  return (
    <div className="flex flex-col gap-3 px-4 py-4 text-sm">
      {/* Başlık */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div
            className="text-[10px] font-semibold tracking-[0.1em]"
            style={{ color: "var(--ws-text-3)" }}
          >
            CONTENT CALENDAR
          </div>
          <div
            className="mt-0.5 text-base font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            Everything, on time.
          </div>
        </div>
        <div className="flex items-center gap-1">
          {refreshing && status === "ready" ? (
            <LoaderCircle
              aria-label="Refreshing"
              className="size-3.5 animate-spin"
              style={{ color: "var(--ws-text-3)" }}
            />
          ) : null}
          <Link
            href={`/projects/${projectId}/takvim`}
            title="Open the full calendar"
            aria-label="Open the full calendar"
            className="flex size-7 items-center justify-center rounded-full transition-colors hover:bg-[var(--ws-hover)]"
            style={{ color: "var(--ws-text-2)" }}
          >
            <Maximize2 className="size-3.5" />
          </Link>
        </div>
      </div>

      {/* Özet: aynı zamanda hızlı durum süzgeci */}
      <div className="grid grid-cols-4 gap-1.5" aria-label="Summary">
        {tiles.map((tile) => {
          const active =
            tile.key === "all"
              ? filter.stages.size === 0
              : sameSet(filter.stages, tile.stages);
          return (
            <button
              key={tile.key}
              type="button"
              aria-pressed={active}
              onClick={() =>
                setFilter((prev) => ({
                  ...prev,
                  stages:
                    tile.key === "all" || active
                      ? new Set()
                      : new Set(tile.stages),
                }))
              }
              className="flex flex-col items-start rounded-xl border px-2 py-1.5 text-left transition-colors hover:bg-[var(--ws-hover)]"
              style={{
                borderColor: active ? "var(--ws-text)" : "var(--ws-border)",
                background: active ? "var(--ws-hover)" : undefined,
              }}
            >
              <span
                className={cn(
                  "text-base leading-tight font-semibold tabular-nums",
                  tile.tone === "warn" && tile.value > 0 && "text-warning",
                )}
                style={
                  tile.tone === "warn" && tile.value > 0
                    ? undefined
                    : { color: "var(--ws-text)" }
                }
              >
                {status === "loading" ? "–" : tile.value}
              </span>
              <span
                className="truncate text-[10px]"
                style={{ color: "var(--ws-text-3)" }}
              >
                {tile.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Gezinti + görünüm */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-0.5">
          <IconButton
            label={view === "week" ? "Previous week" : "Previous month"}
            onClick={() => goto(shiftAnchor(view, anchor, -1))}
          >
            <ChevronLeft className="size-3.5" />
          </IconButton>
          <span
            className="min-w-0 truncate px-1 text-xs font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {range.title}
          </span>
          <IconButton
            label={view === "week" ? "Next week" : "Next month"}
            onClick={() => goto(shiftAnchor(view, anchor, 1))}
          >
            <ChevronRight className="size-3.5" />
          </IconButton>
          <button
            type="button"
            disabled={containsToday && !selectedDay}
            onClick={() => goto(todayKey)}
            className="ml-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors hover:bg-[var(--ws-hover)] disabled:opacity-40"
            style={{
              borderColor: "var(--ws-border)",
              color: "var(--ws-text-2)",
            }}
          >
            Today
          </button>
        </div>
        <div
          role="group"
          aria-label="Calendar view"
          className="flex shrink-0 rounded-lg p-0.5"
          style={{ background: "var(--ws-surface-2)" }}
        >
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              aria-pressed={view === v.key}
              onClick={() => changeView(v.key)}
              className="rounded-md px-2 py-0.5 text-[10.5px] font-medium transition-colors"
              style={
                view === v.key
                  ? {
                      background: "var(--ws-surface)",
                      color: "var(--ws-text)",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                    }
                  : { color: "var(--ws-text-3)" }
              }
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* Platformlar: nereye gidiyor, hesap bağlı mı? (çoklu seçim) */}
      <div
        className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5"
        aria-label="Platforms"
      >
        <Chip
          active={filter.sources.size === 0}
          onClick={() => setFilter((prev) => ({ ...prev, sources: new Set() }))}
        >
          All
          <Count>{sourceTotal}</Count>
        </Chip>
        {sourceRows.map((row) => {
          const active = filter.sources.has(row.source.key);
          return (
            <Chip
              key={row.source.key}
              active={active}
              onClick={() =>
                setFilter((prev) => ({
                  ...prev,
                  sources: toggled(prev.sources, row.source.key),
                }))
              }
              title={
                row.connected
                  ? `${row.source.label} connected${row.account ? ` as ${row.account}` : ""}`
                  : row.connected === false
                    ? `${row.source.label} isn't connected`
                    : row.source.label
              }
            >
              <span className="relative inline-flex">
                <SourceMark
                  source={row.source}
                  decorative
                  className="size-4 rounded"
                />
                {row.connected !== null ? (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-[var(--ws-surface)]",
                      row.connected ? "bg-success" : "bg-warning",
                    )}
                  />
                ) : null}
              </span>
              {row.source.label}
              <Count>{sourceCounts.get(row.source.key) ?? 0}</Count>
            </Chip>
          );
        })}
      </div>

      {/* Arama + süzgeçler + sıralama */}
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
            onChange={(event) =>
              setFilter((prev) => ({ ...prev, query: event.target.value }))
            }
            placeholder="Search posts"
            aria-label="Search posts"
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
              activeFilterCount > 0 ? "var(--ws-text)" : "var(--ws-border)",
            color: "var(--ws-text-2)",
          }}
        >
          <SlidersHorizontal className="size-3.5" />
          Filters
          {activeFilterCount > 0 ? (
            <span
              className="rounded-full px-1.5 text-[10px] font-semibold tabular-nums"
              style={{
                background: "var(--ws-accent)",
                color: "var(--ws-on-accent)",
              }}
            >
              {activeFilterCount}
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
          <FilterGroup label="Status">
            {stagesShown.length === 0 ? (
              <Muted>No posts in this range.</Muted>
            ) : (
              stagesShown.map((stage) => (
                <Chip
                  key={stage}
                  small
                  active={filter.stages.has(stage)}
                  title={STAGE_META[stage].hint}
                  onClick={() =>
                    setFilter((prev) => ({
                      ...prev,
                      stages: toggled(prev.stages, stage),
                    }))
                  }
                >
                  <StageIcon stage={stage} className="size-3" />
                  {STAGE_META[stage].label}
                  <Count>{stageCounts.get(stage) ?? 0}</Count>
                </Chip>
              ))
            )}
          </FilterGroup>
          {glyphs.length > 0 ? (
            <FilterGroup label="Format">
              {glyphs.map((glyph) => (
                <Chip
                  key={glyph}
                  small
                  active={filter.glyphs.has(glyph)}
                  onClick={() =>
                    setFilter((prev) => ({
                      ...prev,
                      glyphs: toggled(prev.glyphs, glyph),
                    }))
                  }
                >
                  {GLYPH_LABEL[glyph]}
                  <Count>{glyphCounts.get(glyph) ?? 0}</Count>
                </Chip>
              ))}
            </FilterGroup>
          ) : null}
          <FilterGroup label="Sort">
            {PANEL_SORTS.map((option) => (
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
          {anyFilter ? (
            <button
              type="button"
              onClick={() => setFilter(EMPTY_FILTER)}
              className="inline-flex items-center gap-1 text-[11px] font-medium underline-offset-2 hover:underline"
              style={{ color: "var(--ws-text-2)" }}
            >
              <X className="size-3" /> Clear all filters
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Uyarılar */}
      {problems > 0 && !filter.stages.has("failed") ? (
        <Notice tone="danger">
          <span className="min-w-0 flex-1">
            {problems === 1
              ? "1 post failed or was missed."
              : `${problems} posts failed or were missed.`}
          </span>
          <button
            type="button"
            onClick={() =>
              setFilter((prev) => ({
                ...prev,
                stages: new Set<CalendarStage>(["failed", "missed"]),
              }))
            }
            className="shrink-0 font-medium underline underline-offset-2"
          >
            Show
          </button>
        </Notice>
      ) : null}
      {disconnectedWithPosts.length > 0 ? (
        <Notice tone="warn">
          <span className="min-w-0 flex-1">
            {disconnectedWithPosts.map((r) => r.source.label).join(", ")}{" "}
            {disconnectedWithPosts.length === 1 ? "isn't" : "aren't"} connected,
            so those posts can&apos;t go out.
          </span>
          <Link
            href={`/projects/${projectId}/integrations`}
            className="inline-flex shrink-0 items-center gap-1 font-medium underline underline-offset-2"
          >
            <Plug className="size-3" /> Connect
          </Link>
        </Notice>
      ) : null}
      {scheduleOffNote ? (
        <Notice tone="warn">
          <span className="min-w-0 flex-1">
            Scheduled posting is off, so approved Instagram posts won&apos;t go
            out on their own.
          </span>
          <Link
            href={`/projects/${projectId}/ayarlar`}
            className="shrink-0 font-medium underline underline-offset-2"
          >
            Turn on
          </Link>
        </Notice>
      ) : null}

      {status === "loading" ? (
        <PanelSkeleton />
      ) : status === "error" ? (
        <div
          className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-xs"
          style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
        >
          Couldn&apos;t load the calendar.
          <button
            type="button"
            onClick={() => {
              setStatus("loading");
              void load();
            }}
            className="font-medium underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {view === "month" ? (
            <MonthGrid
              days={range.days}
              focusMonth={range.focusMonth}
              todayKey={todayKey}
              selectedDay={selectedDay}
              byDay={gridByDay}
              dragging={dragged !== undefined}
              overKey={overKey}
              onSelect={(key) => {
                // Komşu ayın soluk günü: o aya geç ve günü seç.
                if (Number(key.slice(5, 7)) !== range.focusMonth) {
                  setAnchor(key);
                  setPickedDay(key);
                  return;
                }
                setPickedDay((prev) => (prev === key ? null : key));
              }}
              zone={zone}
            />
          ) : null}

          {view === "week" ? (
            <div className="flex flex-col gap-1.5">
              {range.days.map((day) => {
                const dayItems = byDay.get(day.key) ?? [];
                const droppable = isDroppableDay(day.key, todayKey);
                const relative = relativeDayLabel(
                  day.key,
                  todayKey,
                  addDaysToKey,
                );
                return (
                  <section
                    key={day.key}
                    aria-label={formatDayLong(day.key)}
                    data-drop-key={day.key}
                    {...(droppable ? zone : {})}
                    className={cn(
                      "rounded-xl border p-2 transition-colors",
                      dragged && !droppable && "opacity-40",
                    )}
                    style={{
                      borderColor:
                        overKey === day.key
                          ? "var(--ws-accent)"
                          : "var(--ws-border)",
                      borderStyle: dragged && droppable ? "dashed" : undefined,
                      background:
                        overKey === day.key
                          ? "var(--ws-soft-green)"
                          : day.key === todayKey
                            ? "var(--ws-surface-2)"
                            : undefined,
                    }}
                  >
                    <DayHeader
                      day={day.key}
                      relative={relative}
                      count={dayItems.length}
                    />
                    {dayItems.length > 0 ? (
                      <div className="mt-1.5 flex flex-col gap-1">
                        {dayItems.map((item) => (
                          <ItemRow key={item.id} item={item} {...rowProps} />
                        ))}
                      </div>
                    ) : (
                      <p
                        className="mt-1 text-[11px]"
                        style={{ color: "var(--ws-text-3)" }}
                      >
                        {dragged && droppable ? "Drop here" : "Nothing planned"}
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
          ) : null}

          {view !== "week" ? (
            selectedDay ? (
              <section aria-label="Selected day" className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <DayHeader
                    day={selectedDay}
                    relative={relativeDayLabel(
                      selectedDay,
                      todayKey,
                      addDaysToKey,
                    )}
                    count={(byDay.get(selectedDay) ?? []).length}
                  />
                  <button
                    type="button"
                    onClick={() => setPickedDay(null)}
                    className="text-[11px] font-medium underline-offset-2 hover:underline"
                    style={{ color: "var(--ws-text-2)" }}
                  >
                    Whole month
                  </button>
                </div>
                {(byDay.get(selectedDay) ?? []).length > 0 ? (
                  <div className="flex flex-col gap-1">
                    {(byDay.get(selectedDay) ?? []).map((item) => (
                      <ItemRow key={item.id} item={item} {...rowProps} />
                    ))}
                  </div>
                ) : (
                  <Muted>
                    {isDroppableDay(selectedDay, todayKey)
                      ? "Nothing planned. Drag a post onto this day to schedule it."
                      : "Nothing was planned for this day."}
                  </Muted>
                )}
              </section>
            ) : (
              <GroupedList
                groups={groupForSort(scheduledVisible, sort)}
                todayKey={todayKey}
                empty={
                  scoped.length === 0
                    ? "Nothing planned this month yet."
                    : "No posts match these filters."
                }
                rowProps={rowProps}
              />
            )
          ) : null}

          {/* Günü atanmamışlar: günlere sürükle; günden buraya bırakınca gün kalkar */}
          {unscheduled.length > 0 || dragged?.localDay ? (
            <section
              aria-label="Unscheduled"
              data-drop-key={TRAY_KEY}
              {...(dragged?.localDay ? zone : {})}
              className="rounded-xl border p-2.5 transition-colors"
              style={{
                borderColor:
                  overKey === TRAY_KEY ? "var(--ws-accent)" : "var(--ws-border)",
                borderStyle: dragged?.localDay ? "dashed" : undefined,
                background:
                  overKey === TRAY_KEY ? "var(--ws-soft-green)" : undefined,
              }}
            >
              <button
                type="button"
                onClick={() => setTrayOpen((v) => !v)}
                aria-expanded={trayOpen}
                className="flex w-full items-center justify-between gap-2"
              >
                <span
                  className="text-[10px] font-semibold tracking-[0.1em]"
                  style={{ color: "var(--ws-text-3)" }}
                >
                  UNSCHEDULED · {unscheduled.length}
                </span>
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform",
                    !trayOpen && "-rotate-90",
                  )}
                  style={{ color: "var(--ws-text-3)" }}
                />
              </button>
              {trayOpen ? (
                <>
                  <p
                    className="mt-0.5 text-[10.5px]"
                    style={{ color: "var(--ws-text-3)" }}
                  >
                    {dragged?.localDay
                      ? "Drop here to take it off the calendar"
                      : "Drag one onto a day, or open it to pick a time"}
                  </p>
                  <div className="mt-2 flex flex-col gap-1">
                    {(trayAll
                      ? unscheduled
                      : unscheduled.slice(0, TRAY_LIMIT)
                    ).map((item) => (
                      <ItemRow key={item.id} item={item} {...rowProps} />
                    ))}
                    {!trayAll && unscheduled.length > TRAY_LIMIT ? (
                      <button
                        type="button"
                        onClick={() => setTrayAll(true)}
                        className="rounded-lg border border-dashed py-1.5 text-[11px] font-medium hover:bg-[var(--ws-hover)]"
                        style={{
                          borderColor: "var(--ws-border)",
                          color: "var(--ws-text-2)",
                        }}
                      >
                        Show all {unscheduled.length}
                      </button>
                    ) : null}
                  </div>
                </>
              ) : null}
            </section>
          ) : null}
        </>
      )}

      <div className="flex gap-1.5">
        <form action={submitProjectCommandAction} className="flex-1">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="text" value="Plan this week" />
          <button
            type="submit"
            className="w-full rounded-xl border px-3 py-2.5 text-center text-xs font-medium transition-colors hover:bg-[var(--ws-hover)]"
            style={{ borderColor: "var(--ws-border)", color: "var(--ws-text)" }}
          >
            + Prepare a weekly plan
          </button>
        </form>
        <Link
          href={`/projects/${projectId}/takvim`}
          className="flex items-center rounded-xl border px-3 text-xs font-medium transition-colors hover:bg-[var(--ws-hover)]"
          style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
        >
          Full calendar
        </Link>
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
          timezone={timezone}
          todayKey={todayKey}
          onSchedule={(localDateTime) => onMove(openItem, localDateTime)}
          onClose={() => setOpenId(null)}
          onDecided={onDecided}
        />
      ) : null}
    </div>
  );
}

// ── Parçalar ──────────────────────────────────────────────────────────────────

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--ws-hover)]"
      style={{ color: "var(--ws-text-2)" }}
    >
      {children}
    </button>
  );
}

function Chip({
  active,
  onClick,
  title,
  small = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
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

function Count({ children }: { children: ReactNode }) {
  return (
    <span className="tabular-nums" style={{ color: "var(--ws-text-3)" }}>
      {children}
    </span>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
      {children}
    </p>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
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

function Notice({
  tone,
  children,
}: {
  tone: "warn" | "danger";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] leading-snug",
        tone === "danger"
          ? "border-destructive/25 bg-destructive/5 text-destructive"
          : "border-warning/30 bg-warning/10 text-foreground",
      )}
    >
      <TriangleAlert
        aria-hidden
        className={cn(
          "mt-px size-3.5 shrink-0",
          tone === "danger" ? "text-destructive" : "text-warning",
        )}
      />
      {children}
    </div>
  );
}

function DayHeader({
  day,
  relative,
  count,
}: {
  day: string;
  relative: string | null;
  count: number;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span
        className="text-[11px] font-semibold"
        style={{ color: "var(--ws-text)" }}
      >
        {relative ?? weekdayShort(day)}
      </span>
      <span className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
        {formatDayLong(day).replace(/^\w+, /, "")}
      </span>
      {count > 0 ? (
        <span
          className="text-[10px] tabular-nums"
          style={{ color: "var(--ws-text-3)" }}
        >
          · {count}
        </span>
      ) : null}
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      <div
        className="h-52 animate-pulse rounded-xl"
        style={{ background: "var(--ws-surface-2)" }}
      />
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-12 animate-pulse rounded-xl"
          style={{ background: "var(--ws-surface-2)" }}
        />
      ))}
    </div>
  );
}

type DropZone = {
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
};

function MonthGrid({
  days,
  focusMonth,
  todayKey,
  selectedDay,
  byDay,
  dragging,
  overKey,
  onSelect,
  zone,
}: {
  days: readonly { key: string; day: number; month: number }[];
  focusMonth: number | null;
  todayKey: string;
  selectedDay: string | null;
  byDay: ReadonlyMap<string, CalendarItem[]>;
  dragging: boolean;
  overKey: string | null;
  onSelect: (key: string) => void;
  zone: DropZone;
}) {
  return (
    <div
      role="grid"
      aria-label="Month"
      className="grid grid-cols-7 gap-0.5 rounded-xl border p-1"
      style={{ borderColor: "var(--ws-border)" }}
    >
      {WEEKDAYS.map((label) => (
        <span
          key={label}
          className="py-0.5 text-center text-[9px] font-medium"
          style={{ color: "var(--ws-text-3)" }}
        >
          {label.slice(0, 2)}
        </span>
      ))}
      {days.map((day) => {
        const dayItems = byDay.get(day.key) ?? [];
        const dots = dayDots(dayItems);
        const isToday = day.key === todayKey;
        const outside = focusMonth !== null && day.month !== focusMonth;
        const past = day.key < todayKey;
        const droppable = isDroppableDay(day.key, todayKey);
        const selected = selectedDay === day.key;
        return (
          <button
            key={day.key}
            type="button"
            role="gridcell"
            aria-selected={selected}
            aria-label={`${formatDayLong(day.key)}${dots.total ? `, ${dots.total} posts` : ""}`}
            onClick={() => onSelect(day.key)}
            data-drop-key={day.key}
            {...(droppable ? zone : {})}
            className={cn(
              "relative flex h-11 flex-col items-center justify-start gap-0.5 rounded-lg pt-1 transition-colors hover:bg-[var(--ws-hover)]",
              outside && "opacity-40",
              dragging && !droppable && "opacity-25",
            )}
            style={{
              background:
                overKey === day.key
                  ? "var(--ws-soft-green)"
                  : selected
                    ? "var(--ws-hover)"
                    : undefined,
              boxShadow:
                selected || overKey === day.key
                  ? "inset 0 0 0 1px var(--ws-text)"
                  : dragging && droppable
                    ? "inset 0 0 0 1px var(--ws-border)"
                    : undefined,
            }}
          >
            <span
              className="flex size-5 items-center justify-center rounded-full text-[11px] tabular-nums"
              style={
                isToday
                  ? {
                      background: "var(--ws-accent)",
                      color: "var(--ws-on-accent)",
                      fontWeight: 600,
                    }
                  : {
                      color: past ? "var(--ws-text-3)" : "var(--ws-text-2)",
                    }
              }
            >
              {day.day}
            </span>
            {dots.total > 0 ? (
              <span className="flex items-center gap-0.5">
                {dots.colors.map((color) => (
                  <span
                    key={color}
                    className="size-1.5 rounded-full"
                    style={{ background: color }}
                  />
                ))}
                {dots.total > dots.colors.length ? (
                  <span
                    className="text-[8px] leading-none tabular-nums"
                    style={{ color: "var(--ws-text-3)" }}
                  >
                    {dots.total}
                  </span>
                ) : null}
              </span>
            ) : null}
            {dots.attention ? (
              <span
                aria-hidden
                className="absolute top-1 right-1 size-1.5 rounded-full bg-destructive"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

type RowProps = {
  projectId: string;
  todayKey: string;
  // Açık teslimatın kimliği: postunun satırı vurgulanır.
  openId: string | null;
  dragId: string | null;
  onOpen: (id: string) => void;
  onDragStart: (event: DragEvent, item: PanelEntry) => void;
  onDragEnd: () => void;
};

function GroupedList({
  groups,
  todayKey,
  empty,
  rowProps,
}: {
  groups: ItemGroup<PanelEntry>[];
  todayKey: string;
  empty: string;
  rowProps: RowProps;
}) {
  if (groups.length === 0) {
    return (
      <div
        className="flex items-center gap-2.5 rounded-xl border border-dashed px-3 py-3"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <Inbox
          className="size-4 shrink-0"
          style={{ color: "var(--ws-text-3)" }}
        />
        <Muted>{empty}</Muted>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const first = group.items[0]!;
        return (
          <section key={`${group.kind}-${group.key}`} className="space-y-1">
            {group.kind === "day" ? (
              <DayHeader
                day={group.key}
                relative={relativeDayLabel(group.key, todayKey, addDaysToKey)}
                count={group.items.length}
              />
            ) : (
              <div className="flex items-center gap-1.5">
                {group.kind === "stage" ? (
                  <StageIcon stage={first.stage} className="size-3" />
                ) : (
                  sourcesOf(first).map((source) => (
                    <SourceMark
                      key={source.key}
                      source={source}
                      decorative
                      className="size-3.5 rounded"
                    />
                  ))
                )}
                <span
                  className="text-[11px] font-semibold"
                  style={{ color: "var(--ws-text)" }}
                >
                  {group.kind === "stage"
                    ? STAGE_META[first.stage].label
                    : sourcesOf(first)
                        .map((source) => source.label)
                        .join(" + ")}
                </span>
                <span
                  className="text-[10px] tabular-nums"
                  style={{ color: "var(--ws-text-3)" }}
                >
                  · {group.items.length}
                </span>
              </div>
            )}
            <div className="flex flex-col gap-1">
              {group.items.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  showDate={group.kind !== "day"}
                  {...rowProps}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const EXPLAIN: ReadonlySet<CalendarStage> = new Set([
  "failed",
  "missed",
  "held",
]);

// Bir post (ya da postu olmayan tek parça) satırı: tıklayınca ilk mecranın
// detayı; taşınabilirse sürüklenir ve bütün post taşınır. Cmd/Ctrl+tık tam
// takvimde açar (gerçek adres).
export const ItemRow = memo(function ItemRow({
  item,
  projectId,
  todayKey,
  openId,
  dragId,
  showDate = false,
  onOpen,
  onDragStart,
  onDragEnd,
}: RowProps & { item: PanelEntry; showDate?: boolean }) {
  const active =
    openId !== null && item.deliveries.some((delivery) => delivery.id === openId);
  const dragging = dragId === item.id;
  const multi = isMulti(item);
  const when = item.localDay
    ? [
        showDate
          ? (relativeDayLabel(item.localDay, todayKey, addDaysToKey) ??
            formatDayLong(item.localDay))
          : null,
        item.localTime,
      ]
        .filter(Boolean)
        .join(" · ")
    : "No day yet";
  const onClick = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
      return;
    event.preventDefault();
    onOpen(item.id);
  };
  return (
    <a
      href={`/projects/${projectId}/takvim?creative=${item.id}`}
      onClick={onClick}
      draggable={item.movable}
      onDragStart={(event) => onDragStart(event, item)}
      onDragEnd={onDragEnd}
      title={rowTitle(item, when)}
      aria-label={
        multi
          ? `${headline(item)}, ${when}, ${STAGE_META[item.stage].label}. ${deliveriesText(item.deliveries)}`
          : undefined
      }
      className={cn(
        "group flex items-center gap-2.5 rounded-xl border px-2 py-1.5 transition-colors hover:bg-[var(--ws-hover)]",
        item.movable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        (dragging || item.pending) && "opacity-50",
      )}
      style={{
        borderColor: active ? "var(--ws-text)" : "var(--ws-border)",
        background: active ? "var(--ws-hover)" : "var(--ws-surface)",
      }}
    >
      <ItemThumb
        assetId={item.assetId}
        source={item.source}
        badge={!multi}
        className="size-9"
      />
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-xs font-medium"
          style={{ color: "var(--ws-text)" }}
        >
          {headline(item)}
        </div>
        <div
          className="mt-0.5 flex min-w-0 items-center gap-1 text-[10.5px]"
          style={{ color: "var(--ws-text-3)" }}
        >
          <span className="shrink-0 tabular-nums">{when}</span>
          <span aria-hidden>·</span>
          {multi ? (
            <DeliveryMarks
              deliveries={item.deliveries}
              ringClassName="ring-[var(--ws-surface)]"
            />
          ) : (
            <span className="truncate">{item.label}</span>
          )}
        </div>
        {EXPLAIN.has(item.stage) && item.reason ? (
          <div className="mt-0.5 truncate text-[10.5px] text-destructive">
            {item.reason}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <StagePill stage={item.stage} className="h-[18px] px-1.5 text-[10px]" />
        {item.movable ? (
          <GripVertical
            aria-hidden
            className="size-3 opacity-0 transition-opacity group-hover:opacity-60"
            style={{ color: "var(--ws-text-3)" }}
          />
        ) : (
          <Lock
            aria-label="Can't be moved"
            className="size-3 opacity-50"
            style={{ color: "var(--ws-text-3)" }}
          />
        )}
      </div>
    </a>
  );
});

import { addDays } from "@/lib/website-analytics/days";
import { changePercent } from "@/lib/website-analytics/periods";

// Workspace "Websites" görünümünün saf kuralları (GA-F8, /websites): satır
// tipi, süzgeç, dikkat sırası, özet sayıları ve 7 günlük pencere hesabı. Veri
// server/website-analytics/agency/overview.ts'te okunur; burada Google'a ya da
// veritabanına dokunulmaz.

export type WebsitesOverviewRow = {
  linkId: string;
  projectId: string;
  projectName: string;
  projectStatus: string;
  propertyId: string;
  propertyName: string | null;
  role: "main" | "extra";
  serviceLevel: "360" | "standard" | null;
  currency: string | null;
  health: string;
  healthReason: string | null;
  connection: "ok" | "needs_reconnect" | "unknown";
  measurementScore: number | null;
  dataThrough: string | null;
  sessions7d: number | null;
  sessionsChangePct: number | null;
  keyEvents7d: number | null;
  keyEventsChangePct: number | null;
  revenue7d: number | null;
  openFindings: number;
  alertsCritical: number;
  alertsWarn: number;
  agentelseChanges: number;
  bigQuery: "off" | "pending" | "ok" | "error";
  // Projenin etkin WEBSITE müşteri bağlantıları; yalnız ana mülk satırında, ekstrada 0.
  activeShares: number;
  isMock: boolean;
};

export type WebsitesOverviewSummary = {
  properties: number;
  projects: number;
  needAttention: number;
  critical: number;
  extras: number;
};

export type WebsitesFilter = "all" | "attention" | "extras" | "bigquery";

const FILTERS: readonly WebsitesFilter[] = [
  "all",
  "attention",
  "extras",
  "bigquery",
];

// Veri bu kadar günden eskiyse "gecikmiş" sayılır (health/overview ile aynı eşik).
const STALE_AFTER_DAYS = 3;
// Bağın son günü bu kadar günden eskiyse rakamlar gösterilmez (eski veri
// bugünün sayısı gibi okunmasın).
const METRICS_MAX_AGE_DAYS = 45;
const WINDOW_DAYS = 7;

function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function parseWebsitesFilter(value: unknown): WebsitesFilter {
  return typeof value === "string" &&
    (FILTERS as readonly string[]).includes(value)
    ? (value as WebsitesFilter)
    : "all";
}

// Önem sırası (büyük = önce): yeniden bağlanma > kritik uyarı > sağlık bozuk >
// uyarı > geciken veri > 0.
export function attentionRank(
  row: WebsitesOverviewRow,
  today: string = todayKey(),
): number {
  if (row.connection === "needs_reconnect") return 5;
  if (row.alertsCritical > 0) return 4;
  if (row.health !== "OK" && row.health !== "UNKNOWN") return 3;
  if (row.alertsWarn > 0) return 2;
  if (row.dataThrough && row.dataThrough < addDays(today, -STALE_AFTER_DAYS)) {
    return 1;
  }
  return 0;
}

export function applyWebsitesFilter(
  rows: readonly WebsitesOverviewRow[],
  filter: WebsitesFilter,
  today: string = todayKey(),
): WebsitesOverviewRow[] {
  switch (filter) {
    case "attention":
      return rows.filter((row) => attentionRank(row, today) > 0);
    case "extras":
      return rows.filter((row) => row.role === "extra");
    case "bigquery":
      return rows.filter((row) => row.bigQuery !== "off");
    default:
      return [...rows];
  }
}

// Dikkat sırası (azalan), sonra proje adı; aynı projede ana mülk ekstradan önce,
// sonra mülk adı. Sıralama kararlıdır.
export function sortOverviewRows(
  rows: readonly WebsitesOverviewRow[],
  today: string = todayKey(),
): WebsitesOverviewRow[] {
  return rows
    .map((row, index) => ({ row, index, rank: attentionRank(row, today) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return b.rank - a.rank;
      const byProject = a.row.projectName.localeCompare(b.row.projectName);
      if (byProject !== 0) return byProject;
      if (a.row.projectId !== b.row.projectId) {
        return a.row.projectId.localeCompare(b.row.projectId);
      }
      if (a.row.role !== b.row.role) return a.row.role === "main" ? -1 : 1;
      const byProperty = (a.row.propertyName ?? "").localeCompare(
        b.row.propertyName ?? "",
      );
      return byProperty !== 0 ? byProperty : a.index - b.index;
    })
    .map((entry) => entry.row);
}

// "Critical" = açık kritik uyarıların toplamı; "Need attention" = dikkat
// gerektiren mülk sayısı.
export function summarizeOverview(
  rows: readonly WebsitesOverviewRow[],
  today: string = todayKey(),
): WebsitesOverviewSummary {
  return {
    properties: rows.length,
    projects: new Set(rows.map((row) => row.projectId)).size,
    needAttention: rows.filter((row) => attentionRank(row, today) > 0).length,
    critical: rows.reduce((sum, row) => sum + row.alertsCritical, 0),
    extras: rows.filter((row) => row.role === "extra").length,
  };
}

type DayTotals = {
  day: string;
  sessions: number;
  keyEvents: number;
  revenueMicros: bigint;
};

type WindowSum = {
  sessions: number;
  keyEvents: number;
  revenue: number;
  days: number;
};

function sumWindow(
  byDay: ReadonlyMap<string, DayTotals>,
  from: string,
): WindowSum {
  let sessions = 0;
  let keyEvents = 0;
  let micros = BigInt(0);
  let days = 0;
  for (let offset = 0; offset < WINDOW_DAYS; offset += 1) {
    const day = byDay.get(addDays(from, offset));
    if (!day) continue;
    days += 1;
    sessions += day.sessions;
    keyEvents += day.keyEvents;
    micros += day.revenueMicros;
  }
  // Eksik günlü pencere yarım rakam gösterip yanıltmasın: toplamlar 0 kalır,
  // `days` kaç günün bulunduğunu söyler. Para mikro birimden ana birime çevrilir.
  if (days < WINDOW_DAYS) return { sessions: 0, keyEvents: 0, revenue: 0, days };
  return { sessions, keyEvents, revenue: Number(micros) / 1_000_000, days };
}

// `through` (mülk günü) biten son 7 gün ile ondan önceki 7 gün. Yalnız tam
// (7 günü de ambarda olan) pencere sayılır.
export function windowTotals(
  days: readonly DayTotals[],
  through: string,
): {
  current: WindowSum;
  previous: Omit<WindowSum, "revenue">;
} {
  const byDay = new Map(days.map((entry) => [entry.day, entry]));
  const current = sumWindow(byDay, addDays(through, -(WINDOW_DAYS - 1)));
  const before = sumWindow(byDay, addDays(through, -(2 * WINDOW_DAYS - 1)));
  const previous = {
    sessions: before.sessions,
    keyEvents: before.keyEvents,
    days: before.days,
  };
  return { current, previous };
}

export type OverviewMetrics = Pick<
  WebsitesOverviewRow,
  | "sessions7d"
  | "sessionsChangePct"
  | "keyEvents7d"
  | "keyEventsChangePct"
  | "revenue7d"
>;

const NO_METRICS: OverviewMetrics = {
  sessions7d: null,
  sessionsChangePct: null,
  keyEvents7d: null,
  keyEventsChangePct: null,
  revenue7d: null,
};

// Bir bağın satır rakamları: bağın son gününden (lastDailyDate) geriye 7 gün.
// Son gün yoksa ya da 45 günden eskiyse hiçbir rakam gösterilmez.
export function overviewMetrics(
  days: readonly DayTotals[],
  lastDailyDate: string | null,
  today: string = todayKey(),
): OverviewMetrics {
  if (!lastDailyDate || lastDailyDate < addDays(today, -METRICS_MAX_AGE_DAYS)) {
    return NO_METRICS;
  }
  const { current, previous } = windowTotals(days, lastDailyDate);
  if (current.days < WINDOW_DAYS) return NO_METRICS;
  const compare = previous.days === WINDOW_DAYS;
  return {
    sessions7d: current.sessions,
    sessionsChangePct: compare
      ? changePercent(current.sessions, previous.sessions)
      : null,
    keyEvents7d: current.keyEvents,
    keyEventsChangePct: compare
      ? changePercent(current.keyEvents, previous.keyEvents)
      : null,
    revenue7d: current.revenue,
  };
}

// Satırın durum noktası: renk ve sabit etiket (Google'dan gelen metin yok).
export function rowStatus(
  row: WebsitesOverviewRow,
  today: string = todayKey(),
): { tone: "ok" | "warn" | "bad" | "idle"; label: string } {
  const rank = attentionRank(row, today);
  if (rank === 5) return { tone: "bad", label: "Needs reconnect" };
  if (rank === 4) return { tone: "bad", label: "Critical alert" };
  if (rank === 3) return { tone: "bad", label: "Can't read the property" };
  if (rank === 2) return { tone: "warn", label: "Needs a look" };
  if (rank === 1) return { tone: "warn", label: "Data is late" };
  if (row.health === "UNKNOWN" && !row.dataThrough) {
    return { tone: "idle", label: "Waiting for data" };
  }
  return { tone: "ok", label: "Healthy" };
}

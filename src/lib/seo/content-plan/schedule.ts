// Aylık planın takvimi (SC-F7): plan ayın 2'sinde 09:00'dan sonra, ayın son 7
// gününden önce otomatik kurulur; slotlar hafta içi 10:00'a, en az 2 gün arayla
// dizilir. Bütün hesap gün anahtarları ("YYYY-MM-DD", projenin yerel günü)
// üzerinde UTC aritmetiğiyle yapılır; saat dilimi çağıranda çözülmüştür. Saf.

export const PLAN_DUE_DAY = 2;
export const PLAN_DUE_TIME = "09:00";
export const PLAN_LAST_DAYS = 7;
export const SLOT_TIME = "10:00";
export const MIN_SPACING_DAYS = 2;

const DAY_MS = 86_400_000;

function dayToMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

// "2026-10-14" -> "2026-10".
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

// "2026-10" -> "2026-10-01".
export function monthStart(month: string): string {
  return `${month}-01`;
}

// "2028-02" -> 29.
export function daysInMonth(month: string): number {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, mon!, 0)).getUTCDate();
}

export function addDaysToDayKey(day: string, count: number): string {
  return new Date(dayToMs(day) + count * DAY_MS).toISOString().slice(0, 10);
}

export type PlanWindowState = "early" | "open" | "closed";

export type PlanWindow = {
  month: string;
  state: PlanWindowState;
  // Bugünden sonra ayda kalan gün sayısı (ayın günü sayısı - bugünün günü).
  daysLeft: number;
};

const LOCAL_PATTERN = /^(\d{4}-\d{2})-(\d{2})T(\d{2}:\d{2})/;

// local: projenin yerel zamanı "YYYY-MM-DDTHH:mm". early: 2'si 09:00'dan önce;
// closed: ayın günü > gün sayısı - 7 (otomatik plan yalnız "open"da kurulur).
// Okunamayan girdi kapalı sayılır (plan kurulmaz).
export function planWindow(local: string): PlanWindow {
  const match = LOCAL_PATTERN.exec(local);
  if (!match) return { month: "", state: "closed", daysLeft: 0 };
  const month = match[1]!;
  const day = Number(match[2]);
  const time = match[3]!;
  const total = daysInMonth(month);
  const daysLeft = Math.max(0, total - day);
  let state: PlanWindowState = "open";
  if (day < PLAN_DUE_DAY || (day === PLAN_DUE_DAY && time < PLAN_DUE_TIME)) {
    state = "early";
  } else if (day > total - PLAN_LAST_DAYS) {
    state = "closed";
  }
  return { month, state, daysLeft };
}

// Elle "Plan this month": ayın bitmesine en az 2 gün kalana dek.
export function manualPlanAllowed(local: string): boolean {
  const window = planWindow(local);
  return window.month !== "" && window.daysLeft >= 2;
}

function isWeekday(day: string): boolean {
  const weekday = new Date(dayToMs(day)).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

// Açgözlü (en erken) dizilimle idx'ten başlayarak sığan en çok gün sayısı.
function packFrom(days: readonly string[], startIdx: number): number {
  let count = 0;
  let last: string | null = null;
  for (let i = startIdx; i < days.length; i += 1) {
    const day = days[i]!;
    if (last === null || dayToMs(day) - dayToMs(last) >= MIN_SPACING_DAYS * DAY_MS) {
      count += 1;
      last = day;
    }
  }
  return count;
}

// Ay içinde, yarından başlayarak hafta içi günlere `count` slot dağıtır:
// uygun günler arasında eşit aralıklı hedefler, her seçim bir öncekinden en
// az 2 gün sonra; dolu (taken) günler atlanır. Gün yetmezse daha az döner.
// Sıralı artan ve belirleyicidir.
export function layoutSlotDates(input: {
  month: string;
  today: string;
  count: number;
  taken: readonly string[];
}): string[] {
  const end = addDaysToDayKey(monthStart(input.month), daysInMonth(input.month) - 1);
  const from = monthStart(input.month);
  const tomorrow = addDaysToDayKey(input.today, 1);
  const first = tomorrow > from ? tomorrow : from;
  const takenSet = new Set(input.taken);
  const eligible: string[] = [];
  for (let day = first; day <= end; day = addDaysToDayKey(day, 1)) {
    if (isWeekday(day) && !takenSet.has(day)) eligible.push(day);
  }
  const wanted = Math.max(0, Math.floor(input.count));
  const target = Math.min(wanted, packFrom(eligible, 0));
  const picks: string[] = [];
  const n = eligible.length;
  let minIdx = 0;
  for (let i = 0; i < target; i += 1) {
    const need = target - i;
    const spread = Math.floor(((i + 0.5) * n) / target);
    const accept = (j: number) => packFrom(eligible, j) >= need;
    let chosen = -1;
    for (let j = Math.max(spread, minIdx); j < n; j += 1) {
      if (accept(j)) {
        chosen = j;
        break;
      }
    }
    if (chosen < 0) {
      for (let j = minIdx; j < Math.min(spread, n); j += 1) {
        if (accept(j)) {
          chosen = j;
          break;
        }
      }
    }
    if (chosen < 0) break;
    const day = eligible[chosen]!;
    picks.push(day);
    const nextAllowed = addDaysToDayKey(day, MIN_SPACING_DAYS);
    minIdx = chosen + 1;
    while (minIdx < n && eligible[minIdx]! < nextAllowed) minIdx += 1;
  }
  return picks;
}

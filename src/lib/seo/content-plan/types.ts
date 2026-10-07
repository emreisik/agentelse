// Aylık SEO içerik planının ortak tipleri ve saklanan JSON'un okuyucusu
// (SC-F7, docs/search-content-plan.md). Saf ve izomorfik.
//
// SeoContentPlan.data = SeoContentPlanData. Adaylar (PlanCandidate) ASLA
// saklanmaz: oluşturma, yenileme ve değiştirme her seferinde taze anlık
// görüntüden yeniden hesaplanır. Slotlar yalnız seçilen sonucu taşır.

export const PLAN_SLOT_KINDS = ["PILLAR", "SUPPORT"] as const;
export type PlanSlotKind = (typeof PLAN_SLOT_KINDS)[number];

export const PLAN_GAPS = ["NO_PILLAR", "NO_PAGE"] as const;
export type PlanGap = (typeof PLAN_GAPS)[number];

export const PLAN_EMPTY_REASONS = [
  "NO_DATA",
  "NO_CLUSTERS",
  "NO_GAPS",
  "CAP_FULL",
  "NO_ROOM",
  "AI_LIMIT",
  "ALL_FILTERED",
] as const;
export type PlanEmptyReason = (typeof PLAN_EMPTY_REASONS)[number];

export const PLAN_WORDINGS = ["AI", "BASIC", "MOCK"] as const;
export type PlanWording = (typeof PLAN_WORDINGS)[number];

export const PLAN_REJECT_REASONS = [
  "NEAR_DUPLICATE",
  "LOCATION_TEMPLATE",
  "EXISTING_PAGE",
  "TEMPLATE_REPEAT",
  "LOCAL_INTENT",
  "BRAND_QUERY",
  "DISMISSED_FINDING",
  "REJECTED_BEFORE",
] as const;
export type PlanRejectReason = (typeof PLAN_REJECT_REASONS)[number];

export const PLAN_MAX_REGENERATIONS = 3;
export const PLAN_MAX_SLOTS = 12;
export const PLAN_MAX_PILLARS = 12;
export const PLAN_MAX_NOTES = 6;
// Reddedilen anahtarlar (kalan ay + sonraki 3 ay için) üst sınırı.
export const PLAN_MAX_REJECTED = 500;

export type PlanIntent = "informational" | "commercial" | "transactional";
export type PlanQueryIntent = PlanIntent | "navigational";
export type PlanConfidence = "SIGNIFICANT" | "DIRECTIONAL";

export type PlanLink = {
  url: string;
  path: string;
  // <= 60 karakter
  anchor: string;
  role: "pillar" | "related";
};

// --- Saf girdi (RuleSnapshot'tan planInputFromSnapshot ile çıkar) ---

export type PlanQuery = {
  queryId: string;
  text: string;
  // Son 28 gün
  impressions: number;
  clicks: number;
  position: number | null;
  intent: PlanQueryIntent | null;
  isBrand: boolean;
  clusterId: string | null;
  firstSeenWeek: string;
  previousImpressions: number | null;
};

export type PlanPair = {
  queryId: string;
  pageId: string;
  impressions: number;
  clicks: number;
  position: number | null;
};

export type PlanPage = {
  pageId: string | null;
  url: string;
  path: string;
  title: string | null;
  h1: string | null;
  h2: string[];
  clicks: number;
  impressions: number;
  inlinks: number | null;
  indexable: boolean | null;
  noindex: boolean;
  status: number | null;
  isHomepage: boolean;
};

export type PlanCluster = {
  id: string;
  name: string;
  pillarPageId: string | null;
  queryIds: string[];
  impressions: number;
  clicks: number;
};

export type PlanFindingRef = {
  id: string;
  ruleKey: "SO5_CONTENT_GAP" | "SO6_RISING_QUERY";
  queryId: string | null;
  clusterId: string | null;
  status: "OPEN" | "ACCEPTED" | "DISMISSED";
  confidence: PlanConfidence;
};

export type PoolIdeaRef = {
  id: string;
  keyword: string;
  title: string;
  angle: string;
  description: string;
  intent: PlanIntent | null;
};

export type ContentPlanInput = {
  // Pazartesi (GscSiteLink.lastWeeklyWeek)
  week: string;
  // Projenin yerel ayı "YYYY-MM"
  month: string;
  webImpressions28d: number;
  nonBrandImpressions: number;
  brandTerms: string[];
  queries: PlanQuery[];
  pairs: PlanPair[];
  pages: PlanPage[];
  clusters: PlanCluster[];
  hasCrawl: boolean;
  crawlComplete: boolean;
  links: { fromPageId: string; toPageId: string }[];
  findings: PlanFindingRef[];
  existingTitles: string[];
  existingKeywords: string[];
  poolIdeas: PoolIdeaRef[];
  rejectedKeys: string[];
  deprioritizedKeys: string[];
};

export type PlanExtras = Pick<
  ContentPlanInput,
  | "month"
  | "findings"
  | "existingTitles"
  | "existingKeywords"
  | "poolIdeas"
  | "rejectedKeys"
  | "deprioritizedKeys"
>;

export type PlanCandidate = {
  // `${kind}:${clusterId ?? "q"}:${keywordKey}`
  id: string;
  kind: PlanSlotKind;
  clusterId: string | null;
  clusterName: string | null;
  keyword: string;
  // <= 3 destekleyici sorgu
  queries: string[];
  queryIds: string[];
  intent: PlanIntent;
  impressions: number;
  clicks: number;
  share: number;
  position: number | null;
  gap: PlanGap;
  rising: boolean;
  findingId: string | null;
  findingConfidence: PlanConfidence | null;
  score: number;
  bestPageId: string | null;
  reuseIdeaId: string | null;
};

export type PlanFiltered = { candidateId: string; reason: PlanRejectReason };

// --- Saklanan veri ---

export type PlanSlotStatus = "PLANNED" | "SKIPPED" | "REMOVED";

export type PlanSlot = {
  // "s1".. ; data.nextSlot ile asla yeniden kullanılmaz
  id: string;
  status: PlanSlotStatus;
  kind: PlanSlotKind;
  clusterId: string | null;
  clusterName: string | null;
  keyword: string;
  queries: string[];
  intent: PlanIntent;
  impressions: number;
  share: number;
  position: number | null;
  gap: PlanGap;
  rising: boolean;
  findingId: string | null;
  title: string;
  angle: string;
  description: string;
  // Planlandığı anki gün "YYYY-MM-DD" (canlı tarih Creative'den okunur)
  date: string;
  time: string;
  // SKIPPED/REMOVED slotlar da bunları taşır (forget'in ihtiyacı)
  creativeId: string;
  postId: string;
  ideaId: string;
  // Havuzdan YENİDEN KULLANILAN fikrin PLANNING'den önceki durumu
  prevIdeaStatus: string | null;
  linkFrom: PlanLink[];
  linkTo: PlanLink[];
  linksVerified: boolean;
  reusedIdea: boolean;
};

export type PillarEntry = {
  clusterId: string;
  name: string;
  impressions: number;
  share: number;
  pillarUrl: string | null;
  pillarPath: string | null;
  weak: boolean;
  slotIds: string[];
};

export type SeoContentPlanData = {
  v: 1;
  slots: PlanSlot[];
  nextSlot: number;
  rejected: string[];
  reason: PlanEmptyReason | null;
  // Sabit İngilizce, rakamsız, <= 6
  notes: string[];
  pillars: PillarEntry[];
  totals: { nonBrandImpressions: number };
  considered: number;
  filtered: { reason: PlanRejectReason; count: number }[];
  checkedAt: string;
  regeneratedAt: string | null;
  wordingNote: "budget" | null;
};

export function emptyPlanData(
  now: Date,
  reason: PlanEmptyReason | null,
): SeoContentPlanData {
  return {
    v: 1,
    slots: [],
    nextSlot: 1,
    rejected: [],
    reason,
    notes: [],
    pillars: [],
    totals: { nonBrandImpressions: 0 },
    considered: 0,
    filtered: [],
    checkedAt: now.toISOString(),
    regeneratedAt: null,
    wordingNote: null,
  };
}

// --- Gevşek okuyucu: bozuk slot düşer, diziler kırpılır, tarihe güvenilmez ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return Array.from(value).slice(0, max).join("");
}

function nonEmpty(value: unknown, max: number): string | null {
  const text = str(value, max).trim();
  return text === "" ? null : text;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: unknown): number {
  return Math.max(0, num(value));
}

function oneOf<T extends string>(
  list: readonly T[],
  value: unknown,
): T | null {
  return typeof value === "string" && (list as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DAY_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const SLOT_ID_PATTERN = /^s(\d{1,6})$/;

function parseLink(value: unknown): PlanLink | null {
  if (!isRecord(value)) return null;
  const url = nonEmpty(value.url, 2000);
  const path = nonEmpty(value.path, 1000);
  const anchor = nonEmpty(value.anchor, 60);
  const role = value.role === "pillar" ? "pillar" : value.role === "related" ? "related" : null;
  if (!url || !path || !anchor || !role) return null;
  return { url, path, anchor, role };
}

function parseLinks(value: unknown, max: number): PlanLink[] {
  if (!Array.isArray(value)) return [];
  const out: PlanLink[] = [];
  for (const item of value) {
    const link = parseLink(item);
    if (link) out.push(link);
    if (out.length >= max) break;
  }
  return out;
}

function parseSlot(value: unknown): PlanSlot | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && SLOT_ID_PATTERN.test(value.id) ? value.id : null;
  const kind = oneOf(PLAN_SLOT_KINDS, value.kind);
  const gap = oneOf(PLAN_GAPS, value.gap);
  const keyword = nonEmpty(value.keyword, 160);
  const title = nonEmpty(value.title, 200);
  const creativeId = nonEmpty(value.creativeId, 64);
  const postId = nonEmpty(value.postId, 64);
  const ideaId = nonEmpty(value.ideaId, 64);
  if (!id || !kind || !gap || !keyword || !title) return null;
  if (!creativeId || !postId || !ideaId) return null;
  if (!isDayKey(value.date)) return null;
  const status = oneOf(["PLANNED", "SKIPPED", "REMOVED"] as const, value.status);
  if (!status) return null;
  const intent =
    oneOf(["informational", "commercial", "transactional"] as const, value.intent) ??
    "informational";
  const time =
    typeof value.time === "string" && /^\d{2}:\d{2}$/.test(value.time)
      ? value.time
      : "10:00";
  return {
    id,
    status,
    kind,
    clusterId: nonEmpty(value.clusterId, 64),
    clusterName: nonEmpty(value.clusterName, 120),
    keyword,
    queries: Array.isArray(value.queries)
      ? value.queries
          .map((item) => nonEmpty(item, 160))
          .filter((item): item is string => item !== null)
          .slice(0, 3)
      : [],
    intent,
    impressions: nonNegative(value.impressions),
    share: Math.min(1, nonNegative(value.share)),
    position:
      typeof value.position === "number" && Number.isFinite(value.position)
        ? value.position
        : null,
    gap,
    rising: value.rising === true,
    findingId: nonEmpty(value.findingId, 64),
    title,
    angle: str(value.angle, 300),
    description: str(value.description, 200),
    date: value.date,
    time,
    creativeId,
    postId,
    ideaId,
    prevIdeaStatus: nonEmpty(value.prevIdeaStatus, 40),
    linkFrom: parseLinks(value.linkFrom, 4),
    linkTo: parseLinks(value.linkTo, 3),
    linksVerified: value.linksVerified === true,
    reusedIdea: value.reusedIdea === true,
  };
}

function parsePillar(value: unknown): PillarEntry | null {
  if (!isRecord(value)) return null;
  const clusterId = nonEmpty(value.clusterId, 64);
  if (!clusterId) return null;
  return {
    clusterId,
    name: str(value.name, 120),
    impressions: nonNegative(value.impressions),
    share: Math.min(1, nonNegative(value.share)),
    pillarUrl: nonEmpty(value.pillarUrl, 2000),
    pillarPath: nonEmpty(value.pillarPath, 1000),
    weak: value.weak === true,
    slotIds: Array.isArray(value.slotIds)
      ? value.slotIds
          .filter((item): item is string => typeof item === "string" && SLOT_ID_PATTERN.test(item))
          .slice(0, PLAN_MAX_SLOTS)
      : [],
  };
}

export function parseContentPlanData(
  value: unknown,
  now: Date = new Date(0),
): SeoContentPlanData {
  if (!isRecord(value) || value.v !== 1) return emptyPlanData(now, null);
  const slots: PlanSlot[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value.slots)) {
    for (const item of value.slots) {
      const slot = parseSlot(item);
      if (!slot || seen.has(slot.id)) continue;
      seen.add(slot.id);
      slots.push(slot);
      if (slots.length >= PLAN_MAX_SLOTS) break;
    }
  }
  const highest = slots.reduce(
    (max, slot) => Math.max(max, Number(SLOT_ID_PATTERN.exec(slot.id)![1])),
    0,
  );
  const nextSlot = Math.max(
    highest + 1,
    Math.floor(num(value.nextSlot, 1)),
    1,
  );
  const rejected: string[] = [];
  if (Array.isArray(value.rejected)) {
    const unique = new Set<string>();
    for (const item of value.rejected) {
      const key = nonEmpty(item, 160);
      if (key && !unique.has(key)) {
        unique.add(key);
        rejected.push(key);
      }
      if (rejected.length >= PLAN_MAX_REJECTED) break;
    }
  }
  const pillars: PillarEntry[] = [];
  if (Array.isArray(value.pillars)) {
    for (const item of value.pillars) {
      const pillar = parsePillar(item);
      if (pillar) pillars.push(pillar);
      if (pillars.length >= PLAN_MAX_PILLARS) break;
    }
  }
  const notes = Array.isArray(value.notes)
    ? value.notes
        .map((item) => nonEmpty(item, 200))
        .filter((item): item is string => item !== null)
        .slice(0, PLAN_MAX_NOTES)
    : [];
  const filtered: SeoContentPlanData["filtered"] = [];
  if (Array.isArray(value.filtered)) {
    for (const item of value.filtered) {
      if (!isRecord(item)) continue;
      const reason = oneOf(PLAN_REJECT_REASONS, item.reason);
      if (!reason) continue;
      filtered.push({ reason, count: Math.floor(nonNegative(item.count)) });
      if (filtered.length >= PLAN_REJECT_REASONS.length) break;
    }
  }
  const totals = isRecord(value.totals) ? value.totals : {};
  return {
    v: 1,
    slots,
    nextSlot,
    rejected,
    reason: oneOf(PLAN_EMPTY_REASONS, value.reason),
    notes,
    pillars,
    totals: { nonBrandImpressions: nonNegative(totals.nonBrandImpressions) },
    considered: Math.floor(nonNegative(value.considered)),
    filtered,
    checkedAt: nonEmpty(value.checkedAt, 40) ?? now.toISOString(),
    regeneratedAt: nonEmpty(value.regeneratedAt, 40),
    wordingNote: value.wordingNote === "budget" ? "budget" : null,
  };
}

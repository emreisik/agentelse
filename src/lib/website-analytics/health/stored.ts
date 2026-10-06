import type {
  GaPiiProbeResult,
  GaRealtimeState,
  GaSiteHints,
  GaSiteTagResult,
} from "./types";

// GaHealthRun Json sütunlarının (siteTag, piiProbe, realtime) hoşgörülü
// okuyucuları: bilinmeyen ya da bozuk değer null döner, hiçbir zaman hata
// fırlatmaz. Sayılar Number.isFinite'ten geçer, dizi elemanları süzülür.

// pii-probe.ts'teki PII_PARAM_NAMES'in yerel kopyası (paketler arası bağımlılık
// olmasın diye): saklanan değerde yalnız bu adlar kalır.
const PII_PARAMS: ReadonlySet<string> = new Set([
  "email",
  "e-mail",
  "mail",
  "phone",
  "tel",
  "mobile",
  "name",
  "firstname",
  "first_name",
  "lastname",
  "last_name",
  "token",
  "password",
  "pass",
  "pwd",
]);

const MAX_OTHER_IDS = 5;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type Obj = Record<string, unknown>;

function asObject(value: unknown): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function day(value: unknown): string | null {
  return typeof value === "string" && DAY_RE.test(value) ? value : null;
}

function hints(value: unknown): GaSiteHints {
  const obj = asObject(value) ?? {};
  return {
    tel: bool(obj.tel),
    whatsapp: bool(obj.whatsapp),
    mailto: bool(obj.mailto),
    form: bool(obj.form),
    maps: bool(obj.maps),
    checkout: bool(obj.checkout),
  };
}

const SITE_OUTCOMES: readonly GaSiteTagResult["outcome"][] = [
  "ok",
  "no_site",
  "blocked_by_robots",
  "fetch_failed",
];

export function parseGaSiteTagResult(json: unknown): GaSiteTagResult | null {
  const obj = asObject(json);
  if (!obj || obj.v !== 1) return null;
  const at = str(obj.at);
  const outcome = SITE_OUTCOMES.find((value) => value === obj.outcome);
  const pagesChecked = num(obj.pagesChecked);
  const pagesFailed = num(obj.pagesFailed);
  const pagesWithExpected = num(obj.pagesWithExpected);
  if (
    !at ||
    !outcome ||
    pagesChecked === null ||
    pagesFailed === null ||
    pagesWithExpected === null
  ) {
    return null;
  }
  return {
    v: 1,
    at,
    host: str(obj.host),
    outcome,
    pagesChecked,
    pagesFailed,
    pagesWithExpected,
    expectedId: str(obj.expectedId),
    otherIds: [...new Set(strings(obj.otherIds))]
      .sort()
      .slice(0, MAX_OTHER_IDS),
    gtm: bool(obj.gtm),
    googleTag: bool(obj.googleTag),
    gtagJs: bool(obj.gtagJs),
    doubleLoad: bool(obj.doubleLoad),
    consentDefault: bool(obj.consentDefault),
    cmp: str(obj.cmp),
    hints: hints(obj.hints),
  };
}

export function parseGaPiiProbeResult(json: unknown): GaPiiProbeResult | null {
  const obj = asObject(json);
  if (!obj || obj.v !== 1) return null;
  const at = str(obj.at);
  const from = day(obj.from);
  const to = day(obj.to);
  const outcome =
    obj.outcome === "ok" || obj.outcome === "error" ? obj.outcome : null;
  const pages = num(obj.pages);
  const views = num(obj.views);
  if (!at || !from || !to || !outcome || pages === null || views === null) {
    return null;
  }
  return {
    v: 1,
    at,
    from,
    to,
    forced: bool(obj.forced),
    outcome,
    pages,
    views,
    params: [
      ...new Set(strings(obj.params).filter((name) => PII_PARAMS.has(name))),
    ],
    email: bool(obj.email),
    phone: bool(obj.phone),
  };
}

export function parseGaRealtimeState(json: unknown): GaRealtimeState | null {
  const obj = asObject(json);
  if (!obj || obj.v !== 1) return null;
  const stateDay = day(obj.day);
  const zeros = num(obj.zeros);
  const checks = num(obj.checks);
  if (!stateDay || zeros === null || checks === null) return null;
  return {
    v: 1,
    day: stateDay,
    zeros,
    checks,
    lastAt: str(obj.lastAt),
    lastActive: num(obj.lastActive),
    expected: num(obj.expected),
  };
}

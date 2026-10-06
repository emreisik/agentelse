// GaPropertyLink.catalog'un sürümlü okunuşu (docs/google-analytics-plan.md
// §3.3 "Katalog doğrulaması", GA-F2 bölüm 2). İki biçim vardır:
//   v1 (bugünkü): { [reportKey]: { reason, at } } — yalnız düşen raporlar.
//   v2 (GA_CATALOG_CHECKS): { v: 2, disabled, check, optional }.
// v2'yi yalnız katalog denetimi yazar; withDisabledReport aldığı biçimi korur,
// bayrak kapalıyken saklanan JSON v1 kalır. Geri dönüş güvenliği: eski bir
// sürüm v2 nesnesine düz anahtar eklerse o anahtar yine düşmüş sayılır. Saf
// modül.

export const GA_OPTIONAL_REPORT_KEYS = [
  "google_ads",
  "search_console",
] as const;
export type GaOptionalReportKey = (typeof GA_OPTIONAL_REPORT_KEYS)[number];

export type GaDisabledEntry = { reason: string; at: string };

export type GaCatalogCheck = {
  at: string;
  // Rapor anahtarı → mülkte bulunmayan alanlar.
  missing: Record<string, string[]>;
  // Yalnız eski adıyla (deprecatedApiNames) bulunan alanlar.
  deprecated: string[];
  // Kısıtlı metrikler (NO_COST_METRICS, NO_REVENUE_METRICS): Google sıfır döner.
  blocked: string[];
  // Son denetim başarısız oldu (24 saat sonra yeniden denenir).
  error?: string;
};

export type GaOptionalState = {
  enabled: boolean;
  at: string;
  reason: string | null;
};

export type GaCatalogState = {
  v: 2;
  disabled: Record<string, GaDisabledEntry>;
  check: GaCatalogCheck | null;
  optional: Partial<Record<GaOptionalReportKey, GaOptionalState>>;
};

const EPOCH = new Date(0).toISOString();
const CHECK_EVERY_MS = 7 * 86_400_000;
const CHECK_RETRY_MS = 24 * 3_600_000;
const V2_FIELDS = new Set(["v", "disabled", "check", "optional"]);

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// { reason: string, at?: string } ise düşmüş rapor kaydı.
function disabledEntry(value: unknown): GaDisabledEntry | null {
  const entry = objectOf(value);
  if (!entry || typeof entry.reason !== "string") return null;
  return {
    reason: entry.reason,
    at: typeof entry.at === "string" ? entry.at : EPOCH,
  };
}

function parseCheck(value: unknown): GaCatalogCheck | null {
  const check = objectOf(value);
  if (!check || typeof check.at !== "string") return null;
  const missing: Record<string, string[]> = {};
  for (const [key, fields] of Object.entries(objectOf(check.missing) ?? {})) {
    missing[key] = strings(fields);
  }
  return {
    at: check.at,
    missing,
    deprecated: strings(check.deprecated),
    blocked: strings(check.blocked),
    ...(typeof check.error === "string" ? { error: check.error } : {}),
  };
}

function parseOptional(value: unknown): GaCatalogState["optional"] {
  const source = objectOf(value) ?? {};
  const optional: GaCatalogState["optional"] = {};
  for (const key of GA_OPTIONAL_REPORT_KEYS) {
    const entry = objectOf(source[key]);
    if (!entry || typeof entry.enabled !== "boolean") continue;
    optional[key] = {
      enabled: entry.enabled,
      at: typeof entry.at === "string" ? entry.at : EPOCH,
      reason: typeof entry.reason === "string" ? entry.reason : null,
    };
  }
  return optional;
}

function isV2(json: unknown): boolean {
  return objectOf(json)?.v === 2;
}

export function parseGaCatalogState(json: unknown): GaCatalogState {
  const source = objectOf(json);
  const disabled: Record<string, GaDisabledEntry> = {};
  if (!source) return { v: 2, disabled, check: null, optional: {} };

  if (source.v === 2) {
    for (const [key, value] of Object.entries(
      objectOf(source.disabled) ?? {},
    )) {
      const entry = disabledEntry(value);
      if (entry) disabled[key] = entry;
    }
    // Eski sürümün v2 nesnesine eklediği düz anahtarlar da düşmüş sayılır.
    for (const [key, value] of Object.entries(source)) {
      if (V2_FIELDS.has(key) || disabled[key]) continue;
      const entry = disabledEntry(value);
      if (entry) disabled[key] = entry;
    }
    return {
      v: 2,
      disabled,
      check: parseCheck(source.check),
      optional: parseOptional(source.optional),
    };
  }

  for (const [key, value] of Object.entries(source)) {
    const entry = disabledEntry(value);
    if (entry) disabled[key] = entry;
  }
  return { v: 2, disabled, check: null, optional: {} };
}

export function serializeGaCatalogState(
  state: GaCatalogState,
): Record<string, unknown> {
  return {
    v: 2,
    disabled: state.disabled,
    check: state.check,
    optional: state.optional,
  };
}

export function gaDisabledReports(json: unknown): Set<string> {
  return new Set(Object.keys(parseGaCatalogState(json).disabled));
}

// Bir raporu düşürür; v1 (ya da boş) girdi bugünkü düz biçimde, v2 girdi v2
// olarak kalır.
export function withDisabledReport(
  json: unknown,
  key: string,
  reason: string,
  at: string,
): Record<string, unknown> {
  if (!isV2(json)) {
    return { ...(objectOf(json) ?? {}), [key]: { reason, at } };
  }
  const state = parseGaCatalogState(json);
  return serializeGaCatalogState({
    ...state,
    disabled: { ...state.disabled, [key]: { reason, at } },
  });
}

export function gaOptionalReportEnabled(
  json: unknown,
  key: GaOptionalReportKey,
): boolean {
  return parseGaCatalogState(json).optional[key]?.enabled === true;
}

// Haftalık denetim: hiç yapılmadıysa, 7 günü doldurduysa ya da son deneme
// hatalıysa 24 saat sonra.
export function gaCatalogCheckDue(json: unknown, now: Date): boolean {
  const check = parseGaCatalogState(json).check;
  if (!check) return true;
  const at = Date.parse(check.at);
  if (!Number.isFinite(at)) return true;
  const age = now.getTime() - at;
  if (age >= CHECK_EVERY_MS) return true;
  return check.error !== undefined && age >= CHECK_RETRY_MS;
}

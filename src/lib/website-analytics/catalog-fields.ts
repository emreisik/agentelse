import {
  GA_OPTIONAL_DAILY_REPORTS,
  GA_REPORTS,
  GA_TOTALS_METRICS,
  ROLLING_USERS_KEY,
  ROLLING_USERS_METRICS,
} from "@/lib/website-analytics/catalog";
import type {
  GaCatalogState,
  GaDisabledEntry,
} from "@/lib/website-analytics/catalog-state";
import {
  GA_WEEKLY_REPORTS,
  GA_WINDOW_REPORTS,
  SEARCH_CONSOLE_KEY,
  SITE_SEARCH_KEY,
  weeklyDisableKey,
} from "@/lib/website-analytics/weekly";

// Katalog denetimi (docs/google-analytics-plan.md §3.3 "getMetadata /
// checkCompatibility"): haftada bir mülkün alan listesi okunur ve her
// raporun istediği boyut/metrikler karşılaştırılır. Eksik alanı olan rapor
// düşer (FIELD_MISSING), alan geri gelince yeniden açılır; diğer düşmeler
// haftada bir yeniden denenir. Yalnız eski adla (deprecatedApiNames) bulunan
// alanlar ve kısıtlı metrikler (blockedReasons; Google sıfır döndürür, istek
// düşmez) ayrıca kaydedilir. Saf modül.

export type GaFieldMeta = {
  apiName: string;
  deprecatedApiNames: string[];
  blockedReasons: string[];
};
export type GaMetadataFields = {
  dimensions: GaFieldMeta[];
  metrics: GaFieldMeta[];
};
export type GaRequiredFields = Record<
  string,
  { dimensions: string[]; metrics: string[] }
>;

const TOTALS_KEY = "totals";
const WEEK_DIMENSION = "isoYearIsoWeek";
// Eksik alanları kaydedilir ama hiçbir şeyi düşürmez: KPI'lar bunlardan gelir.
const NEVER_DISABLED = new Set([TOTALS_KEY, ROLLING_USERS_KEY]);
const RETRY_AFTER_MS = 7 * 24 * 3_600_000;

export function gaCatalogRequiredFields(): GaRequiredFields {
  const required: GaRequiredFields = {
    [TOTALS_KEY]: { dimensions: ["date"], metrics: [...GA_TOTALS_METRICS] },
  };
  for (const spec of GA_REPORTS) {
    required[spec.key] = {
      dimensions: ["date", ...spec.dimensions],
      metrics: [...spec.metrics],
    };
  }
  required[ROLLING_USERS_KEY] = {
    dimensions: [],
    metrics: [...ROLLING_USERS_METRICS],
  };
  for (const spec of GA_WEEKLY_REPORTS) {
    if (spec.key === SITE_SEARCH_KEY) {
      // Süzgeçteki eventName de istenir (view_search_results).
      required[SITE_SEARCH_KEY] = {
        dimensions: [WEEK_DIMENSION, ...spec.dimensions, "eventName"],
        metrics: [...spec.metrics],
      };
      continue;
    }
    required[weeklyDisableKey(spec)] = {
      dimensions: [WEEK_DIMENSION, ...spec.dimensions],
      metrics: [...spec.metrics],
    };
  }
  for (const spec of GA_OPTIONAL_DAILY_REPORTS) {
    required[spec.key] = {
      dimensions: ["date", ...spec.dimensions],
      metrics: [...spec.metrics],
    };
  }
  for (const spec of GA_WINDOW_REPORTS) {
    if (spec.key !== SEARCH_CONSOLE_KEY) continue;
    required[spec.key] = {
      dimensions: [...spec.dimensions],
      metrics: [...spec.metrics],
    };
  }
  return required;
}

type FieldIndex = {
  current: Map<string, GaFieldMeta>;
  // Eski ad → alan (yalnız güncel adlarda bulunmayanlar kullanılır).
  deprecated: Map<string, GaFieldMeta>;
};

function indexFields(fields: GaFieldMeta[]): FieldIndex {
  const current = new Map<string, GaFieldMeta>();
  const deprecated = new Map<string, GaFieldMeta>();
  for (const field of fields) {
    current.set(field.apiName, field);
    for (const name of field.deprecatedApiNames) {
      if (!deprecated.has(name)) deprecated.set(name, field);
    }
  }
  return { current, deprecated };
}

type Lookup = { field: GaFieldMeta; deprecated: boolean } | null;

function lookup(index: FieldIndex, name: string): Lookup {
  const field = index.current.get(name);
  if (field) return { field, deprecated: false };
  const alias = index.deprecated.get(name);
  return alias ? { field: alias, deprecated: true } : null;
}

export function evaluateGaMetadata(
  metadata: GaMetadataFields,
  required: GaRequiredFields,
): {
  missing: Record<string, string[]>;
  deprecated: string[];
  blocked: string[];
} {
  const dimensions = indexFields(metadata.dimensions);
  const metrics = indexFields(metadata.metrics);
  const missing: Record<string, string[]> = {};
  const deprecated = new Set<string>();
  const blocked = new Set<string>();

  for (const [key, fields] of Object.entries(required)) {
    const absent = new Set<string>();
    for (const name of fields.dimensions) {
      const found = lookup(dimensions, name);
      if (!found) absent.add(name);
      else if (found.deprecated) deprecated.add(name);
    }
    for (const name of fields.metrics) {
      const found = lookup(metrics, name);
      if (!found) {
        absent.add(name);
        continue;
      }
      if (found.deprecated) deprecated.add(name);
      for (const reason of found.field.blockedReasons) {
        blocked.add(`${name}:${reason}`);
      }
    }
    if (absent.size > 0) missing[key] = [...absent];
  }
  return { missing, deprecated: [...deprecated], blocked: [...blocked] };
}

function olderThanWeek(at: string, now: Date): boolean {
  const time = Date.parse(at);
  // Okunamayan zaman eski sayılır: haftalık deneme kaçmasın.
  return Number.isNaN(time) || now.getTime() - time >= RETRY_AFTER_MS;
}

export function applyGaCatalogCheck(
  state: GaCatalogState,
  input: {
    at: string;
    now: Date;
    result: ReturnType<typeof evaluateGaMetadata>;
    required: GaRequiredFields;
  },
): GaCatalogState {
  const { at, now, result, required } = input;
  const disabled: Record<string, GaDisabledEntry> = {};

  // Yeniden açma: alanları dönen FIELD_MISSING hemen; diğer düşmeler ve
  // bilinmeyen anahtarlar (eski 'week:site_search' gibi) haftada bir denenir.
  for (const [key, entry] of Object.entries(state.disabled)) {
    const known = Object.hasOwn(required, key);
    const reopen = known
      ? !Object.hasOwn(result.missing, key) &&
        (entry.reason.startsWith("FIELD_MISSING") ||
          olderThanWeek(entry.at, now))
      : olderThanWeek(entry.at, now);
    if (!reopen) disabled[key] = entry;
  }

  for (const [key, names] of Object.entries(result.missing)) {
    if (NEVER_DISABLED.has(key)) continue;
    disabled[key] = { reason: `FIELD_MISSING: ${names.join(", ")}`, at };
  }

  return {
    ...state,
    disabled,
    check: {
      at,
      missing: result.missing,
      deprecated: result.deprecated,
      blocked: result.blocked,
    },
  };
}

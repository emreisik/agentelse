// Meta nesnesi → ayna satırı (docs/meta-ads-plan.md §3.2). Saf fonksiyonlar:
// alan normalizasyonu, izlenen alanların özeti (drift) ve durum etiketleri.

export type MirrorLevel = "CAMPAIGN" | "ADSET" | "AD";

// Graph'tan gelen ham nesne (seviye alanları fields.ts'te).
export type MetaRawObject = {
  id: string;
  name?: string;
  campaign_id?: string;
  adset_id?: string;
  configured_status?: string;
  effective_status?: string;
  objective?: string;
  optimization_goal?: string;
  billing_event?: string;
  bid_strategy?: string;
  destination_type?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  spend_cap?: string;
  budget_remaining?: string;
  start_time?: string;
  end_time?: string;
  promoted_object?: unknown;
  targeting?: unknown;
  learning_stage_info?: {
    status?: string;
    conversions?: number;
    last_sig_edit_ts?: number;
  };
  issues_info?: unknown;
  ad_review_feedback?: unknown;
  failed_delivery_checks?: unknown;
  creative?: { id?: string };
  updated_time?: string;
};

export type MirrorFields = {
  level: MirrorLevel;
  externalId: string;
  parentExternalId: string | null;
  campaignExternalId: string | null;
  name: string;
  objective: string | null;
  optimizationGoal: string | null;
  billingEvent: string | null;
  bidStrategy: string | null;
  destinationType: string | null;
  configuredStatus: string | null;
  effectiveStatus: string | null;
  dailyBudgetMinor: number | null;
  lifetimeBudgetMinor: number | null;
  spendCapMinor: number | null;
  budgetRemainingMinor: number | null;
  startTime: Date | null;
  endTime: Date | null;
  learningStatus: string | null;
  learningConversions: number | null;
  lastSigEditAt: Date | null;
  issues: unknown;
  reviewFeedback: unknown;
  failedDeliveryChecks: unknown;
  advantageState: string | null;
  creativeExternalId: string | null;
  // Sonuç olarak sayılan olay (dönüşüm hedefinde piksel olayı).
  customEventType: string | null;
  targetingHash: string | null;
  metaUpdatedAt: Date | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Meta bütçeleri minor unit metnidir ("2000"); "0" bütçe yok demektir.
function minor(value: unknown, zeroIsNull = true): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (zeroIsNull && number === 0) return null;
  return Math.round(number);
}

function date(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function emptyToNull(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return value;
}

// Anahtar sırasından bağımsız JSON (özet için).
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

// FNV-1a (32 bit, iki tur): kriptografik değil, yalnız değişim algılamak için.
export function shortHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 + 0x100) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function advantageState(targeting: unknown): string | null {
  if (!targeting || typeof targeting !== "object") return null;
  const automation = (targeting as Record<string, unknown>)
    .targeting_automation as Record<string, unknown> | undefined;
  const value = automation?.advantage_audience;
  return value === 1 || value === "1"
    ? "ON"
    : value === 0 || value === "0"
      ? "OFF"
      : null;
}

function customEventType(promoted: unknown): string | null {
  if (!promoted || typeof promoted !== "object") return null;
  return text((promoted as Record<string, unknown>).custom_event_type);
}

export function mirrorFieldsFrom(
  raw: MetaRawObject,
  level: MirrorLevel,
): MirrorFields {
  const learning = raw.learning_stage_info;
  return {
    level,
    externalId: raw.id,
    parentExternalId:
      level === "ADSET"
        ? (text(raw.campaign_id) ?? null)
        : level === "AD"
          ? (text(raw.adset_id) ?? null)
          : null,
    campaignExternalId:
      level === "CAMPAIGN" ? raw.id : (text(raw.campaign_id) ?? null),
    name: text(raw.name) ?? raw.id,
    objective: text(raw.objective),
    optimizationGoal: text(raw.optimization_goal),
    billingEvent: text(raw.billing_event),
    bidStrategy: text(raw.bid_strategy),
    destinationType: text(raw.destination_type),
    configuredStatus: text(raw.configured_status),
    effectiveStatus: text(raw.effective_status),
    dailyBudgetMinor: minor(raw.daily_budget),
    lifetimeBudgetMinor: minor(raw.lifetime_budget),
    spendCapMinor: minor(raw.spend_cap),
    budgetRemainingMinor: minor(raw.budget_remaining, false),
    startTime: date(raw.start_time),
    endTime: date(raw.end_time),
    learningStatus: text(learning?.status),
    learningConversions:
      typeof learning?.conversions === "number" ? learning.conversions : null,
    lastSigEditAt:
      typeof learning?.last_sig_edit_ts === "number"
        ? new Date(learning.last_sig_edit_ts * 1000)
        : null,
    issues: emptyToNull(raw.issues_info),
    reviewFeedback: emptyToNull(raw.ad_review_feedback),
    failedDeliveryChecks: emptyToNull(raw.failed_delivery_checks),
    advantageState: advantageState(raw.targeting),
    creativeExternalId: text(raw.creative?.id),
    customEventType: customEventType(raw.promoted_object),
    targetingHash:
      raw.targeting === undefined
        ? null
        : shortHash(stableStringify(raw.targeting)),
    metaUpdatedAt: date(raw.updated_time),
  };
}

// Drift için izlenen alanlar. `updated_time` dahil değil: Meta onu inceleme
// sonucunda da değiştirir.
export type TrackedFields = Pick<
  MirrorFields,
  | "configuredStatus"
  | "dailyBudgetMinor"
  | "lifetimeBudgetMinor"
  | "endTime"
  | "spendCapMinor"
  | "bidStrategy"
  | "targetingHash"
  | "creativeExternalId"
>;

export function trackedOf(fields: TrackedFields): TrackedFields {
  return {
    configuredStatus: fields.configuredStatus ?? null,
    dailyBudgetMinor: fields.dailyBudgetMinor ?? null,
    lifetimeBudgetMinor: fields.lifetimeBudgetMinor ?? null,
    endTime: fields.endTime ?? null,
    spendCapMinor: fields.spendCapMinor ?? null,
    bidStrategy: fields.bidStrategy ?? null,
    targetingHash: fields.targetingHash ?? null,
    creativeExternalId: fields.creativeExternalId ?? null,
  };
}

export function trackedHash(fields: TrackedFields): string {
  const tracked = trackedOf(fields);
  return shortHash(
    stableStringify({
      ...tracked,
      endTime: tracked.endTime ? tracked.endTime.toISOString() : null,
    }),
  );
}

export type DriftChange = {
  field: keyof TrackedFields;
  from: string | number | null;
  to: string | number | null;
};

export function trackedChanges(
  before: TrackedFields,
  after: TrackedFields,
): DriftChange[] {
  const a = trackedOf(before);
  const b = trackedOf(after);
  const changes: DriftChange[] = [];
  for (const key of Object.keys(a) as (keyof TrackedFields)[]) {
    const from =
      a[key] instanceof Date ? (a[key] as Date).toISOString() : a[key];
    const to = b[key] instanceof Date ? (b[key] as Date).toISOString() : b[key];
    if (from !== to) {
      changes.push({
        field: key,
        from: from as string | number | null,
        to: to as string | number | null,
      });
    }
  }
  return changes;
}

// Zarfı aşan değişiklik (WARN): bütçe artışı, bitiş tarihinin ya da harcama
// tavanının kaldırılması, duraklatılmış nesnenin açılması. Diğerleri INFO.
export function driftSeverity(changes: DriftChange[]): "INFO" | "WARN" {
  for (const change of changes) {
    if (
      (change.field === "dailyBudgetMinor" ||
        change.field === "lifetimeBudgetMinor") &&
      typeof change.to === "number" &&
      (change.from === null ||
        (typeof change.from === "number" && change.to > change.from))
    ) {
      return "WARN";
    }
    if (
      (change.field === "endTime" || change.field === "spendCapMinor") &&
      change.from !== null &&
      change.to === null
    ) {
      return "WARN";
    }
    if (
      change.field === "configuredStatus" &&
      change.from === "PAUSED" &&
      change.to === "ACTIVE"
    ) {
      return "WARN";
    }
  }
  return "INFO";
}

// Kullanıcıya gösterilen durum (Ads account sayfası). Meta'nın ad set
// `effective_status`'unda COMPLETED değeri yoktur: bitmiş nesne end_time'dan
// anlaşılır.
export type DeliveryLabel =
  | "Active"
  | "Paused by you"
  | "Stopped by Meta"
  | "In review"
  | "Rejected"
  | "Completed"
  | "Archived"
  | "Deleted"
  | "Not delivering"
  | "Scheduled";

export function deliveryLabel(
  object: {
    configuredStatus: string | null;
    effectiveStatus: string | null;
    startTime?: Date | null;
    endTime: Date | null;
    goneAt?: Date | null;
  },
  now: Date = new Date(),
): DeliveryLabel {
  const effective = object.effectiveStatus ?? "";
  if (effective === "DELETED") return "Deleted";
  if (effective === "ARCHIVED" || object.goneAt) return "Archived";
  if (object.endTime && object.endTime.getTime() <= now.getTime()) {
    return "Completed";
  }
  if (effective === "DISAPPROVED") return "Rejected";
  if (effective === "PENDING_REVIEW" || effective === "IN_PROCESS") {
    return "In review";
  }
  if (
    object.configuredStatus === "PAUSED" ||
    effective === "PAUSED" ||
    effective === "CAMPAIGN_PAUSED" ||
    effective === "ADSET_PAUSED"
  ) {
    return "Paused by you";
  }
  if (
    effective === "WITH_ISSUES" ||
    effective === "PENDING_BILLING_INFO" ||
    effective === "DISABLED"
  ) {
    return "Stopped by Meta";
  }
  if (object.startTime && object.startTime.getTime() > now.getTime()) {
    return "Scheduled";
  }
  if (effective === "ACTIVE") return "Active";
  return "Not delivering";
}

// Teslimatı süren nesne: ACTIVE ve bitmemiş.
export function isDelivering(
  object: { effectiveStatus: string | null; endTime: Date | null },
  now: Date = new Date(),
): boolean {
  return (
    object.effectiveStatus === "ACTIVE" &&
    (!object.endTime || object.endTime.getTime() > now.getTime())
  );
}

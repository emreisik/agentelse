import type { GaTableRow } from "@/lib/website-analytics/slices";

// GA-F3 ölçüm sağlığı tipleri (docs/measurement-health.md). Saf ve her iki
// tarafta da kullanılabilir: kontroller (B), yoklamalar (C), değerlendirme
// (D) ve arayüz (E) bu sözleşmeye bağlıdır.

export const GA_CHECK_KEYS = [
  "MH1",
  "MH1_RT",
  "MH2",
  "MH3",
  "MH4",
  "MH5",
  "MH6",
  "MH7",
  "MH8",
  "MH9",
  "MH10",
  "MH11",
  "MH12",
  "MH13",
  "MH14",
  "MH15",
  "MH16",
  "MH17",
  "MH18",
  "MH19",
  "MH20",
  "MH21",
  "MH22",
  "MH23",
  "MH24",
] as const;
export type GaCheckKey = (typeof GA_CHECK_KEYS)[number];
export type GaCheckStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN";
export type GaCheckSeverity = "INFO" | "WARN" | "CRITICAL";
export type GaCheckCategory =
  | "data_flow"
  | "configuration"
  | "attribution"
  | "privacy"
  | "site_tag"
  | "other";
export type GaCheckSource = "ADMIN" | "DATA" | "SITE" | "INTEGRATION";

// Düz kanıt; her zaman `reason: string` taşır. Ham URL ya da kişisel veri
// asla yok.
export type GaCheckEvidence = Record<
  string,
  string | number | boolean | string[] | null
>;

export type GaCheckResult = {
  key: GaCheckKey;
  status: GaCheckStatus;
  severity: GaCheckSeverity;
  evidence: GaCheckEvidence;
  // Şüpheli gün adayları; yalnız MH1/MH4/MH6/MH20.
  days?: string[];
};

export type GaSiteHints = {
  tel: boolean;
  whatsapp: boolean;
  mailto: boolean;
  form: boolean;
  maps: boolean;
  checkout: boolean;
};

export type GaSiteTagResult = {
  v: 1;
  // ISO zaman
  at: string;
  host: string | null;
  outcome: "ok" | "no_site" | "blocked_by_robots" | "fetch_failed";
  pagesChecked: number;
  pagesFailed: number;
  pagesWithExpected: number;
  expectedId: string | null;
  // En çok 5, sıralı, yalnız G- kimlikleri.
  otherIds: string[];
  gtm: boolean;
  // gtag/js üzerinden GT-/AW- yüklemesi.
  googleTag: boolean;
  gtagJs: boolean;
  doubleLoad: boolean;
  consentDefault: boolean;
  cmp: string | null;
  hints: GaSiteHints;
};

export type GaPiiProbeResult = {
  v: 1;
  at: string;
  from: string;
  to: string;
  forced: boolean;
  outcome: "ok" | "error";
  pages: number;
  views: number;
  // Yalnız PII_PARAM_NAMES listesinden.
  params: string[];
  email: boolean;
  phone: boolean;
};

export type GaRealtimeState = {
  v: 1;
  // Mülk günü
  day: string;
  zeros: number;
  checks: number;
  lastAt: string | null;
  lastActive: number | null;
  // Aynı hafta günü medyan oturum sayısı.
  expected: number | null;
};

export type GaHealthDay = {
  day: string;
  sessions: number;
  engagedSessions: number;
  engagementSec: number;
  screenPageViews: number;
  keyEvents: number;
  revenueMicros: number;
  transactions: number;
  isFinal: boolean;
  // [ilk kayıtlı gün, completeThrough] içinde eksik gün → sıfırlar.
  synthetic: boolean;
};

export type GaHealthBreakdownDay = {
  day: string;
  // [country]×[sessions,engagedSessions]
  country: GaTableRow[];
  // [sessionSource]×[sessions,engagedSessions]
  source: GaTableRow[];
};

// GaReportSlice.quality'den (GaQuality); otherRow Json sütunundan asla.
export type GaHealthSliceQuality = {
  reportKey: string;
  day: string;
  thresholded: boolean;
  otherRow: boolean;
};

export type GaHealthInputs = {
  now: Date;
  // Mülk saatinde bugün
  today: string;
  propertyHour: number;
  // lastDailyDate ? addDays(lastDailyDate,-1) : null
  completeThrough: string | null;
  // En yeni sentetik olmayan GaDailyTotal günü
  latestStoredDay: string | null;
  link: {
    id: string;
    propertyId: string;
    health: string;
    createdAt: Date;
    measurementId: string | null;
    streamUri: string | null;
    timeZone: string | null;
    dataRetention: string | null;
    keyEvents: { eventName: string; countingMethod: string | null }[] | null;
    googleAdsLinks: number | null;
    lastDailyDate: string | null;
    lastDailyAt: Date | null;
    // Kimlik durumu; encryptedSecret boşsa "REVOKED", satır yoksa "MISSING".
    credentialStatus: string;
    searchConsoleReport: "on" | "off" | "unknown";
  };
  project: { domain: string | null; timeZone: string | null };
  // Artan sırada, [today-70, today-1]: kayıtlı günler + sentetik sıfır günler
  days: GaHealthDay[];
  // window28 = [yesterday-27, yesterday]
  window28: {
    from: string;
    to: string;
    coverage: Partial<
      Record<
        | "channel"
        | "source_medium"
        | "landing_page"
        | "page"
        | "events"
        | "device_country",
        number
      >
    >;
    // [sessionDefaultChannelGroup]×[sessions,engagedSessions]
    channel: GaTableRow[];
    // [sessionSource,sessionMedium]×[sessions,engagedSessions]
    sourceMedium: GaTableRow[];
    // [landingPage]×[sessions]
    landing: GaTableRow[];
    // [pagePath]×[screenPageViews]
    pages: GaTableRow[];
    // [eventName]×[eventCount,keyEvents]
    events: GaTableRow[];
    // [country]×[sessions,engagedSessions]
    country: GaTableRow[];
  };
  // window28'de gün başına: anahtarı "[email]" ya da "[phone]" içeren
  // landing_page+page dilim satırları; yalnız count>0.
  piiMarkers: { day: string; count: number }[];
  // Artan sırada, [today-35, today-1]
  breakdowns: GaHealthBreakdownDay[];
  // window28'deki her DAY dilimi
  quality: GaHealthSliceQuality[];
  suspectDays: string[];
  siteTag: GaSiteTagResult | null;
  piiProbe: GaPiiProbeResult | null;
  realtime: GaRealtimeState | null;
};

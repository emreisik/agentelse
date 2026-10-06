import type {
  GaCheckCategory,
  GaCheckEvidence,
  GaCheckKey,
  GaCheckSeverity,
  GaCheckStatus,
} from "./types";

// GA-F3 ekran tipleri (yalnız tip): okuyucular (D) üretir, arayüz (E) ve
// sıradaki adım (journey) tüketir.

export type MeasurementTone = "ok" | "warning" | "error" | "unknown";

export type MeasurementSummary = {
  score: number | null;
  tone: MeasurementTone;
  label: string;
  issues: number;
  critical: number;
  evaluatedAt: string | null;
};

export type MeasurementCheckView = {
  key: GaCheckKey;
  code: string;
  title: string;
  category: GaCheckCategory;
  status: GaCheckStatus;
  severity: GaCheckSeverity;
  evidence: GaCheckEvidence;
  guideId: string;
  alertId: string | null;
  firstFailedAt: string | null;
  lastCheckedAt: string;
};

export type MeasurementHealthView = {
  propertyId: string;
  summary: MeasurementSummary;
  checks: MeasurementCheckView[];
  suspectDays: string[];
  recheckAvailableAt: string | null;
  timeZone: string;
  siteCheckedAt: string | null;
};

export type WebsiteJourneyFacts = {
  analytics: "connected" | "not_connected";
  hasDomain: boolean;
  fix: {
    checkKey: GaCheckKey;
    title: string;
    href: string;
    critical: boolean;
  } | null;
};

export type GaMeasurementCounters = {
  linksChecked: number;
  linksDue: number;
  checksFailing: number;
  checksWarning: number;
  checksUnknown: number;
  alertsCritical: number;
  alertsWarn: number;
  scoreBuckets: { good: number; fair: number; poor: number; none: number };
  lastRunMinutesAgo: number | null;
};

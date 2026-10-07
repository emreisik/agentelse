import type {
  GeoCheckId,
  GeoCrawlerRow,
  GeoFacts,
  GeoStatus,
  LlmsFacts,
} from "./types";

// Search sayfasındaki "AI search visibility" bölümünün görünüm tipleri (SC-F8).
// Saf dosya; sunucu panel.ts üretir, bileşenler yalnız bunları çizer.

export type GeoCheckView = {
  id: GeoCheckId;
  status: GeoStatus;
  title: string;
  why: string;
  how: string;
  recommendation: string | null;
  facts: GeoFacts;
  canAcknowledge: boolean;
};

// Son 28 gün ve önceki 28 gün; yalnız canlı okunur, hiçbir yerde saklanmaz.
export type AiTrafficView = {
  from: string;
  to: string;
  sessions: number;
  previousSessions: number;
  keyEvents: number;
  sharePct: number | null;
  assistants: { name: string; sessions: number; previousSessions: number }[];
  domainMatch: "match" | "unknown";
};

export type GeoPanel = {
  enabled: boolean;
  state: "waiting" | "ready" | "needs_crawl";
  score: number | null;
  previousScore: number | null;
  checks: GeoCheckView[];
  crawlers: GeoCrawlerRow[];
  llms: { state: LlmsFacts["state"]; draft: string | null };
  auditedAt: string | null;
  canAuditNow: boolean;
  canAcknowledge: boolean;
  recommendationSource: "ai" | "template" | null;
  traffic: AiTrafficView | null;
};

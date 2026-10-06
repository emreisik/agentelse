import {
  maskGooglePath,
  maskGoogleText,
} from "@/server/integrations/google/pii";

import { daysIn } from "./baseline";
import { GaSubjects, periodOf } from "./keys";
import { capLabel, landingRowsByPath } from "./landing-pages";
import type {
  An9Evidence,
  An10Evidence,
  GaFindingCandidate,
  GaWeeklyAnalysisInput,
} from "./types";

// GA-F4 içerik kuralları (docs/website-insights.md): AN9 "bulunamadı"
// sayfalarına giden görüntülemeler (kırık bağlantı riski) ve AN10 sitenin
// ortalamasından belirgin biçimde daha çok etkileşim alan içerik sayfaları
// (aylık). Desenler başlık ve yol için; diller TR, MK, RS, AL, BG, GR, DE,
// EN. Saf modül, hata atmaz.

export const NOT_FOUND_TITLE_PATTERN =
  /(\b404\b|not found|page not found|nicht gefunden|bulunamad[ıi]|не е пронајден|nije prona[đd]en|δεν βρέθηκε|не е намерена|nuk u gjet)/i;
export const NOT_FOUND_PATH_PATTERN =
  /(^|\/)(404|not-found|page-not-found)(\/|$|\.html?$)/i;
export const CONTENT_PATH_PATTERN =
  /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(blog|news|articles?|insights|guides?|resources|haber(ler)?|makale(ler)?|yazilar|vesti|novosti|blog-posts)(\/|$)/i;

// ---- AN9 ----

const AN9_MIN_VIEWS = 10;
const AN9_SIGNIFICANT_VIEWS = 30;
const AN9_MAX_PAGES = 5;

// pages tablosundaki [pagePath, pageTitle] satırı "bulunamadı" sayfası mı.
export function isNotFoundPage(path: string, title: string): boolean {
  return (
    NOT_FOUND_PATH_PATTERN.test(path) || NOT_FOUND_TITLE_PATTERN.test(title)
  );
}

// Kanıt ve sonuç ölçümü aynı yol biçimini kullanır.
export function notFoundPathLabel(raw: string): string {
  return capLabel(maskGooglePath(raw));
}

export function evaluateNotFound(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate | null {
  const matches = input.current.pages
    .filter(
      (row) =>
        (row.values[0] ?? 0) > 0 &&
        isNotFoundPage(
          maskGooglePath(row.key[0] ?? ""),
          maskGoogleText(row.key[1] ?? ""),
        ),
    )
    .map((row) => ({
      path: notFoundPathLabel(row.key[0] ?? ""),
      title: capLabel(maskGoogleText(row.key[1] ?? "")),
      views: row.values[0] ?? 0,
    }));
  const views = matches.reduce((sum, row) => sum + row.views, 0);
  if (views < AN9_MIN_VIEWS) return null;

  const week = { from: input.week.monday, to: input.week.sunday };
  const evidence: An9Evidence = {
    v: 1,
    rule: "AN9",
    week,
    pages: matches
      .sort((a, b) => b.views - a.views || a.path.localeCompare(b.path))
      .slice(0, AN9_MAX_PAGES),
    views,
  };
  return {
    ruleKey: "AN9",
    kind: "RISK",
    subject: GaSubjects.notFound(),
    period: periodOf("WEEK", week),
    severity: "INFO",
    confidence: views >= AN9_SIGNIFICANT_VIEWS ? "SIGNIFICANT" : "DIRECTIONAL",
    evidence,
    impact: {
      metric: "views",
      perWeek: views,
      low: views,
      high: views,
      directional: false,
    },
    impactShare: Math.min(
      1,
      views / Math.max(1, input.current.totals.screenPageViews),
    ),
  };
}

// ---- AN10 ----

const AN10_MIN_SESSIONS = 50;
const AN10_ENGAGEMENT_RATIO = 1.2;
const AN10_MIN_PAGES = 2;
const AN10_MAX_PAGES = 5;
// Karar: içerik etkileşiminin savunulur bir dönüşüm tahmini yok; sabit pay.
const AN10_IMPACT_SHARE = 0.1;

export function evaluateContentEngagement(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate | null {
  if (!input.month) return null;
  const { current } = input.month;
  const totals = current.totals;
  if (totals.sessions <= 0) return null;
  const siteEngagementRate = totals.engagedSessions / totals.sessions;
  const siteAvgEngagementSec = totals.engagementSec / totals.sessions;

  const pages = landingRowsByPath(current.landing)
    .filter(
      (row) =>
        row.sessions >= AN10_MIN_SESSIONS &&
        CONTENT_PATH_PATTERN.test(row.path),
    )
    .map((row) => ({
      path: row.path,
      sessions: row.sessions,
      engagementRate: row.engagedSessions / row.sessions,
      avgEngagementSec: row.engagementSec / row.sessions,
      keyEvents: row.keyEvents,
    }))
    .filter(
      (row) => row.engagementRate >= AN10_ENGAGEMENT_RATIO * siteEngagementRate,
    );
  if (pages.length < AN10_MIN_PAGES) return null;

  const window = { from: current.from, to: current.to };
  const evidence: An10Evidence = {
    v: 1,
    rule: "AN10",
    window,
    month: input.month.month,
    pages: pages
      .sort(
        (a, b) =>
          b.engagementRate * b.avgEngagementSec -
            a.engagementRate * a.avgEngagementSec ||
          a.path.localeCompare(b.path),
      )
      .slice(0, AN10_MAX_PAGES),
    siteEngagementRate,
    siteAvgEngagementSec,
    holidays: daysIn(window, input.holidays),
  };
  return {
    ruleKey: "AN10",
    kind: "WIN",
    subject: GaSubjects.content(),
    period: periodOf("MONTH", window),
    severity: "INFO",
    confidence: "DIRECTIONAL",
    evidence,
    impact: null,
    impactShare: AN10_IMPACT_SHARE,
  };
}

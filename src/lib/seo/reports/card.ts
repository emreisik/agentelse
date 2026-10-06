import { isSeoReportKind, type SeoReportKind } from "./types";
import { SEO_REPORT_TITLE } from "./text";

// Sohbetteki "seo-report" kartı (docs/search-reports.md "Kart"): rapora
// işaret eden bir göstergedir; Google sayısı, sorgu ya da adres taşımaz.
// Rapor, kart açılınca no-store uçtan tembel yüklenir. Saf ve izomorfik.

export type SeoReportCardData = {
  kind: "seo-report";
  reportId: string;
  reportKind: SeoReportKind;
  title: string;
  periodLabel: string;
};

export function seoReportCard(input: {
  reportId: string;
  kind: SeoReportKind;
  periodLabel: string;
}): SeoReportCardData {
  return {
    kind: "seo-report",
    reportId: input.reportId,
    reportKind: input.kind,
    title: SEO_REPORT_TITLE[input.kind],
    periodLabel: input.periodLabel,
  };
}

export function isSeoReportCard(value: unknown): value is SeoReportCardData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "seo-report" &&
    typeof record.reportId === "string" &&
    record.reportId.length > 0 &&
    typeof record.title === "string" &&
    typeof record.periodLabel === "string" &&
    isSeoReportKind(record.reportKind)
  );
}

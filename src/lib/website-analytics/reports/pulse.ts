import { sameWeekdayBaseline } from "@/lib/website-analytics/analysis/baseline";
import { median, robustZ } from "@/lib/website-analytics/analysis/stats";
import type { GaAnalysisDay } from "@/lib/website-analytics/analysis/types";
import { aggregateSlices } from "@/lib/website-analytics/slices";

import { alertHref, reportHrefs } from "./ids";
import { findingSnap, roundedChangePct } from "./sections";
import {
  REPORT_CAPS,
  type PulseAlert,
  type PulseBody,
  type PulseChange,
  type PulseInput,
  type PulseKpi,
  type PulseReason,
  type ReportValueFormat,
} from "./types";

// GA-F5 günlük nabız değerlendirmesi: dünün rakamları aynı hafta gününün 8
// haftalık seyriyle karşılaştırılır; yalnız kayda değer bir şey varsa
// (yeni uyarı, olağandışı ölçü, GA-F4 anomalisi) kart yazılır. Şablon metin,
// LLM yok. Saf ve izomorfik.

// Sağlam z eşiği ve en az değişim yüzdesi: ikisi birden aranır.
export const PULSE_Z = 3;
export const PULSE_MIN_CHANGE_PCT = 20;

const BASELINE_WEEKS = 8;
const BASELINE_MIN_VALUES = 3;
// Hacim kapıları: seyir bunun altındaysa ölçü "olağandışı" sayılmaz.
const MIN_MEDIAN_SESSIONS = 20;
const MIN_MEDIAN_KEY_EVENTS = 3;
// Kanal değişimi en az bu kadar oturum olmalı.
const MIN_CHANNEL_CHANGE = 10;

type PulseMetric = {
  key: PulseKpi["key"];
  label: string;
  format: ReportValueFormat;
  pick: (day: GaAnalysisDay) => number | null;
};

const METRICS: readonly PulseMetric[] = [
  {
    key: "sessions",
    label: "Sessions",
    format: "count",
    pick: (day) => day.sessions,
  },
  {
    key: "keyEvents",
    label: "Key events",
    format: "count",
    pick: (day) => day.keyEvents,
  },
  {
    key: "engagementRate",
    label: "Engagement rate",
    format: "percent",
    pick: (day) =>
      day.sessions > 0 ? (day.engagedSessions / day.sessions) * 100 : null,
  },
  {
    key: "revenue",
    label: "Revenue",
    format: "money",
    pick: (day) => day.revenue,
  },
];

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Gösterilen değerler biçime göre yuvarlanır; kart yalnız bunları tutar.
function roundFor(format: ReportValueFormat, value: number): number {
  if (format === "count") return Math.round(value);
  return format === "money" ? round2(value) : round1(value);
}

// Ölçünün gürültü tabanı: sayımda √medyan, oranda iki terimli sapma
// (√(p(1-p)/n)), parada √medyan.
function noiseFloor(
  key: PulseKpi["key"],
  usual: number,
  sessionsMedian: number,
): number {
  if (key === "engagementRate") {
    const p = Math.min(1, Math.max(0, usual / 100));
    return Math.sqrt((p * (1 - p)) / Math.max(sessionsMedian, 1)) * 100;
  }
  return Math.sqrt(Math.max(usual, 1));
}

function passesVolumeGate(
  key: PulseKpi["key"],
  usual: number,
  sessionsMedian: number,
): boolean {
  switch (key) {
    case "sessions":
    case "engagementRate":
      return sessionsMedian >= MIN_MEDIAN_SESSIONS;
    case "keyEvents":
      return usual >= MIN_MEDIAN_KEY_EVENTS;
    case "revenue":
      return usual > 0;
  }
}

function evaluateKpis(input: PulseInput, exclude: ReadonlySet<string>) {
  const dayRow = input.days.find((day) => day.day === input.day);
  if (!dayRow) return [];
  const options = {
    exclude,
    weeks: BASELINE_WEEKS,
    minValues: BASELINE_MIN_VALUES,
  };
  const sessionsBaseline = sameWeekdayBaseline(
    input.days,
    input.day,
    METRICS[0]!.pick,
    options,
  );
  const sessionsMedian = sessionsBaseline
    ? (median(sessionsBaseline.values) ?? 0)
    : 0;
  const holidayOrSuspect =
    input.holidays.has(input.day) || input.suspect.has(input.day);
  const kpis: PulseKpi[] = [];
  for (const metric of METRICS) {
    const value = metric.pick(dayRow);
    if (value === null) continue;
    const baseline = sameWeekdayBaseline(
      input.days,
      input.day,
      metric.pick,
      options,
    );
    const usual = baseline ? median(baseline.values) : null;
    // Gelir yalnız o gün ya da seyri > 0 ise gösterilir.
    if (metric.key === "revenue" && value <= 0 && !(usual && usual > 0)) {
      continue;
    }
    let unusual = false;
    if (baseline && usual !== null && !holidayOrSuspect) {
      const reading = robustZ(
        value,
        baseline.values,
        noiseFloor(metric.key, usual, sessionsMedian),
      );
      const change = roundedChangePct(value, usual);
      unusual =
        reading !== null &&
        Math.abs(reading.z) >= PULSE_Z &&
        change !== null &&
        Math.abs(change) >= PULSE_MIN_CHANGE_PCT &&
        passesVolumeGate(metric.key, usual, sessionsMedian);
    }
    kpis.push({
      key: metric.key,
      label: metric.label,
      format: metric.format,
      value: roundFor(metric.format, value),
      usual: usual === null ? null : roundFor(metric.format, usual),
      changePct: roundedChangePct(value, usual),
      unusual,
    });
  }
  return kpis;
}

// Kanal başına dünkü oturum, aynı hafta gününün medyanıyla kıyaslanır; en
// büyük iki sapma (en az 10 oturum) döner.
function evaluateChannelChanges(
  input: PulseInput,
  exclude: ReadonlySet<string>,
): PulseChange[] {
  const perDay = new Map<string, Map<string, number>>();
  for (const { day, slice } of input.channelDays) {
    const rows = aggregateSlices(
      [slice],
      ["sessionDefaultChannelGroup"],
      ["sessions"],
    );
    perDay.set(
      day,
      new Map(
        rows.map((row) => [row.key[0] ?? "(not set)", row.values[0] ?? 0]),
      ),
    );
  }
  const today = perDay.get(input.day);
  if (!today) return [];
  const baselineDays = [...perDay.keys()].filter(
    (day) => day !== input.day && !exclude.has(day),
  );
  if (baselineDays.length < BASELINE_MIN_VALUES) return [];
  const channels = new Set<string>();
  for (const day of [input.day, ...baselineDays]) {
    for (const name of perDay.get(day)?.keys() ?? []) channels.add(name);
  }
  const changes: PulseChange[] = [];
  for (const channel of channels) {
    // Satırı olmayan kanal o gün 0 oturum almıştır.
    const usual = median(
      baselineDays.map((day) => perDay.get(day)?.get(channel) ?? 0),
    );
    if (usual === null) continue;
    const sessions = today.get(channel) ?? 0;
    const change = sessions - usual;
    if (Math.abs(change) < MIN_CHANNEL_CHANGE) continue;
    changes.push({
      channel,
      sessions: Math.round(sessions),
      usual: Math.round(usual),
      change: Math.round(change),
    });
  }
  return changes
    .sort(
      (a, b) =>
        Math.abs(b.change) - Math.abs(a.change) ||
        a.channel.localeCompare(b.channel),
    )
    .slice(0, REPORT_CAPS.pulseChanges);
}

export function evaluatePulse(input: PulseInput): PulseBody {
  const hrefs = reportHrefs(input.link.projectId, input.websitePage);
  const exclude = new Set<string>([...input.suspect, ...input.holidays]);
  const kpis = evaluateKpis(input, exclude);
  const unusual = kpis.some((kpi) => kpi.unusual);

  const alerts: PulseAlert[] = input.alerts
    .map((alert) => ({
      title: alert.title,
      severity: alert.severity,
      href: alertHref(alert.kind, hrefs),
      isNew: alert.isNew,
    }))
    // CRITICAL önce; kendi içinde gelen sıra korunur.
    .sort(
      (a, b) =>
        Number(b.severity === "CRITICAL") - Number(a.severity === "CRITICAL"),
    )
    .slice(0, REPORT_CAPS.alerts);

  const anomalies = input.anomalies
    .slice(0, REPORT_CAPS.anomalies)
    .map((view) =>
      findingSnap(view, {
        currency: input.link.currency,
        timeZone: input.link.timeZone,
        href: hrefs.finding(view.id),
      }),
    );

  const reasons: PulseReason[] = [];
  if (alerts.some((alert) => alert.isNew)) reasons.push("alert");
  if (unusual) reasons.push("unusual");
  if (anomalies.length > 0) reasons.push("anomaly");

  return {
    variant: "pulse",
    day: input.day,
    kpis,
    // Kanal değişimleri yalnız olağandışı bir ölçü varken anlam taşır.
    changes: unusual ? evaluateChannelChanges(input, exclude) : [],
    alerts,
    anomalies,
    holiday: input.holidays.has(input.day),
    suspect: input.suspect.has(input.day),
    reasons,
  };
}

// Kart yazılsın mı: en az bir neden varsa.
export function pulseWorthy(body: PulseBody): boolean {
  return body.reasons.length > 0;
}

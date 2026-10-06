import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/website-analytics/days";
import type { GaAnalysisDay } from "@/lib/website-analytics/analysis/types";
import type { GaFindingView } from "@/lib/website-analytics/analysis/view-types";
import type { GaStoredSlice } from "@/lib/website-analytics/slices";

import {
  evaluatePulse,
  PULSE_MIN_CHANGE_PCT,
  PULSE_Z,
  pulseWorthy,
} from "./pulse";
import type { PulseInput } from "./types";

// Bu dosyanın kanıtladığı: nabız yalnız yeni uyarı, olağandışı ölçü ya da
// anomali varken değer görür; tatil/şüpheli gün, düşük hacim ve küçük
// değişim "olağandışı" sayılmaz; kanal değişimi en çok 2.

const DAY = "2026-10-05"; // Pazartesi
const FIRST = addDays(DAY, -63);

function makeDays(
  sessionsOf: (day: string, index: number) => number,
  keyEventRate = 0.05,
): GaAnalysisDay[] {
  return Array.from({ length: 64 }, (_, index) => {
    const day = addDays(FIRST, index);
    const sessions = sessionsOf(day, index);
    return {
      day,
      sessions,
      engagedSessions: Math.round(sessions * 0.6),
      keyEvents: Math.round(sessions * keyEventRate),
      revenue: 0,
      transactions: 0,
      isFinal: true,
    };
  });
}

// Sekiz haftalık sabit seyir; hedef gün `value` oturum.
function series(value: number, usual = 100, keyEventRate = 0.05) {
  return makeDays((day) => (day === DAY ? value : usual), keyEventRate);
}

function channelSlice(day: string, rows: [string, number][]): GaStoredSlice {
  return {
    day,
    dimensionHeaders: ["sessionDefaultChannelGroup"],
    metricHeaders: ["sessions"],
    rows: rows.map(([name, sessions]) => [name, sessions]),
    truncated: false,
    otherRow: null,
    quality: {},
  };
}

function baseInput(partial: Partial<PulseInput> = {}): PulseInput {
  return {
    link: {
      projectId: "p1",
      linkId: "l1",
      propertyName: "Shop",
      timeZone: "Europe/Skopje",
      currency: "EUR",
      isMock: false,
      dataThrough: DAY,
    },
    builtAt: "2026-10-06T08:00:00.000Z",
    websitePage: true,
    day: DAY,
    days: series(100),
    suspect: new Set<string>(),
    holidays: new Set<string>(),
    channelDays: [],
    alerts: [],
    anomalies: [],
    ...partial,
  };
}

const ANOMALY: GaFindingView = {
  id: "f-an15",
  ruleKey: "AN15",
  kind: "RISK",
  subject: "goal",
  subjectLabel: "Goal",
  period: { grain: "DAY", from: DAY, to: DAY, key: DAY },
  severity: "WARN",
  confidence: "SIGNIFICANT",
  status: "OPEN",
  mode: "live",
  priority: 0.5,
  evidence: {
    v: 1,
    rule: "AN15",
    goalId: "g1",
    goalTitle: "Website sessions per month",
    metricKey: "web.sessions",
    month: "2026-10",
    target: 1000,
    monthToDate: 300,
    forecast: 800,
    paceRatio: 0.8,
    dayOfMonth: 5,
    daysInMonth: 31,
    through: DAY,
  },
  impact: null,
  explanation: null,
  occurrences: 1,
  evaluable: false,
  preliminary: false,
  createdAt: "2026-10-06T08:00:00.000Z",
  acceptedAt: null,
  doneAt: null,
  evaluateAfter: null,
  evaluatedAt: null,
  outcome: null,
  reviewVerdict: null,
};

describe("evaluatePulse unusual metrics", () => {
  it("flags a 60% drop against a stable eight week series", () => {
    const body = evaluatePulse(baseInput({ days: series(40) }));
    const sessions = body.kpis.find((kpi) => kpi.key === "sessions");
    expect(sessions).toMatchObject({
      value: 40,
      usual: 100,
      changePct: -60,
      unusual: true,
    });
    expect(body.reasons).toEqual(["unusual"]);
    expect(pulseWorthy(body)).toBe(true);
    // Oranlar aynı kaldığı için etkileşim oranı olağandışı değil.
    expect(body.kpis.find((kpi) => kpi.key === "engagementRate")?.unusual).toBe(
      false,
    );
  });

  it("stays quiet on a holiday or a suspect day", () => {
    const holiday = evaluatePulse(
      baseInput({ days: series(40), holidays: new Set([DAY]) }),
    );
    expect(holiday.reasons).toEqual([]);
    expect(holiday.holiday).toBe(true);
    expect(holiday.kpis.some((kpi) => kpi.unusual)).toBe(false);
    const suspect = evaluatePulse(
      baseInput({ days: series(40), suspect: new Set([DAY]) }),
    );
    expect(suspect.reasons).toEqual([]);
    expect(suspect.suspect).toBe(true);
  });

  it("never calls a metric unusual when the usual volume is under the gate", () => {
    // Medyan 19 oturum: düşüş büyük olsa da hacim kapısı geçilmez.
    const body = evaluatePulse(baseInput({ days: series(5, 19) }));
    expect(body.kpis.some((kpi) => kpi.unusual)).toBe(false);
    expect(body.reasons).toEqual([]);
  });

  it("needs both the z score and a 20% change", () => {
    // Medyan 1000: taban √1000 ≈ 31.6; 150'lik düşüş z ≈ -4.7 ama değişim %15.
    const body = evaluatePulse(baseInput({ days: series(850, 1000) }));
    const sessions = body.kpis.find((kpi) => kpi.key === "sessions");
    expect(sessions?.changePct).toBe(-15);
    expect(Math.abs(sessions?.changePct ?? 0)).toBeLessThan(
      PULSE_MIN_CHANGE_PCT,
    );
    expect(sessions?.unusual).toBe(false);
    expect(PULSE_Z).toBe(3);
  });

  it("flags a collapse of key events on a normal traffic day", () => {
    // %20 oran: 100 oturumda 20 key event; hedef gün oturum aynı, key event 2.
    const days = makeDays(() => 100, 0.2);
    const last = days[days.length - 1];
    if (!last) throw new Error("fixture");
    last.keyEvents = 2;
    const body = evaluatePulse(baseInput({ days }));
    expect(body.kpis.find((kpi) => kpi.key === "keyEvents")).toMatchObject({
      value: 2,
      usual: 20,
      changePct: -90,
      unusual: true,
    });
    expect(body.kpis.find((kpi) => kpi.key === "sessions")?.unusual).toBe(
      false,
    );
  });

  it("adds revenue only when the day or its usual has revenue", () => {
    const none = evaluatePulse(baseInput());
    expect(none.kpis.some((kpi) => kpi.key === "revenue")).toBe(false);
    const days = makeDays(() => 100);
    for (const row of days) row.revenue = 50;
    const last = days[days.length - 1];
    if (!last) throw new Error("fixture");
    last.revenue = 5;
    const body = evaluatePulse(baseInput({ days }));
    expect(body.kpis.find((kpi) => kpi.key === "revenue")).toMatchObject({
      value: 5,
      usual: 50,
      format: "money",
    });
  });

  it("returns no KPIs when the day row is missing", () => {
    const days = series(100).filter((row) => row.day !== DAY);
    const body = evaluatePulse(
      baseInput({
        days,
        alerts: [
          {
            id: "a1",
            kind: "GA_MH1",
            title: "Tracking stopped",
            severity: "CRITICAL",
            firstSeenAt: "2026-10-06T00:00:00.000Z",
            isNew: true,
          },
        ],
      }),
    );
    expect(body.kpis).toEqual([]);
    expect(body.reasons).toEqual(["alert"]);
  });
});

describe("evaluatePulse alerts and anomalies", () => {
  const alert = (
    id: string,
    isNew: boolean,
    severity: "WARN" | "CRITICAL" = "WARN",
    kind = "GA_MH3",
  ) => ({
    id,
    kind,
    title: `Alert ${id}`,
    severity,
    firstSeenAt: "2026-10-04T00:00:00.000Z",
    isNew,
  });

  it("gives a new alert alone the reason alert", () => {
    const body = evaluatePulse(baseInput({ alerts: [alert("a", true)] }));
    expect(body.reasons).toEqual(["alert"]);
    expect(pulseWorthy(body)).toBe(true);
  });

  it("lists old open alerts without making the pulse worthy", () => {
    const body = evaluatePulse(
      baseInput({ alerts: [alert("a", false), alert("b", false)] }),
    );
    expect(body.reasons).toEqual([]);
    expect(body.alerts).toHaveLength(2);
    expect(pulseWorthy(body)).toBe(false);
  });

  it("puts critical alerts first and caps the list at five", () => {
    const alerts = [
      ...Array.from({ length: 5 }, (_, index) => alert(`w${index}`, false)),
      alert("c", false, "CRITICAL"),
    ];
    const body = evaluatePulse(baseInput({ alerts }));
    expect(body.alerts).toHaveLength(5);
    expect(body.alerts[0]?.severity).toBe("CRITICAL");
  });

  it("links a GA_MH24 alert to the integrations dialog", () => {
    const body = evaluatePulse(
      baseInput({
        alerts: [alert("a", true, "CRITICAL", "GA_MH24"), alert("b", true)],
      }),
    );
    expect(body.alerts[0]?.href).toBe(
      "/projects/p1/integrations?integration=google_analytics",
    );
    expect(body.alerts[1]?.href).toBe("/projects/p1/site#measurement-health");
  });

  it("gives an anomaly its own reason and caps them at two", () => {
    const body = evaluatePulse(
      baseInput({
        anomalies: [
          ANOMALY,
          { ...ANOMALY, id: "f2" },
          { ...ANOMALY, id: "f3" },
        ],
      }),
    );
    expect(body.reasons).toEqual(["anomaly"]);
    expect(body.anomalies).toHaveLength(2);
    expect(body.anomalies[0]?.href).toBe("/projects/p1/site#finding-f-an15");
  });

  it("orders the reasons alert, unusual, anomaly", () => {
    const body = evaluatePulse(
      baseInput({
        days: series(40),
        alerts: [alert("a", true)],
        anomalies: [ANOMALY],
      }),
    );
    expect(body.reasons).toEqual(["alert", "unusual", "anomaly"]);
  });

  it("is quiet on an ordinary day", () => {
    const body = evaluatePulse(baseInput());
    expect(body.reasons).toEqual([]);
    expect(pulseWorthy(body)).toBe(false);
    expect(body.kpis.length).toBeGreaterThan(0);
  });
});

describe("evaluatePulse channel changes", () => {
  // Hedef gün + önceki 8 hafta aynı hafta günü.
  function channelDays(today: [string, number][], usual: [string, number][]) {
    return [
      { day: DAY, slice: channelSlice(DAY, today) },
      ...Array.from({ length: 8 }, (_, index) => {
        const day = addDays(DAY, -7 * (index + 1));
        return { day, slice: channelSlice(day, usual) };
      }),
    ];
  }

  it("lists at most two channel changes of at least ten sessions", () => {
    const body = evaluatePulse(
      baseInput({
        days: series(40),
        channelDays: channelDays(
          [
            ["Direct", 10],
            ["Organic Search", 5],
            ["Paid Search", 8],
            ["Email", 20],
            ["Referral", 49],
          ],
          [
            ["Direct", 40],
            ["Organic Search", 30],
            ["Paid Search", 20],
            ["Email", 22],
            ["Referral", 50],
          ],
        ),
      }),
    );
    expect(body.changes).toEqual([
      { channel: "Direct", sessions: 10, usual: 40, change: -30 },
      { channel: "Organic Search", sessions: 5, usual: 30, change: -25 },
    ]);
  });

  it("treats a channel missing today as zero sessions", () => {
    const body = evaluatePulse(
      baseInput({
        days: series(40),
        channelDays: channelDays(
          [["Direct", 5]],
          [
            ["Email", 30],
            ["Direct", 5],
          ],
        ),
      }),
    );
    expect(body.changes).toEqual([
      { channel: "Email", sessions: 0, usual: 30, change: -30 },
    ]);
  });

  it("gives no channel changes when nothing is unusual", () => {
    const body = evaluatePulse(
      baseInput({
        channelDays: channelDays([["Direct", 1]], [["Direct", 90]]),
      }),
    );
    expect(body.changes).toEqual([]);
  });
});

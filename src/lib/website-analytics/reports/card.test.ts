import { describe, expect, it } from "vitest";

import { isWebsiteReportCard, readWebsiteReportCard } from "./card";
import { paidTrafficTable } from "./sections";
import {
  sampleAlertCard,
  sampleMonthlyCard,
  samplePlanCard,
  samplePulseCard,
  sampleWeeklyCard,
} from "./test-fixtures";
import { REPORT_CAPS, type WebsiteReportCardData } from "./types";

// Bu dosyanın kanıtladığı: saklanan kart JSON gidiş dönüşünde birebir okunur;
// bozuk, gelecek sürümden ya da çeşidi gövdeyle uyuşmayan kart null olur;
// bozuk satırlar düşer, uzun listeler kısılır, bilinmeyen alanlar atılır ve
// okuyucu hiçbir girdide fırlatmaz.

const SAMPLES: [string, () => WebsiteReportCardData][] = [
  ["pulse", samplePulseCard],
  ["weekly", sampleWeeklyCard],
  ["monthly", sampleMonthlyCard],
  ["plan", samplePlanCard],
  ["alert", sampleAlertCard],
];

function json(card: WebsiteReportCardData): Record<string, unknown> {
  return JSON.parse(JSON.stringify(card)) as Record<string, unknown>;
}

function bodyOf(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.body as Record<string, unknown>;
}

describe("readWebsiteReportCard", () => {
  it.each(SAMPLES)("round-trips the %s sample through JSON", (_name, make) => {
    const card = make();
    expect(readWebsiteReportCard(json(card))).toEqual(card);
  });

  it("recognises cards by kind", () => {
    expect(isWebsiteReportCard(json(sampleWeeklyCard()))).toBe(true);
    expect(isWebsiteReportCard({ kind: "ads-insight" })).toBe(false);
    expect(isWebsiteReportCard(null)).toBe(false);
    expect(isWebsiteReportCard("website-report")).toBe(false);
    expect(isWebsiteReportCard([])).toBe(false);
  });

  it("returns null for non-objects", () => {
    for (const value of [null, undefined, 1, "x", [], true]) {
      expect(readWebsiteReportCard(value)).toBeNull();
    }
    expect(readWebsiteReportCard({})).toBeNull();
  });

  it("returns null when the variant and the body disagree", () => {
    const raw = json(sampleWeeklyCard());
    raw.variant = "monthly";
    expect(readWebsiteReportCard(raw)).toBeNull();
    const unknown = json(sampleWeeklyCard());
    unknown.variant = "daily";
    expect(readWebsiteReportCard(unknown)).toBeNull();
  });

  it("returns null for a future version or a missing body", () => {
    const future = json(sampleWeeklyCard());
    future.v = 2;
    expect(readWebsiteReportCard(future)).toBeNull();
    const noBody = json(sampleWeeklyCard());
    delete noBody.body;
    expect(readWebsiteReportCard(noBody)).toBeNull();
    const wrongKind = json(sampleWeeklyCard());
    wrongKind.kind = "ads-insight";
    expect(readWebsiteReportCard(wrongKind)).toBeNull();
  });

  it("caps over-long lists", () => {
    const raw = json(sampleWeeklyCard());
    const body = bodyOf(raw);
    const mover = (body.winners as unknown[])[0];
    const finding = (body.whatChanged as unknown[])[0];
    body.winners = Array.from({ length: 12 }, () => mover);
    body.whatChanged = Array.from({ length: 12 }, () => finding);
    body.opportunities = Array.from({ length: 12 }, () => finding);
    body.nextSteps = ["a", "b", "c", "d", "e"];
    const card = readWebsiteReportCard(raw);
    if (!card || card.body.variant !== "weekly") throw new Error("unreadable");
    expect(card.body.winners).toHaveLength(REPORT_CAPS.movers);
    expect(card.body.whatChanged).toHaveLength(REPORT_CAPS.whatChanged);
    expect(card.body.opportunities).toHaveLength(REPORT_CAPS.opportunities);
    expect(card.body.nextSteps).toEqual(["a", "b", "c"]);
  });

  it("caps table rows and monthly lists", () => {
    const raw = json(sampleMonthlyCard());
    const body = bodyOf(raw);
    const topPages = body.topPages as { rows: unknown[] };
    const row = topPages.rows[0];
    topPages.rows = Array.from({ length: 30 }, () => row);
    const card = readWebsiteReportCard(raw);
    if (!card || card.body.variant !== "monthly") throw new Error("unreadable");
    expect(card.body.topPages.rows).toHaveLength(REPORT_CAPS.topPages);
  });

  it("keeps the campaign rows of a built paid traffic table", () => {
    // Kanal satırları + kampanya satırları birlikte okunur: kampanyalar sonda
    // olduğundan kısa bir okuyucu sınırı onları sessizce kaybederdi.
    const metrics = ["sessions", "engagedSessions", "keyEvents"];
    const slice = (
      dimensionHeaders: string[],
      rows: (string | number)[][],
    ) => ({
      day: "2026-09-10",
      dimensionHeaders,
      metricHeaders: metrics,
      rows,
      truncated: false,
      otherRow: null,
      quality: {},
    });
    const table = paidTrafficTable(
      [
        slice(
          ["sessionDefaultChannelGroup"],
          [
            ["Paid Search", 200, 100, 10],
            ["Paid Social", 150, 80, 8],
            ["Display", 50, 10, 1],
          ],
        ),
      ],
      [
        slice(
          ["sessionCampaignName", "sessionSource", "sessionMedium"],
          Array.from({ length: 6 }, (_, index) => [
            `camp-${index}`,
            "google",
            "cpc",
            100 - index,
            50,
            5,
          ]),
        ),
      ],
    );
    if (!table) throw new Error("no table");
    expect(table.rows).toHaveLength(3 + REPORT_CAPS.paidTraffic);
    const raw = json(sampleMonthlyCard());
    bodyOf(raw).paidTraffic = JSON.parse(JSON.stringify(table));
    const card = readWebsiteReportCard(raw);
    if (!card || card.body.variant !== "monthly") throw new Error("unreadable");
    expect(card.body.paidTraffic?.rows).toEqual(table.rows);
  });

  it("drops one invalid row and keeps the others", () => {
    const raw = json(sampleWeeklyCard());
    const body = bodyOf(raw);
    const kpis = body.kpis as unknown[];
    const total = kpis.length;
    body.kpis = [{ key: "sessions" }, ...kpis];
    const losers = body.losers as unknown[];
    body.losers = [losers[0], "oops", null, { page: 3 }, losers[1]];
    const card = readWebsiteReportCard(raw);
    if (!card || card.body.variant !== "weekly") throw new Error("unreadable");
    expect(card.body.kpis).toHaveLength(total);
    expect(card.body.losers).toHaveLength(2);
    expect(card.body.losers[1]?.page).toBe("/pricing/compare");
  });

  it("strips unknown keys", () => {
    const raw = json(sampleWeeklyCard());
    raw.extra = "x";
    bodyOf(raw).secret = "y";
    const firstKpi = (bodyOf(raw).kpis as Record<string, unknown>[])[0];
    if (firstKpi) firstKpi.surprise = 1;
    const card = readWebsiteReportCard(raw);
    expect(card).toEqual(sampleWeeklyCard());
    expect(card).not.toHaveProperty("extra");
    expect(card?.body).not.toHaveProperty("secret");
  });

  it("turns an invalid narrative into null and keeps the card", () => {
    const raw = json(sampleWeeklyCard());
    raw.narrative = { headline: 5, highlights: "no" };
    const card = readWebsiteReportCard(raw);
    expect(card).not.toBeNull();
    expect(card?.narrative).toBeNull();
    raw.narrative = "text";
    expect(readWebsiteReportCard(raw)?.narrative).toBeNull();
  });

  it("falls back to empty tables and defaults for missing optional parts", () => {
    const raw = json(sampleWeeklyCard());
    const body = bodyOf(raw);
    delete body.channels;
    delete body.measurement;
    delete body.insights;
    delete body.goals;
    const card = readWebsiteReportCard(raw);
    if (!card || card.body.variant !== "weekly") throw new Error("unreadable");
    expect(card.body.channels).toEqual({
      columns: [],
      rows: [],
      other: null,
      notes: [],
    });
    expect(card.body.measurement).toBeNull();
    expect(card.body.insights).toBe("off");
    expect(card.body.goals).toEqual([]);
  });

  it("never throws on hostile input", () => {
    const hostile: unknown[] = [
      { kind: "website-report", v: 1, variant: "weekly", body: { variant: "weekly" } },
      { kind: "website-report", v: 1, variant: "pulse", body: "x" },
      { kind: "website-report", v: 1, variant: "alert", body: [] },
      { kind: "website-report", v: "1" },
    ];
    for (const value of hostile) {
      expect(() => readWebsiteReportCard(value)).not.toThrow();
      expect(readWebsiteReportCard(value)).toBeNull();
    }
  });
});

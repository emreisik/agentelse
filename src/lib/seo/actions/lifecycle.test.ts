import { describe, expect, it } from "vitest";

import {
  ACTION_WINDOW_DAYS,
  isTerminal,
  googleSchedule,
  measuringFields,
  needsGoogleStage,
  nextActionStatus,
  staleOpenCutoffs,
  verifySchedule,
  verifyTimingFor,
  type SeoActionEvent,
} from "./lifecycle";
import {
  SEO_ACTION_STATUSES,
  SEO_FIX_KINDS,
  type SeoActionStatus,
} from "./types";

// Bu dosyanın kanıtladığı: durum makinesinin tam tablosu, ölçüm çapası,
// sorma/süre aşımı zamanlaması ve Google aşaması.

const DAY = 86_400_000;
const at = (iso: string) => new Date(iso);

const EVENTS: SeoActionEvent[] = [
  "ACCEPT",
  "DISMISS",
  "APPLY",
  "UNDO_APPLY",
  "CONFIRM_LIVE",
  "VERIFIED",
  "START_MEASURING",
  "EVALUATED",
  "EXPIRE",
];

// Beklenen tablo: olay -> geçerli durum -> yeni durum.
const TABLE: Record<SeoActionEvent, Partial<Record<SeoActionStatus, SeoActionStatus>>> = {
  ACCEPT: { PROPOSED: "ACCEPTED", ACCEPTED: "ACCEPTED" },
  DISMISS: { PROPOSED: "DISMISSED", ACCEPTED: "DISMISSED" },
  APPLY: { PROPOSED: "APPLIED", ACCEPTED: "APPLIED" },
  UNDO_APPLY: { APPLIED: "ACCEPTED" },
  CONFIRM_LIVE: { APPLIED: "VERIFIED" },
  VERIFIED: { APPLIED: "VERIFIED" },
  START_MEASURING: { APPLIED: "EVALUATING", VERIFIED: "EVALUATING" },
  EVALUATED: { EVALUATING: "WORKED" },
  EXPIRE: { PROPOSED: "EXPIRED", ACCEPTED: "EXPIRED", APPLIED: "EXPIRED" },
};

describe("nextActionStatus", () => {
  it("matches the full transition table", () => {
    for (const event of EVENTS) {
      for (const status of SEO_ACTION_STATUSES) {
        const expected = TABLE[event][status] ?? null;
        const outcome = event === "EVALUATED" ? "WORKED" : undefined;
        expect(nextActionStatus(event, status, outcome)).toBe(expected);
      }
    }
  });

  it("EVALUATED takes the outcome and requires it", () => {
    expect(nextActionStatus("EVALUATED", "EVALUATING", "DIDNT")).toBe("DIDNT");
    expect(nextActionStatus("EVALUATED", "EVALUATING", "INCONCLUSIVE")).toBe(
      "INCONCLUSIVE",
    );
    expect(nextActionStatus("EVALUATED", "EVALUATING")).toBeNull();
    expect(nextActionStatus("EVALUATED", "APPLIED", "WORKED")).toBeNull();
  });

  it("terminal statuses accept no event", () => {
    for (const status of SEO_ACTION_STATUSES.filter(isTerminal)) {
      for (const event of EVENTS) {
        expect(nextActionStatus(event, status, "WORKED")).toBeNull();
      }
    }
  });

  it("starts measuring from APPLIED and from VERIFIED", () => {
    expect(nextActionStatus("START_MEASURING", "APPLIED")).toBe("EVALUATING");
    expect(nextActionStatus("START_MEASURING", "VERIFIED")).toBe("EVALUATING");
    expect(nextActionStatus("START_MEASURING", "ACCEPTED")).toBeNull();
  });
});

describe("needsGoogleStage", () => {
  it("is false without inspection or for alert-sourced actions", () => {
    for (const kind of SEO_FIX_KINDS) {
      expect(needsGoogleStage(kind, false, false)).toBe(false);
      expect(needsGoogleStage(kind, true, true)).toBe(false);
    }
  });

  it("applies to the five Google-crawled kinds only", () => {
    const on = SEO_FIX_KINDS.filter((kind) => needsGoogleStage(kind, true, false));
    expect(on.sort()).toEqual(
      ["CONTENT_REFRESH", "LOCALIZE", "NEW_CONTENT", "SCHEMA", "TECH_FIX"].sort(),
    );
  });
});

describe("measuringFields", () => {
  const appliedAt = at("2026-09-01T10:00:00.000Z");
  const verifiedAt = at("2026-09-02T10:00:00.000Z");
  const googleCrawlAt = at("2026-09-04T10:00:00.000Z");
  const base = {
    appliedAt,
    verifiedAt,
    googleCrawlAt,
    method: "CRAWLER" as const,
    fromAlert: false,
  };

  it("CONTENT_REFRESH uses googleCrawlAt, then verifiedAt, then appliedAt", () => {
    const kind = "CONTENT_REFRESH" as const;
    expect(measuringFields({ ...base, kind }).measureFrom).toEqual(googleCrawlAt);
    expect(
      measuringFields({ ...base, kind, googleCrawlAt: null }).measureFrom,
    ).toEqual(verifiedAt);
    expect(
      measuringFields({ ...base, kind, googleCrawlAt: null, verifiedAt: null })
        .measureFrom,
    ).toEqual(appliedAt);
  });

  it("NEW_CONTENT and LOCALIZE follow the same rule", () => {
    for (const kind of ["NEW_CONTENT", "LOCALIZE"] as const) {
      expect(measuringFields({ ...base, kind }).measureFrom).toEqual(
        googleCrawlAt,
      );
    }
  });

  it("method USER ignores verifiedAt", () => {
    const fields = measuringFields({
      ...base,
      kind: "CONTENT_REFRESH",
      googleCrawlAt: null,
      method: "USER",
    });
    expect(fields.measureFrom).toEqual(appliedAt);
  });

  it("other kinds anchor on appliedAt", () => {
    for (const kind of [
      "TITLE_META",
      "INTERNAL_LINKS",
      "CONSOLIDATE",
      "TECH_FIX",
      "SCHEMA",
      "CWV_FIX",
      "SITEMAP_FIX",
    ] as const) {
      expect(measuringFields({ ...base, kind }).measureFrom).toEqual(appliedAt);
    }
  });

  it("evaluateAfter is the anchor plus the kind window; nextCheckAt follows it", () => {
    for (const kind of SEO_FIX_KINDS) {
      const fields = measuringFields({
        ...base,
        kind,
        googleCrawlAt: null,
        verifiedAt: null,
      });
      expect(fields.evaluateAfter.getTime()).toBe(
        appliedAt.getTime() + ACTION_WINDOW_DAYS[kind] * DAY,
      );
      expect(fields.nextCheckAt).toEqual(fields.evaluateAfter);
    }
  });

  it("alert-sourced actions hold at least a week after verification", () => {
    const lateVerified = new Date(appliedAt.getTime() + 20 * DAY);
    const fields = measuringFields({
      kind: "SITEMAP_FIX",
      appliedAt,
      verifiedAt: lateVerified,
      googleCrawlAt: null,
      method: "ALERT",
      fromAlert: true,
    });
    // Pencere 14 gün, ama doğrulama 20. günde: 20 + 7 = 27. gün.
    expect(fields.evaluateAfter.getTime()).toBe(lateVerified.getTime() + 7 * DAY);
    expect(fields.evaluateAfter.getTime()).toBeGreaterThanOrEqual(
      lateVerified.getTime() + 7 * DAY,
    );
    const early = measuringFields({
      kind: "TECH_FIX",
      appliedAt,
      verifiedAt,
      googleCrawlAt: null,
      method: "ALERT",
      fromAlert: true,
    });
    expect(early.evaluateAfter.getTime()).toBe(appliedAt.getTime() + 28 * DAY);
  });
});

describe("verifyTimingFor", () => {
  it("uses the per-kind ask/expire days", () => {
    expect(verifyTimingFor("TITLE_META", null)).toEqual({ askDays: 14, expireDays: 45 });
    expect(verifyTimingFor("CWV_FIX", null)).toEqual({ askDays: 35, expireDays: 70 });
    expect(verifyTimingFor("SCHEMA", "GSC_RICH_RESULTS")).toEqual({
      askDays: 21,
      expireDays: 60,
    });
    expect(verifyTimingFor("TECH_FIX", "GSC_CANONICAL_MISMATCH")).toEqual({
      askDays: 21,
      expireDays: 60,
    });
    expect(verifyTimingFor("TECH_FIX", "SEO_KEY_PAGE_ERROR")).toEqual({
      askDays: 14,
      expireDays: 45,
    });
  });
});

describe("verifySchedule", () => {
  const appliedAt = at("2026-09-01T12:00:00.000Z");
  const timing = { askDays: 14, expireDays: 45 };
  const run = (
    now: Date,
    over: Partial<Parameters<typeof verifySchedule>[0]> = {},
  ) =>
    verifySchedule({
      now,
      appliedAt,
      askedAt: null,
      fetchFailed: false,
      quickRetries: null,
      timing,
      ...over,
    });

  it("asks exactly at askDays and expires exactly at expireDays", () => {
    const justBefore = new Date(appliedAt.getTime() + 14 * DAY - 1);
    const exactly = new Date(appliedAt.getTime() + 14 * DAY);
    expect(run(justBefore).ask).toBe(false);
    expect(run(exactly).ask).toBe(true);
    expect(run(exactly, { askedAt: exactly }).ask).toBe(false);
    expect(run(new Date(appliedAt.getTime() + 45 * DAY - 1)).expire).toBe(false);
    expect(run(new Date(appliedAt.getTime() + 45 * DAY)).expire).toBe(true);
  });

  it("checks again in 24 hours by default", () => {
    const now = at("2026-09-02T12:00:00.000Z");
    expect(run(now).nextCheckAt.getTime()).toBe(now.getTime() + DAY);
  });

  it("retries a failed fetch in 30 minutes, at most 3 times per PT day", () => {
    let now = at("2026-09-02T18:00:00.000Z");
    let retries: { day: string; count: number } | null = null;
    const gaps: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const plan = run(now, { fetchFailed: true, quickRetries: retries });
      gaps.push(plan.nextCheckAt.getTime() - now.getTime());
      retries = plan.quickRetries;
      now = plan.nextCheckAt;
    }
    expect(gaps).toEqual([1_800_000, 1_800_000, 1_800_000, DAY]);
    expect(retries?.count).toBe(3);
  });

  it("resets the counter on a new PT day", () => {
    // 2026-09-02 PT günü bitti; sayaç eski gün için.
    const now = at("2026-09-03T18:00:00.000Z");
    const plan = run(now, {
      fetchFailed: true,
      quickRetries: { day: "2026-09-02", count: 3 },
    });
    expect(plan.nextCheckAt.getTime() - now.getTime()).toBe(1_800_000);
    expect(plan.quickRetries).toEqual({ day: "2026-09-03", count: 1 });
  });
});

describe("googleSchedule", () => {
  const verifiedAt = at("2026-09-01T00:00:00.000Z");
  it("requests when never requested or when the last request is 3 days old", () => {
    const now = new Date(verifiedAt.getTime() + DAY);
    expect(googleSchedule({ now, verifiedAt, requestedAt: null }).request).toBe(true);
    expect(googleSchedule({ now, verifiedAt, requestedAt: now }).request).toBe(false);
    const later = new Date(verifiedAt.getTime() + 4 * DAY);
    expect(
      googleSchedule({ now: later, verifiedAt, requestedAt: verifiedAt }).request,
    ).toBe(true);
    expect(
      googleSchedule({ now, verifiedAt, requestedAt: null }).nextCheckAt.getTime(),
    ).toBe(now.getTime() + 3 * DAY);
  });

  it("gives up after 21 days", () => {
    const before = new Date(verifiedAt.getTime() + 21 * DAY - 1);
    const after = new Date(verifiedAt.getTime() + 21 * DAY);
    expect(googleSchedule({ now: before, verifiedAt, requestedAt: null }).giveUp).toBe(false);
    const done = googleSchedule({ now: after, verifiedAt, requestedAt: null });
    expect(done.giveUp).toBe(true);
    expect(done.request).toBe(false);
  });
});

describe("staleOpenCutoffs", () => {
  it("is 60 days for proposed and 90 days for accepted", () => {
    const now = at("2026-10-01T00:00:00.000Z");
    const cutoffs = staleOpenCutoffs(now);
    expect(cutoffs.proposedBefore.getTime()).toBe(now.getTime() - 60 * DAY);
    expect(cutoffs.acceptedBefore.getTime()).toBe(now.getTime() - 90 * DAY);
  });
});

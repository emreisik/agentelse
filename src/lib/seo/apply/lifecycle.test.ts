import { describe, expect, it } from "vitest";

import {
  OPEN_CHANGE_STATUSES,
  SEO_APPLY_APPROVAL_TTL_MS,
  SEO_UNDO_WINDOW_MS,
  canTransitionChange,
  changeBackoffMs,
  dedupeKeyFor,
  isUndoable,
  openKeyFor,
  rateWindow,
} from "./lifecycle";
import { SEO_CHANGE_STATUSES, type SeoChangeParams, type SeoChangeStatus } from "./types";

const DAY = 24 * 60 * 60_000;

const ALLOWED: [SeoChangeStatus, SeoChangeStatus][] = [
  ["PROPOSED", "APPROVED"],
  ["PROPOSED", "REJECTED"],
  ["PROPOSED", "EXPIRED"],
  ["APPROVED", "APPLYING"],
  ["APPROVED", "APPROVED"],
  ["APPROVED", "EXPIRED"],
  ["APPLYING", "APPLIED"],
  ["APPLYING", "VERIFIED"],
  ["APPLYING", "FAILED"],
  ["APPLYING", "APPROVED"],
  ["APPLIED", "APPLIED"],
  ["APPLIED", "VERIFIED"],
  ["APPLIED", "FAILED"],
  ["VERIFIED", "UNDOING"],
  ["FAILED", "UNDOING"],
  ["UNDOING", "UNDONE"],
  ["UNDOING", "VERIFIED"],
  ["UNDOING", "FAILED"],
];

describe("canTransitionChange", () => {
  it("matches the allowed list over the full 10x10 matrix", () => {
    const allowed = new Set(ALLOWED.map(([a, b]) => `${a}>${b}`));
    for (const from of SEO_CHANGE_STATUSES) {
      for (const to of SEO_CHANGE_STATUSES) {
        expect(canTransitionChange(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it("has no way out of the terminal states", () => {
    for (const from of ["UNDONE", "REJECTED", "EXPIRED"] as const) {
      for (const to of SEO_CHANGE_STATUSES) expect(canTransitionChange(from, to)).toBe(false);
    }
  });
});

describe("openKeyFor", () => {
  it("returns the dedupe key only for open statuses", () => {
    expect([...OPEN_CHANGE_STATUSES]).toEqual(["PROPOSED", "APPROVED", "APPLYING", "APPLIED"]);
    for (const status of SEO_CHANGE_STATUSES) {
      expect(openKeyFor(status, "k")).toBe(OPEN_CHANGE_STATUSES.includes(status) ? "k" : null);
    }
  });
});

describe("dedupeKeyFor", () => {
  it("builds one key per kind", () => {
    const cases: [SeoChangeParams, string][] = [
      [
        { kind: "PUBLISH_ARTICLE", creativeId: "c1", versionId: "v1", title: "t", metaDescription: "", markdown: "", language: null },
        "publish:c1:v1",
      ],
      [
        { kind: "PUBLISH_LIVE", draftChangeId: "d1", wpType: "post", wpId: 5, link: null, expectModified: "x", creativeId: null },
        "live:d1",
      ],
      [
        { kind: "TITLE_META", url: "u", wpType: "page", wpId: 7, expectModified: "x", title: "t", metaDescription: null },
        "meta:page:7",
      ],
      [{ kind: "INTERNAL_LINKS", url: "u", wpType: "post", wpId: 9, expectModified: "x", links: [] }, "links:post:9"],
    ];
    for (const [params, key] of cases) expect(dedupeKeyFor(params)).toBe(key);
  });
});

describe("changeBackoffMs", () => {
  it("steps 2, 10 and 30 minutes and caps there", () => {
    expect(changeBackoffMs(1, "TRANSIENT")).toBe(2 * 60_000);
    expect(changeBackoffMs(2, "SERVER")).toBe(10 * 60_000);
    expect(changeBackoffMs(3, "OTHER")).toBe(30 * 60_000);
    expect(changeBackoffMs(9, "OTHER")).toBe(30 * 60_000);
    expect(changeBackoffMs(0, "OTHER")).toBe(2 * 60_000);
  });

  it("waits 6 hours on a rate limit", () => {
    expect(changeBackoffMs(1, "RATE_LIMIT")).toBe(6 * 60 * 60_000);
  });
});

describe("rateWindow", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("allows while below the limit", () => {
    expect(rateWindow([ago(1000), ago(2000)], 3, now)).toEqual({ allowed: true, used: 2, nextAt: null });
    expect(rateWindow([], 1, now)).toEqual({ allowed: true, used: 0, nextAt: null });
  });

  it("blocks at the limit and reports when the oldest leaves", () => {
    const oldest = ago(20 * 60 * 60_000);
    const result = rateWindow([ago(1000), oldest], 2, now);
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(2);
    expect(result.nextAt?.getTime()).toBe(oldest.getTime() + DAY);
  });

  it("treats exactly 24 hours as outside the window", () => {
    expect(rateWindow([ago(DAY)], 1, now).allowed).toBe(true);
    expect(rateWindow([ago(DAY - 1)], 1, now).allowed).toBe(false);
  });

  it("waits for enough entries to leave when the limit was lowered", () => {
    const a = ago(23 * 60 * 60_000);
    const b = ago(10 * 60 * 60_000);
    const c = ago(1 * 60 * 60_000);
    const result = rateWindow([c, a, b], 2, now);
    expect(result.allowed).toBe(false);
    expect(result.nextAt?.getTime()).toBe(b.getTime() + DAY);
  });
});

describe("isUndoable", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  const base = {
    kind: "TITLE_META" as const,
    status: "VERIFIED" as const,
    noop: false,
    appliedAt: new Date(now.getTime() - DAY),
  };

  it("is true for a verified change inside 90 days", () => {
    expect(isUndoable(base, now)).toBe(true);
  });

  it("is false for a noop", () => {
    expect(isUndoable({ ...base, noop: true }, now)).toBe(false);
  });

  it("respects the 90 day window", () => {
    expect(isUndoable({ ...base, appliedAt: new Date(now.getTime() - SEO_UNDO_WINDOW_MS) }, now)).toBe(true);
    expect(isUndoable({ ...base, appliedAt: new Date(now.getTime() - 91 * DAY) }, now)).toBe(false);
  });

  it("allows a FAILED row only when it was written", () => {
    expect(isUndoable({ ...base, status: "FAILED" }, now)).toBe(true);
    expect(isUndoable({ ...base, status: "FAILED", appliedAt: null }, now)).toBe(false);
  });

  it("is false for every other status", () => {
    for (const status of SEO_CHANGE_STATUSES) {
      if (status === "VERIFIED" || status === "FAILED") continue;
      expect(isUndoable({ ...base, status }, now), status).toBe(false);
    }
  });

  it("is false without appliedAt", () => {
    expect(isUndoable({ ...base, appliedAt: null }, now)).toBe(false);
  });
});

describe("constants", () => {
  it("approval lives 7 days", () => {
    expect(SEO_APPLY_APPROVAL_TTL_MS).toBe(7 * DAY);
  });
});

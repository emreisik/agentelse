import { describe, expect, it } from "vitest";

import {
  EVALUATION_WINDOW_DAYS,
  nextStatusFor,
  planLifecycle,
  type ExistingFindingRow,
  type LifecyclePlan,
} from "./finding-lifecycle";

// Bu dosyanın kanıtladığı: sözleşmenin 1–6 kuralları (oluşturma, güncelleme,
// yerine geçme + çıktı taşıma, çözülme, süre dolması), görülmüş ama sınır
// yüzünden taslağa girmemiş konuya yalnız dokunulması, ret/DONE/ACCEPTED
// bastırma pencereleri, yeniden açma, gölgeden çıkarma; her kimlik tek
// listede; karar geçişleri.

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;

function ago(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

function row(overrides: Partial<ExistingFindingRow>): ExistingFindingRow {
  return {
    id: "r1",
    fingerprint: "fp-old",
    ruleKey: "SO1_STRIKING_DISTANCE",
    subject: "page:p1",
    status: "OPEN",
    decidedAt: null,
    evaluateAfter: null,
    lastSeenAt: ago(7),
    shadow: false,
    ...overrides,
  };
}

const DRAFT = {
  fingerprint: "fp-new",
  ruleKey: "SO1_STRIKING_DISTANCE",
  subject: "page:p1",
};
const SEEN = [{ ruleKey: DRAFT.ruleKey, subject: DRAFT.subject }];

function plan(input: {
  drafts?: (typeof DRAFT)[];
  seen?: { ruleKey: string; subject: string }[];
  existing?: ExistingFindingRow[];
  evaluated?: string[];
  mode?: "shadow" | "on";
}): LifecyclePlan {
  return planLifecycle({
    drafts: input.drafts ?? [],
    seen: input.seen ?? [],
    existing: input.existing ?? [],
    evaluated: input.evaluated ?? ["SO1_STRIKING_DISTANCE"],
    mode: input.mode ?? "on",
    now: NOW,
  });
}

function ids(result: LifecyclePlan): string[] {
  return [
    ...result.update.map((item) => item.id),
    ...result.touch,
    ...result.supersede,
    ...result.resolve,
    ...result.expire,
  ];
}

describe("planLifecycle", () => {
  it("creates a draft with no history", () => {
    const result = plan({ drafts: [DRAFT], seen: SEEN });
    expect(result.create).toEqual([{ fingerprint: "fp-new", carryFrom: null }]);
    expect(ids(result)).toEqual([]);
  });

  it("updates an OPEN row with the same fingerprint (rule 1)", () => {
    const result = plan({
      drafts: [DRAFT],
      seen: SEEN,
      existing: [row({ fingerprint: "fp-new" })],
    });
    expect(result.create).toEqual([]);
    expect(result.update).toEqual([
      { id: "r1", fingerprint: "fp-new", unshadow: false, reopen: false },
    ]);
  });

  it("supersedes the older OPEN rows of the subject and carries from the newest (rule 3)", () => {
    const result = plan({
      drafts: [DRAFT],
      seen: SEEN,
      existing: [
        row({ id: "old", fingerprint: "fp-a", lastSeenAt: ago(14) }),
        row({ id: "newer", fingerprint: "fp-b", lastSeenAt: ago(7) }),
      ],
    });
    expect(result.create).toEqual([
      { fingerprint: "fp-new", carryFrom: "newer" },
    ]);
    expect(result.supersede.sort()).toEqual(["newer", "old"]);
  });

  it("resolves OPEN rows of an evaluated rule whose subject is no longer seen (rule 4)", () => {
    const result = plan({ existing: [row({})], seen: [] });
    expect(result.resolve).toEqual(["r1"]);
  });

  it("touches a seen-but-not-drafted subject instead of resolving it (rule 5)", () => {
    const result = plan({ existing: [row({})], seen: SEEN });
    expect(result.touch).toEqual(["r1"]);
    expect(result.resolve).toEqual([]);
  });

  it("expires rows of non-evaluated rules after 35 days unseen (rule 6)", () => {
    const stale = plan({
      existing: [row({ lastSeenAt: ago(36) })],
      evaluated: [],
    });
    expect(stale.expire).toEqual(["r1"]);
    const fresh = plan({
      existing: [row({ lastSeenAt: ago(34) })],
      evaluated: [],
    });
    expect(ids(fresh)).toEqual([]);
  });

  it("suppresses a subject dismissed within 56 days and recreates it after", () => {
    const recent = plan({
      drafts: [DRAFT],
      seen: SEEN,
      existing: [row({ status: "DISMISSED", decidedAt: ago(55) })],
    });
    expect(recent.create).toEqual([]);
    expect(recent.suppressed).toBe(1);
    expect(ids(recent)).toEqual([]);

    const old = plan({
      drafts: [DRAFT],
      seen: SEEN,
      existing: [row({ status: "DISMISSED", decidedAt: ago(57) })],
    });
    expect(old.create).toEqual([{ fingerprint: "fp-new", carryFrom: null }]);
    expect(old.suppressed).toBe(0);
  });

  it("suppresses DONE until evaluateAfter (NEW_CONTENT 90 d) and falls back to 28 d for INVESTIGATE", () => {
    expect(EVALUATION_WINDOW_DAYS.NEW_CONTENT).toBe(90);
    expect(EVALUATION_WINDOW_DAYS.INVESTIGATE).toBeNull();
    const decided = ago(60);
    const withWindow = plan({
      drafts: [DRAFT],
      seen: SEEN,
      existing: [
        row({
          status: "DONE",
          decidedAt: decided,
          evaluateAfter: new Date(decided.getTime() + 90 * DAY),
        }),
      ],
    });
    expect(withWindow.suppressed).toBe(1);
    expect(withWindow.create).toEqual([]);

    const fallbackActive = plan({
      drafts: [DRAFT],
      seen: SEEN,
      existing: [row({ status: "DONE", decidedAt: ago(27) })],
    });
    expect(fallbackActive.suppressed).toBe(1);

    const fallbackOver = plan({
      drafts: [DRAFT],
      seen: SEEN,
      existing: [row({ status: "DONE", decidedAt: ago(29) })],
    });
    expect(fallbackOver.suppressed).toBe(0);
    expect(fallbackOver.create).toHaveLength(1);
  });

  it("suppresses within 90 days of ACCEPTED and touches that row", () => {
    const result = plan({
      drafts: [DRAFT],
      seen: SEEN,
      existing: [row({ id: "acc", status: "ACCEPTED", decidedAt: ago(30) })],
    });
    expect(result.create).toEqual([]);
    expect(result.suppressed).toBe(1);
    expect(result.touch).toEqual(["acc"]);

    const expired = plan({
      drafts: [DRAFT],
      seen: SEEN,
      existing: [row({ id: "acc", status: "ACCEPTED", decidedAt: ago(91) })],
    });
    expect(expired.create).toHaveLength(1);
    expect(expired.touch).toEqual([]);
  });

  it("reopens a RESOLVED or EXPIRED fingerprint", () => {
    for (const status of ["RESOLVED", "EXPIRED"]) {
      const result = plan({
        drafts: [DRAFT],
        seen: SEEN,
        existing: [row({ fingerprint: "fp-new", status })],
      });
      expect(result.update).toEqual([
        { id: "r1", fingerprint: "fp-new", unshadow: false, reopen: true },
      ]);
      expect(result.create).toEqual([]);
    }
  });

  it("only touches a decided row that has the same fingerprint", () => {
    const result = plan({
      drafts: [DRAFT],
      seen: SEEN,
      existing: [row({ fingerprint: "fp-new", status: "SUPERSEDED" })],
    });
    expect(result.touch).toEqual(["r1"]);
    expect(result.create).toEqual([]);
  });

  it("unshadows OPEN rows when the mode is on, not in shadow mode", () => {
    const existing = [row({ fingerprint: "fp-new", shadow: true })];
    const on = plan({ drafts: [DRAFT], seen: SEEN, existing, mode: "on" });
    expect(on.update[0]?.unshadow).toBe(true);
    const shadow = plan({
      drafts: [DRAFT],
      seen: SEEN,
      existing,
      mode: "shadow",
    });
    expect(shadow.update[0]?.unshadow).toBe(false);
  });

  it("puts every id in one list only", () => {
    const result = plan({
      drafts: [
        DRAFT,
        DRAFT,
        { fingerprint: "fp-2", ruleKey: "SO2_CTR_GAP", subject: "page:p2" },
      ],
      seen: [
        ...SEEN,
        { ruleKey: "SO2_CTR_GAP", subject: "page:p2" },
        { ruleKey: "SO2_CTR_GAP", subject: "page:p3" },
      ],
      evaluated: ["SO1_STRIKING_DISTANCE", "SO2_CTR_GAP"],
      existing: [
        row({ id: "a", fingerprint: "fp-a" }),
        row({ id: "b", fingerprint: "fp-b", lastSeenAt: ago(1) }),
        row({
          id: "c",
          fingerprint: "fp-c",
          ruleKey: "SO2_CTR_GAP",
          subject: "page:p3",
        }),
        row({
          id: "d",
          fingerprint: "fp-d",
          ruleKey: "SO2_CTR_GAP",
          subject: "page:p9",
        }),
        row({
          id: "e",
          fingerprint: "fp-e",
          ruleKey: "SO5_CONTENT_GAP",
          subject: "query:q1",
          lastSeenAt: ago(40),
        }),
      ],
    });
    const all = ids(result);
    expect(new Set(all).size).toBe(all.length);
    expect(result.create.map((item) => item.fingerprint)).toEqual([
      "fp-new",
      "fp-2",
    ]);
    expect(result.create[0]?.carryFrom).toBe("b");
    expect(result.touch).toEqual(["c"]);
    expect(result.resolve).toEqual(["d"]);
    expect(result.expire).toEqual(["e"]);
  });
});

describe("nextStatusFor", () => {
  it("allows only the contract transitions", () => {
    expect(nextStatusFor("ACCEPT", "OPEN")).toBe("ACCEPTED");
    expect(nextStatusFor("ACCEPT", "ACCEPTED")).toBeNull();
    expect(nextStatusFor("DISMISS", "OPEN")).toBe("DISMISSED");
    expect(nextStatusFor("DISMISS", "ACCEPTED")).toBe("DISMISSED");
    expect(nextStatusFor("DISMISS", "DONE")).toBeNull();
    expect(nextStatusFor("DONE", "OPEN")).toBe("DONE");
    expect(nextStatusFor("DONE", "ACCEPTED")).toBe("DONE");
    expect(nextStatusFor("DONE", "DISMISSED")).toBeNull();
    expect(nextStatusFor("ACCEPT", "SUPERSEDED")).toBeNull();
  });
});

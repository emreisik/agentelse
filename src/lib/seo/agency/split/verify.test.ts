import { describe, expect, it } from "vitest";

import type { ObservedPage } from "@/lib/seo/actions/verify-checks";

import {
  SPLIT_VERIFY_RATIO,
  isCrawlerKind,
  splitMeasuring,
  verifySplitSample,
  type SampleSnapshot,
} from "./verify";
import type { SplitChange } from "./types";

// Bu dosyanın kanıtladığı: TITLE_META değişti / değişmedi / kontrol de
// değişti / getirme başarısız; SCHEMA var / yok; öteki türler tarayıcıyla hiç
// doğrulanmaz; eşik %60; ölçüme geçiş çapası.

const NO_CHANGE: SplitChange = { titlePattern: null, metaPattern: null, schemaType: null, note: null };

function snap(id: string, title: string): SampleSnapshot {
  return { pageId: id, title, metaDescription: `meta ${id}`, schemaTypes: [] };
}

function page(title: string | null, over: Partial<ObservedPage> = {}): ObservedPage {
  return {
    url: "https://example.com/p",
    status: 200,
    title,
    metaDescription: null,
    h1: null,
    h2: [],
    canonical: null,
    noindex: false,
    indexable: true,
    wordCount: 100,
    textHash: null,
    schemaTypes: [],
    schemaErrors: 0,
    fetchedAt: "2026-09-01T00:00:00.000Z",
    source: "FETCH",
    finalUrl: "https://example.com/p",
    hops: 0,
    fetchError: null,
    robotsBlocked: false,
    links: [],
    ...over,
  };
}

const BASE = {
  test: [snap("t1", "Old 1"), snap("t2", "Old 2"), snap("t3", "Old 3"), snap("t4", "Old 4"), snap("t5", "Old 5")],
  control: [snap("c1", "Ctl 1"), snap("c2", "Ctl 2"), snap("c3", "Ctl 3")],
};
const TITLE_CHANGE: SplitChange = { ...NO_CHANGE, titlePattern: "{title} | Brand" };

function observedControlUnchanged(): ObservedPage[] {
  return BASE.control.map((s) => page(s.title, { metaDescription: s.metaDescription }));
}

describe("verifySplitSample TITLE_META", () => {
  it("verifies when most test pages changed and the controls did not", () => {
    const result = verifySplitSample({
      kind: "TITLE_META",
      change: TITLE_CHANGE,
      baseline: BASE,
      observedTest: BASE.test.map((s) => page(`${s.title} | Brand`)),
      observedControl: observedControlUnchanged(),
    });
    expect(result.verified).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0]?.observed).toBe("5 of 5 pages");
  });

  it("is not seen when the test pages are unchanged", () => {
    const result = verifySplitSample({
      kind: "TITLE_META",
      change: TITLE_CHANGE,
      baseline: BASE,
      observedTest: BASE.test.map((s) => page(s.title)),
      observedControl: observedControlUnchanged(),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("NOT_SEEN");
  });

  it("flags a changed control group", () => {
    const result = verifySplitSample({
      kind: "TITLE_META",
      change: TITLE_CHANGE,
      baseline: BASE,
      observedTest: BASE.test.map((s) => page(`${s.title} | Brand`)),
      observedControl: BASE.control.map((s) => page(`${s.title} | Brand`)),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("CONTROL_CHANGED");
  });

  it("reports a fetch failure when no test page could be read", () => {
    const result = verifySplitSample({
      kind: "TITLE_META",
      change: TITLE_CHANGE,
      baseline: BASE,
      observedTest: [null, null, page(null, { status: 503 }), page(null, { fetchError: "NETWORK" }), null],
      observedControl: observedControlUnchanged(),
    });
    expect(result.verified).toBe(false);
    expect(result.fetchFailed).toBe(true);
    expect(result.reason).toBe("FETCH_FAILED");
  });

  it("uses the 60% threshold on fetched samples", () => {
    const changed = (n: number) =>
      BASE.test.map((s, index) => page(index < n ? `${s.title} | Brand` : s.title));
    const base = { kind: "TITLE_META" as const, change: TITLE_CHANGE, baseline: BASE, observedControl: observedControlUnchanged() };
    expect(verifySplitSample({ ...base, observedTest: changed(3) }).verified).toBe(true);
    expect(verifySplitSample({ ...base, observedTest: changed(2) }).verified).toBe(false);
    expect(SPLIT_VERIFY_RATIO).toBe(0.6);
  });

  it("is not seen without a baseline", () => {
    const result = verifySplitSample({
      kind: "TITLE_META",
      change: TITLE_CHANGE,
      baseline: null,
      observedTest: [page("x")],
      observedControl: [],
    });
    expect(result.verified).toBe(false);
  });

  it("only looks at the title when only a title pattern was given", () => {
    const result = verifySplitSample({
      kind: "TITLE_META",
      change: TITLE_CHANGE,
      baseline: BASE,
      observedTest: BASE.test.map((s) => page(s.title, { metaDescription: "something new" })),
      observedControl: observedControlUnchanged(),
    });
    expect(result.verified).toBe(false);
  });
});

describe("verifySplitSample SCHEMA and other kinds", () => {
  const schemaChange: SplitChange = { ...NO_CHANGE, schemaType: "FAQPage" };

  it("verifies when the markup is on the test pages and absent on the controls", () => {
    const result = verifySplitSample({
      kind: "SCHEMA",
      change: schemaChange,
      baseline: null,
      observedTest: [1, 2, 3].map(() => page("t", { schemaTypes: ["faqpage"] })),
      observedControl: [1, 2].map(() => page("c", { schemaTypes: [] })),
    });
    expect(result.verified).toBe(true);
  });

  it("is not seen when the markup is missing", () => {
    const result = verifySplitSample({
      kind: "SCHEMA",
      change: schemaChange,
      baseline: null,
      observedTest: [1, 2, 3].map(() => page("t", { schemaTypes: ["Article"] })),
      observedControl: [],
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("NOT_SEEN");
  });

  it("flags markup that also shows on the controls", () => {
    const result = verifySplitSample({
      kind: "SCHEMA",
      change: schemaChange,
      baseline: null,
      observedTest: [1, 2, 3].map(() => page("t", { schemaTypes: ["FAQPage"] })),
      observedControl: [1, 2, 3].map(() => page("c", { schemaTypes: ["FAQPage"] })),
    });
    expect(result.reason).toBe("CONTROL_CHANGED");
  });

  it("never crawler-verifies the other kinds", () => {
    for (const kind of ["INTERNAL_LINKS_BLOCK", "CONTENT_BLOCK", "TEMPLATE_CHANGE", "OTHER"] as const) {
      expect(isCrawlerKind(kind)).toBe(false);
      const result = verifySplitSample({
        kind,
        change: NO_CHANGE,
        baseline: BASE,
        observedTest: [page("x")],
        observedControl: [],
      });
      expect(result).toEqual({ verified: false, checks: [], fetchFailed: false, reason: null });
    }
  });
});

describe("splitMeasuring", () => {
  const appliedAt = new Date("2026-08-05T12:00:00.000Z");
  const verifiedAt = new Date("2026-08-07T12:00:00.000Z");

  it("anchors on the applied day for a user-asserted title test", () => {
    const fields = splitMeasuring({ kind: "TITLE_META", appliedAt, verifiedAt, method: "USER" });
    expect(fields.measureFrom).toEqual(appliedAt);
    expect(fields.evaluateAfter.getTime() - appliedAt.getTime()).toBe(28 * 86_400_000);
  });

  it("uses the content window for a content block", () => {
    const fields = splitMeasuring({ kind: "CONTENT_BLOCK", appliedAt, verifiedAt, method: "CRAWLER" });
    expect(fields.evaluateAfter.getTime() - fields.measureFrom.getTime()).toBe(56 * 86_400_000);
  });
});

import { describe, expect, it } from "vitest";

import {
  SEO_FIX_KINDS,
  emptyProposal,
  parseEvaluation,
  parsePageSnapshot,
  parseProposal,
  parseVerification,
  type SeoFixKind,
} from "./types";
import { proposalFixture } from "./test-support";

// Bu dosyanın kanıtladığı: her teklif türü gidiş-dönüşte aynı kalır, yanlış
// tür null verir, sınırlar uygulanır ve bozuk öğeler tek tek atılır.

describe("parseProposal", () => {
  it("round-trips every kind", () => {
    for (const kind of SEO_FIX_KINDS) {
      const fixture = proposalFixture(kind);
      const stored = JSON.parse(JSON.stringify(fixture)) as unknown;
      expect(parseProposal(stored, kind)).toEqual(fixture);
    }
  });

  it("returns null for the wrong kind or a non-object", () => {
    const fixture = proposalFixture("TITLE_META");
    expect(parseProposal(fixture, "SCHEMA")).toBeNull();
    expect(parseProposal(null, "TITLE_META")).toBeNull();
    expect(parseProposal("x", "TITLE_META")).toBeNull();
    expect(parseProposal([], "TITLE_META")).toBeNull();
    expect(parseProposal({}, "TITLE_META")).toBeNull();
  });

  it("emptyProposal parses back to itself for every kind", () => {
    for (const kind of SEO_FIX_KINDS) {
      const empty = emptyProposal(kind);
      expect(empty.kind).toBe(kind);
      expect(empty.v).toBe(1);
      expect(parseProposal(empty, kind)).toEqual(empty);
    }
  });

  it("caps lists", () => {
    const variants = Array.from({ length: 6 }, (_, i) => ({
      title: `t${i}`,
      metaDescription: `m${i}`,
      angle: "a",
    }));
    const title = parseProposal(
      { kind: "TITLE_META", before: null, after: null, variants },
      "TITLE_META",
    );
    expect(title?.kind === "TITLE_META" && title.variants).toHaveLength(3);

    const missing = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const refresh = parseProposal(
      { kind: "CONTENT_REFRESH", missing },
      "CONTENT_REFRESH",
    );
    expect(refresh?.kind === "CONTENT_REFRESH" && refresh.missing).toHaveLength(
      8,
    );

    const links = Array.from({ length: 9 }, (_, i) => ({
      fromUrl: `https://a.test/${i}`,
      toUrl: "https://a.test/to",
      anchor: "x",
    }));
    const internal = parseProposal(
      { kind: "INTERNAL_LINKS", links },
      "INTERNAL_LINKS",
    );
    expect(internal?.kind === "INTERNAL_LINKS" && internal.links).toHaveLength(
      5,
    );

    const from = Array.from({ length: 9 }, (_, i) => `https://a.test/${i}`);
    const consolidate = parseProposal(
      { kind: "CONSOLIDATE", from, to: "https://a.test/to", method: "REDIRECT" },
      "CONSOLIDATE",
    );
    expect(consolidate?.kind === "CONSOLIDATE" && consolidate.from).toHaveLength(
      4,
    );
  });

  it("clamps strings", () => {
    const parsed = parseProposal(
      {
        kind: "TITLE_META",
        before: { title: "t".repeat(500), metaDescription: "m".repeat(900) },
        after: null,
        variants: [],
        note: "n".repeat(900),
      },
      "TITLE_META",
    );
    expect(parsed?.kind === "TITLE_META" && parsed.before?.title.length).toBe(
      120,
    );
    expect(
      parsed?.kind === "TITLE_META" && parsed.before?.metaDescription.length,
    ).toBe(320);
    expect(parsed?.note?.length).toBe(400);

    const links = parseProposal(
      {
        kind: "INTERNAL_LINKS",
        links: [
          { fromUrl: "https://a.test/a", toUrl: "https://a.test/b", anchor: "x".repeat(400) },
        ],
      },
      "INTERNAL_LINKS",
    );
    expect(links?.kind === "INTERNAL_LINKS" && links.links[0]?.anchor.length).toBe(
      120,
    );
  });

  it("drops bad list items one by one", () => {
    const parsed = parseProposal(
      {
        kind: "INTERNAL_LINKS",
        links: [
          null,
          "x",
          { fromUrl: "https://a.test/a" },
          { fromUrl: "https://a.test/a", toUrl: "https://a.test/b", anchor: "ok" },
          { fromUrl: 3, toUrl: "https://a.test/b" },
        ],
      },
      "INTERNAL_LINKS",
    );
    expect(parsed?.kind === "INTERNAL_LINKS" && parsed.links).toEqual([
      { fromUrl: "https://a.test/a", toUrl: "https://a.test/b", anchor: "ok" },
    ]);

    const refresh = parseProposal(
      { kind: "CONTENT_REFRESH", missing: ["a", 3, "", null, "b"] },
      "CONTENT_REFRESH",
    );
    expect(refresh?.kind === "CONTENT_REFRESH" && refresh.missing).toEqual([
      "a",
      "b",
    ]);
  });

  it("defaults alert.source to SEO and keeps GSC", () => {
    const base = { kind: "SCHEMA" as SeoFixKind, types: [] };
    const withoutSource = parseProposal(
      { ...base, alert: { kind: "SEO_STRUCTURED_DATA", dedupeKey: "k1" } },
      "SCHEMA",
    );
    expect(withoutSource?.alert).toEqual({
      kind: "SEO_STRUCTURED_DATA",
      dedupeKey: "k1",
      source: "SEO",
    });
    const gsc = parseProposal(
      {
        ...base,
        alert: { kind: "GSC_RICH_RESULTS", dedupeKey: "k2", source: "GSC" },
      },
      "SCHEMA",
    );
    expect(gsc?.alert?.source).toBe("GSC");
    const broken = parseProposal({ ...base, alert: { kind: "x" } }, "SCHEMA");
    expect(broken?.alert).toBeNull();
  });

  it("falls back to OTHER for an unknown tech issue", () => {
    const parsed = parseProposal(
      { kind: "TECH_FIX", issue: "WHAT", issueCodes: ["TA7"] },
      "TECH_FIX",
    );
    expect(parsed?.kind === "TECH_FIX" && parsed.issue).toBe("OTHER");
  });
});

describe("parsePageSnapshot", () => {
  it("needs a url and a fetch time, caps h2 and defaults the source", () => {
    expect(parsePageSnapshot(null)).toBeNull();
    expect(parsePageSnapshot({ url: "https://a.test/" })).toBeNull();
    const parsed = parsePageSnapshot({
      url: "https://a.test/",
      fetchedAt: "2026-10-01T00:00:00.000Z",
      h2: Array.from({ length: 30 }, (_, i) => `h${i}`),
      status: 200,
      noindex: true,
    });
    expect(parsed?.h2).toHaveLength(20);
    expect(parsed?.source).toBe("FETCH");
    expect(parsed?.noindex).toBe(true);
    expect(parsed?.indexable).toBeNull();
    expect(parsed?.schemaTypes).toEqual([]);
  });
});

describe("parseVerification", () => {
  it("returns the default for anything unusable", () => {
    const expected = {
      v: 1,
      attempts: 0,
      quickRetries: null,
      lastCheckedAt: null,
      checks: [],
      method: null,
      liveSince: null,
      google: null,
      reason: null,
    };
    expect(parseVerification(null)).toEqual(expected);
    expect(parseVerification("x")).toEqual(expected);
    expect(parseVerification({})).toEqual(expected);
  });

  it("reads quick retries, checks, google and reason", () => {
    const parsed = parseVerification({
      attempts: 2,
      quickRetries: { day: "2026-10-05", count: 2 },
      method: "CRAWLER",
      reason: "NOT_SEEN",
      checks: [
        { key: "title", label: "Title", ok: true, observed: "x".repeat(300) },
        { key: 3 },
        { key: "meta", label: "Meta", ok: "yes" },
      ],
      google: { state: "pending", requestedAt: "2026-10-05T00:00:00.000Z" },
    });
    expect(parsed.attempts).toBe(2);
    expect(parsed.quickRetries).toEqual({ day: "2026-10-05", count: 2 });
    expect(parsed.method).toBe("CRAWLER");
    expect(parsed.reason).toBe("NOT_SEEN");
    expect(parsed.checks).toHaveLength(1);
    expect(parsed.checks[0]?.observed?.length).toBe(200);
    expect(parsed.google?.state).toBe("pending");
    expect(parsed.google?.lastCrawlTime).toBeNull();
  });

  it("caps checks at 20", () => {
    const checks = Array.from({ length: 30 }, (_, i) => ({
      key: `k${i}`,
      label: "L",
      ok: true,
    }));
    expect(parseVerification({ checks }).checks).toHaveLength(20);
  });
});

describe("parseEvaluation", () => {
  const base = {
    v: 1,
    method: "DID",
    metric: "clicks",
    anchorDay: "2026-09-01",
    preWeeks: ["2026-07-06"],
    postWeeks: ["2026-09-14"],
    effect: 0.2,
    low: 0.1,
    high: 0.3,
    controls: 5,
    yoyAdjusted: false,
    updates: [],
    truncated: false,
    reason: null,
    outcome: "WORKED",
    confidence: "SIGNIFICANT",
    evaluatedAt: "2026-10-01T00:00:00.000Z",
  };

  it("rejects a wrong version and missing outcome", () => {
    expect(parseEvaluation({ ...base, v: 2 })).toBeNull();
    expect(parseEvaluation({ ...base, outcome: "MAYBE" })).toBeNull();
    expect(parseEvaluation({ ...base, method: "X" })).toBeNull();
    expect(parseEvaluation(null)).toBeNull();
  });

  it("reads a full evaluation and yoyAdjusted", () => {
    const parsed = parseEvaluation({
      ...base,
      method: "PRE_POST",
      yoyAdjusted: true,
      treated: {
        before: { weeks: 8, clicks: 10, impressions: 100, ctr: 0.1, position: 5, ctrAdj: 1 },
        after: { weeks: 2, clicks: 5, impressions: 40, ctr: 0.125, position: 4, ctrAdj: 1.1 },
      },
    });
    expect(parsed?.yoyAdjusted).toBe(true);
    expect(parsed?.method).toBe("PRE_POST");
    expect(parsed?.treated?.after.clicks).toBe(5);
    expect(parsed?.control).toBeNull();
    expect(parsed?.outcome).toBe("WORKED");
  });

  it("caps updates and drops broken ones", () => {
    const updates = [
      ...Array.from({ length: 14 }, (_, i) => ({
        name: `u${i}`,
        kind: "CORE",
        startedAt: "2026-09-01T00:00:00.000Z",
        endedAt: null,
      })),
      { name: "x" },
    ];
    expect(parseEvaluation({ ...base, updates })?.updates).toHaveLength(10);
  });
});

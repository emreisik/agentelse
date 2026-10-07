import { describe, expect, it } from "vitest";

import {
  ACTION_STATUS_LABEL,
  DID_METRIC_LABEL,
  EVALUATION_REASON_TEXT,
  FIX_INSTRUCTIONS,
  FIX_KIND_LABEL,
  SUGGESTED_TOPIC_LABEL,
  actionTitle,
  askText,
  learningInsight,
  outcomeDetail,
  outcomeHeadline,
  percentChangeText,
  proposalLines,
} from "./copy";
import { proposalFixture } from "./test-support";
import {
  SEO_ACTION_STATUSES,
  SEO_FIX_KINDS,
  type DidMetric,
  type SeoEvaluation,
} from "./types";

// Bu dosyanın kanıtladığı: sonuç başlıkları ve ayrıntıları, öğrenme metinlerinin
// rakamsız/yolsuz olması ve teklif satırlarının Google anahtar kelimesini
// yazmaması.

function evaluation(over: Partial<SeoEvaluation> = {}): SeoEvaluation {
  return {
    v: 1,
    method: "DID",
    metric: "ctr_adj",
    anchorDay: "2026-09-01",
    preWeeks: [],
    postWeeks: [],
    effect: 0.18,
    low: 0.09,
    high: 0.27,
    controls: 6,
    yoyAdjusted: false,
    treated: null,
    control: null,
    yoy: null,
    updates: [],
    truncated: false,
    cwv: null,
    sitemap: null,
    reason: null,
    outcome: "WORKED",
    confidence: "SIGNIFICANT",
    evaluatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

describe("labels", () => {
  it("cover every kind and status", () => {
    for (const kind of SEO_FIX_KINDS) {
      expect(FIX_KIND_LABEL[kind].length).toBeGreaterThan(0);
      expect(askText(kind).endsWith("?")).toBe(true);
      expect(FIX_INSTRUCTIONS[kind].length).toBeGreaterThanOrEqual(2);
      expect(FIX_INSTRUCTIONS[kind].length).toBeLessThanOrEqual(4);
    }
    for (const status of SEO_ACTION_STATUSES) {
      expect(ACTION_STATUS_LABEL[status].length).toBeGreaterThan(0);
    }
    expect(ACTION_STATUS_LABEL).toMatchObject({
      PROPOSED: "Suggested",
      ACCEPTED: "To do",
      APPLIED: "Checking your site",
      VERIFIED: "Live · waiting for Google",
      EVALUATING: "Measuring",
      WORKED: "Worked",
      DIDNT: "Didn't work",
      INCONCLUSIVE: "No clear result",
      DISMISSED: "Dismissed",
      EXPIRED: "Expired",
    });
    expect(DID_METRIC_LABEL.ctr_adj).toBe("CTR");
    expect(Object.keys(EVALUATION_REASON_TEXT)).toHaveLength(7);
    expect(SUGGESTED_TOPIC_LABEL).toBe("Suggested from Search Console");
  });

  it("fix instructions contain no digits", () => {
    for (const kind of SEO_FIX_KINDS) {
      for (const step of FIX_INSTRUCTIONS[kind]) expect(step).not.toMatch(/\d/);
    }
  });
});

describe("percentChangeText", () => {
  it("formats signs and the minus character", () => {
    expect(percentChangeText(0.18)).toBe("+18%");
    expect(percentChangeText(-0.04)).toBe("−4%");
    expect(percentChangeText(0)).toBe("0%");
    expect(percentChangeText(0.004)).toBe("0%");
    expect(percentChangeText(-0.004)).toBe("0%");
    expect(percentChangeText(Number.NaN)).toBe("0%");
    expect(percentChangeText(1.256)).toBe("+126%");
  });
});

describe("outcomeHeadline", () => {
  it("names the effect and the metric", () => {
    expect(outcomeHeadline(evaluation())).toBe("Worked: +18% CTR");
    expect(
      outcomeHeadline(
        evaluation({ outcome: "DIDNT", metric: "clicks", effect: -0.04 }),
      ),
    ).toBe("Didn't work: −4% clicks");
    expect(
      outcomeHeadline(evaluation({ metric: "impressions", method: "DID_SITE" })),
    ).toBe("Worked: +18% impressions");
  });

  it("inconclusive results carry no number", () => {
    expect(outcomeHeadline(evaluation({ outcome: "INCONCLUSIVE", reason: "LOW_DATA" }))).toBe(
      "No clear result",
    );
  });

  it("covers the other methods", () => {
    const base = { effect: null, low: null, high: null, metric: null };
    expect(outcomeHeadline(evaluation({ ...base, method: "LAUNCH" }))).toMatch(/^Worked:/);
    expect(outcomeHeadline(evaluation({ ...base, method: "LAUNCH", outcome: "DIDNT" }))).toMatch(
      /^Didn't work:/,
    );
    expect(outcomeHeadline(evaluation({ ...base, method: "ALERT" }))).toBe(
      "Worked: the issue stayed fixed",
    );
    expect(outcomeHeadline(evaluation({ ...base, method: "ALERT", outcome: "DIDNT" }))).toBe(
      "Didn't work: the issue came back",
    );
    expect(outcomeHeadline(evaluation({ ...base, method: "CRUX" }))).toBe(
      "Worked: page speed improved",
    );
    expect(outcomeHeadline(evaluation({ ...base, method: "SITEMAP" }))).toBe(
      "Worked: the sitemap is clean",
    );
    expect(outcomeHeadline(evaluation({ ...base, method: "NONE" }))).toBe("Worked");
  });
});

describe("outcomeDetail", () => {
  it("joins the comparison and the interval", () => {
    expect(outcomeDetail(evaluation())).toBe(
      "Compared with 6 similar pages · likely between +9% and +27%",
    );
    expect(outcomeDetail(evaluation({ controls: 1 }))).toContain("Compared with 1 similar page ");
  });

  it("describes DID_SITE and PRE_POST", () => {
    expect(outcomeDetail(evaluation({ method: "DID_SITE", controls: 5 }))).toContain(
      "Compared with similar pages on your site",
    );
    expect(
      outcomeDetail(evaluation({ method: "PRE_POST", yoyAdjusted: true, controls: 0 })),
    ).toContain("Before and after, adjusted for last year");
    expect(
      outcomeDetail(evaluation({ method: "PRE_POST", yoyAdjusted: false, controls: 0 })),
    ).toContain("Before and after only");
  });

  it("mentions an overlapping update and the reason once", () => {
    const update = {
      name: "Core update",
      kind: "CORE",
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: null,
    };
    const capped = outcomeDetail(
      evaluation({ outcome: "INCONCLUSIVE", reason: "GOOGLE_UPDATE", updates: [update] }),
    );
    expect(capped).toContain(EVALUATION_REASON_TEXT.GOOGLE_UPDATE);
    expect(capped?.match(/Google update overlapped/g)).toHaveLength(1);
    const noted = outcomeDetail(evaluation({ updates: [update] }));
    expect(noted).toContain("A Google update overlapped");
  });

  it("drops the interval when there is no usable result", () => {
    const text = outcomeDetail(
      evaluation({ outcome: "INCONCLUSIVE", reason: "LOW_DATA", low: 0.1, high: 0.2 }),
    );
    expect(text).not.toContain("likely between");
    expect(text).toContain(EVALUATION_REASON_TEXT.LOW_DATA);
  });

  it("is null when there is nothing to say", () => {
    expect(
      outcomeDetail(evaluation({ method: "ALERT", effect: null, low: null, high: null })),
    ).toBeNull();
  });
});

describe("learningInsight", () => {
  it("is digit-free and has no paths, urls, queries or quotes for every kind and metric", () => {
    const metrics: DidMetric[] = ["ctr_adj", "clicks", "impressions"];
    for (const kind of SEO_FIX_KINDS) {
      for (const metric of metrics) {
        const text = learningInsight({ kind, metric });
        expect(text.length).toBeGreaterThan(20);
        expect(text).not.toMatch(/\d/);
        expect(text).not.toContain("/");
        expect(text).not.toContain("http");
        expect(text).not.toContain("?");
        expect(text).not.toMatch(/["'‘’“”`]/);
      }
    }
  });

  it("matches the title and meta example", () => {
    expect(learningInsight({ kind: "TITLE_META", metric: "ctr_adj" })).toContain(
      "rewriting the title and meta description",
    );
    expect(learningInsight({ kind: "TITLE_META", metric: "ctr_adj" })).toContain(
      "click-through",
    );
  });
});

describe("proposalLines", () => {
  const pathOf = (url: string) => new URL(url).pathname;

  it("never prints the primary keyword", () => {
    for (const kind of SEO_FIX_KINDS) {
      const proposal = proposalFixture(kind);
      const lines = proposalLines(proposal, pathOf).join("\n");
      expect(lines).not.toContain("blue widgets");
    }
  });

  it("describes the planned change", () => {
    const title = proposalLines(proposalFixture("TITLE_META"), pathOf);
    expect(title).toEqual(["New title: New title", "New description: New description"]);
    const links = proposalLines(proposalFixture("INTERNAL_LINKS"), pathOf);
    expect(links).toEqual(['Link "see the guide" from /a to /b']);
    const merge = proposalLines(proposalFixture("CONSOLIDATE"), pathOf);
    expect(merge[0]).toBe("Merge /old-1, /old-2 into /main");
    expect(merge[1]).toBe("Use a permanent redirect");
    expect(proposalLines(proposalFixture("SCHEMA"), pathOf)).toEqual([
      "Add structured data: FAQPage, Product",
    ]);
    expect(proposalLines(proposalFixture("TECH_FIX"), pathOf)).toEqual([
      "Point the canonical to the page itself",
    ]);
  });

  it("adds the user's note", () => {
    const proposal = { ...proposalFixture("SCHEMA"), note: "Done on staging" };
    expect(proposalLines(proposal, pathOf).at(-1)).toBe("Note: Done on staging");
  });
});

describe("actionTitle", () => {
  it("joins the label and the path and clamps long paths", () => {
    expect(actionTitle("TITLE_META", "/blog/widgets")).toBe(
      "Title and description · /blog/widgets",
    );
    expect(actionTitle("SCHEMA", null)).toBe("Structured data");
    const long = actionTitle("TITLE_META", `/${"a".repeat(200)}`);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual("Title and description · ".length + 60);
  });
});

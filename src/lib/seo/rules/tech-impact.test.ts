import { describe, expect, it } from "vitest";

import type { RuleSnapshot, SeoSeverity } from "@/lib/seo/opportunity-types";
import { TA_CATALOG } from "@/lib/seo/technical-audit";

import { SO16 } from "./tech-impact";
import {
  crawlPage,
  draftInvariantErrors,
  page,
  snapshotFixture,
} from "./test-support";

function build(
  impressions: readonly number[],
  severity: SeoSeverity = "WARN",
  code = "TA1",
): RuleSnapshot {
  return snapshotFixture({
    pages: impressions.map((v, i) =>
      page(`t${i}`, `/page-${i}`, { impressions: v }),
    ),
    crawl: {
      complete: true,
      pages: [
        ...impressions.map((_, i) =>
          crawlPage(`t${i}`, `/page-${i}`, {
            issues: [{ code, severity: i === 0 ? severity : "WARN" }],
          }),
        ),
        crawlPage(null, "/unmatched", {
          issues: [{ code, severity: "CRITICAL" }],
        }),
      ],
      links: [],
    },
  });
}

function run(snapshot: RuleSnapshot) {
  const result = SO16.evaluate(snapshot);
  if (!result.evaluable) throw new Error("not evaluable");
  return result;
}

describe("SO16 technical impact", () => {
  it("needs crawl data", () => {
    expect(SO16.evaluate(snapshotFixture())).toEqual({
      evaluable: false,
      reason: "NO_CRAWL",
    });
  });

  it("fires when affected pages hold at least 100 impressions", () => {
    expect(run(build([60, 39])).drafts).toHaveLength(0);
    const snapshot = build([60, 40]);
    const draft = run(snapshot).drafts[0]!;
    expect(draft.subject).toBe("ta:TA1");
    expect(draft.title).toBe(TA_CATALOG.TA1.title);
    expect(draft.severity).toBe("WARN");
    expect(draft.confidence).toBe("SIGNIFICANT");
    expect(draft.evidence.issueCodes).toEqual(["TA1"]);
    expect(draft.evidence.metrics).toEqual({ pages: 2, impressions: 100 });
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("keeps the highest severity", () => {
    expect(run(build([200], "CRITICAL")).drafts[0]!.severity).toBe("CRITICAL");
  });

  it("ignores INFO issues and lists at most five pages", () => {
    const info = snapshotFixture({
      pages: [page("t0", "/a", { impressions: 900 })],
      crawl: {
        complete: true,
        pages: [
          crawlPage("t0", "/a", {
            issues: [{ code: "TA3", severity: "INFO" }],
          }),
        ],
        links: [],
      },
    });
    expect(run(info).drafts).toHaveLength(0);
    const many = run(build([50, 50, 50, 50, 50, 50, 50])).drafts[0]!;
    expect(many.evidence.pages).toHaveLength(5);
    expect(many.evidence.metrics.pages).toBe(7);
  });
});

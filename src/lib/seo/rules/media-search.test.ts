import { describe, expect, it } from "vitest";

import type { RuleSnapshot } from "@/lib/seo/opportunity-types";

import { SO14 } from "./media-search";
import {
  crawlPage,
  draftInvariantErrors,
  page,
  snapshotFixture,
} from "./test-support";

function build(
  searchTypes: { image: number; video: number },
  schemaTypes: string[] = [],
) {
  return snapshotFixture({
    searchTypes,
    pages: [page("p1", "/gallery", { impressions: 900 })],
    crawl: {
      complete: true,
      pages: [crawlPage("p1", "/gallery", { imagesNoAlt: 4, schemaTypes })],
      links: [],
    },
  });
}

function run(snapshot: RuleSnapshot) {
  const result = SO14.evaluate(snapshot);
  if (!result.evaluable) throw new Error("not evaluable");
  return result;
}

describe("SO14 media search", () => {
  it("needs crawl data", () => {
    expect(
      SO14.evaluate(
        snapshotFixture({ searchTypes: { image: 900, video: 900 } }),
      ),
    ).toEqual({
      evaluable: false,
      reason: "NO_CRAWL",
    });
  });

  it("asks for alt text from 200 image impressions", () => {
    expect(run(build({ image: 199, video: 0 })).drafts).toHaveLength(0);
    const snapshot = build({ image: 200, video: 0 });
    const draft = run(snapshot).drafts[0]!;
    expect(draft.subject).toBe("site:images");
    expect(draft.actionKind).toBe("TECH_FIX");
    expect(draft.evidence.pages?.map((p) => p.path)).toEqual(["/gallery"]);
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("asks for video markup from 200 video impressions", () => {
    expect(run(build({ image: 0, video: 199 })).drafts).toHaveLength(0);
    const draft = run(build({ image: 0, video: 200 })).drafts[0]!;
    expect(draft.subject).toBe("site:video");
    expect(draft.actionKind).toBe("SCHEMA");
    expect(
      run(build({ image: 0, video: 900 }, ["VideoObject"])).drafts,
    ).toHaveLength(0);
  });

  it("returns both findings at most", () => {
    const result = run(build({ image: 500, video: 500 }));
    expect(result.drafts.map((d) => d.subject).sort()).toEqual([
      "site:images",
      "site:video",
    ]);
  });
});

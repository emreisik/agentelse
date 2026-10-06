import { describe, expect, it } from "vitest";

import type { RuleSnapshot } from "@/lib/seo/opportunity-types";

import { SO11, SO11_NOTE } from "./local-intent";
import {
  crawlPage,
  draftInvariantErrors,
  page,
  pair,
  query,
  snapshotFixture,
} from "./test-support";

function run(snapshot: RuleSnapshot) {
  const result = SO11.evaluate(snapshot);
  if (!result.evaluable) throw new Error("not evaluable");
  return result;
}

function placeQuery(path: string, overrides: Partial<RuleSnapshot> = {}) {
  return snapshotFixture({
    queries: [
      query("q1", "dentist izmir", {
        impressions: 80,
        clicks: 1,
        position: 15,
      }),
    ],
    pages: [page("p1", path, { impressions: 80, clicks: 1 })],
    pairs: [pair("q1", "p1", { impressions: 80, clicks: 1, position: 15 })],
    ...overrides,
  });
}

function markerQuery(position: number) {
  return snapshotFixture({
    queries: [
      query("q1", "emergency dentist near me", { impressions: 60, position }),
    ],
    pages: [page("p1", "/emergency", { impressions: 60 })],
    pairs: [pair("q1", "p1", { impressions: 60, position })],
  });
}

describe("SO11 local intent", () => {
  it("fires when no page names the searched place", () => {
    const snapshot = placeQuery("/dental-implants");
    const draft = run(snapshot).drafts[0]!;
    expect(draft.subject).toBe("query:q1");
    expect(draft.actionKind).toBe("NEW_CONTENT");
    expect(draft.effort).toBe("L");
    expect(draft.confidence).toBe("DIRECTIONAL");
    expect(draft.ideaWorthy).toBe(true);
    expect(draft.evidence.notes).toEqual([SO11_NOTE]);
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("stays quiet when a page path, title or H1 names the place", () => {
    expect(run(placeQuery("/izmir-dentist")).drafts).toHaveLength(0);
    const titled = placeQuery("/dental", {
      crawl: {
        complete: true,
        pages: [crawlPage("p1", "/dental", { h1: ["Dentist in İzmir"] })],
        links: [],
      },
    });
    expect(run(titled).drafts).toHaveLength(0);
  });

  it("uses the position for marker-only searches", () => {
    expect(run(markerQuery(12)).drafts).toHaveLength(1);
    expect(run(markerQuery(8)).drafts).toHaveLength(0);
  });

  it("needs Q ≥ 50 and a local, non-brand search", () => {
    const small = placeQuery("/dental");
    small.queries[0]!.impressions = 49;
    expect(run(small).drafts).toHaveLength(0);
    const notLocal = snapshotFixture({
      queries: [
        query("q1", "dentist prices", { impressions: 500, position: 30 }),
      ],
    });
    expect(run(notLocal).drafts).toHaveLength(0);
  });

  it("caps at five but reports every gap in seen", () => {
    const ids = Array.from({ length: 7 }, (_, i) => i);
    const snapshot = snapshotFixture({
      queries: ids.map((i) =>
        query(`q${i}`, `plumber ${i} near me`, { impressions: 60 + i }),
      ),
    });
    const result = run(snapshot);
    expect(result.drafts).toHaveLength(5);
    expect(result.seen).toHaveLength(7);
  });
});

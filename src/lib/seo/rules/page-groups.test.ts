import { describe, expect, it } from "vitest";

import type { RuleSnapshot } from "@/lib/seo/opportunity-types";

import { SO9 } from "./page-groups";
import {
  draftInvariantErrors,
  idMetric,
  page,
  snapshotFixture,
} from "./test-support";

// Bölümün sayfaları eşit paylaşır: toplam C (şimdi), P (önce), Y (geçen yıl).
function group(input: {
  pages?: number;
  C: number;
  P: number;
  Y?: number | null;
  name?: string;
}): RuleSnapshot {
  const n = input.pages ?? 5;
  const name = input.name ?? "blog";
  const ids = Array.from({ length: n }, (_, i) => `${name}${i}`);
  return snapshotFixture({
    pages: ids.map((id) =>
      page(id, `/${name}/${id}-post`, {
        impressions: 400,
        clicks: input.C / n,
      }),
    ),
    previousPages: ids.map((id) => idMetric(id, { clicks: input.P / n })),
    yearAgoPages:
      input.Y === undefined || input.Y === null
        ? null
        : ids.map((id) => idMetric(id, { clicks: input.Y! / n })),
  });
}

function run(snapshot: RuleSnapshot) {
  const result = SO9.evaluate(snapshot);
  if (!result.evaluable) throw new Error(`not evaluable: ${result.reason}`);
  return result;
}

describe("SO9 page group trend", () => {
  it("needs a complete previous window", () => {
    expect(
      SO9.evaluate({ ...group({ C: 100, P: 200 }), previousComplete: false }),
    ).toEqual({
      evaluable: false,
      reason: "LOW_HISTORY",
    });
  });

  it("reports a falling section as a risk", () => {
    const snapshot = group({ C: 800, P: 1000 });
    const draft = run(snapshot).drafts[0]!;
    expect(draft.subject).toBe("group:/blog");
    expect(draft.kind).toBe("RISK");
    expect(draft.severity).toBe("WARN");
    expect(draft.actionKind).toBe("INVESTIGATE");
    expect(draft.effort).toBe("VARIES");
    expect(draft.keyword).toBeNull();
    expect(draft.impact).not.toBeNull();
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("reports a growing section as a win without impact", () => {
    const draft = run(group({ C: 1300, P: 1000 })).drafts[0]!;
    expect(draft.kind).toBe("WIN");
    expect(draft.impact).toBeNull();
  });

  it("needs five pages with impressions", () => {
    expect(run(group({ pages: 4, C: 400, P: 1000 })).drafts).toHaveLength(0);
    expect(run(group({ pages: 5, C: 400, P: 1000 })).drafts).toHaveLength(1);
  });

  it("uses the 20% change boundary", () => {
    expect(run(group({ C: 801, P: 1000 })).drafts).toHaveLength(0);
    expect(run(group({ C: 800, P: 1000 })).drafts).toHaveLength(1);
  });

  it("needs an absolute change of at least 30 clicks", () => {
    expect(run(group({ C: 71, P: 100 })).drafts).toHaveLength(0);
    expect(run(group({ C: 70, P: 100 })).drafts).toHaveLength(1);
  });

  it("drops a change that last year contradicts", () => {
    // Düşüş, ama geçen yılın aynı haftalarından yüksek: mevsimsel.
    expect(run(group({ C: 800, P: 1000, Y: 700 })).drafts).toHaveLength(0);
    const confirmed = run(group({ C: 800, P: 1000, Y: 1100 })).drafts[0]!;
    expect(confirmed.confidence).toBe("SIGNIFICANT");
  });

  it("skips the root section and caps at five", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const parts = names.map((name) => group({ C: 500, P: 1000, name }));
    const snapshot = snapshotFixture({
      pages: [
        ...parts.flatMap((p) => p.pages),
        page("root", "/", { impressions: 100, clicks: 1 }),
      ],
      previousPages: parts.flatMap((p) => p.previousPages),
    });
    const result = run(snapshot);
    expect(result.drafts).toHaveLength(5);
    expect(result.seen).toHaveLength(6);
  });
});

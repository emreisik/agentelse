import { describe, expect, it } from "vitest";

import {
  guardCandidates,
  guardTitles,
  keywordKey,
  locationTemplate,
  tokenJaccard,
} from "./doorway";
import { candidateFixture } from "./test-support";
import type { PlanCandidate } from "./types";

function words(from: number, to: number): string {
  const out: string[] = [];
  for (let i = from; i <= to; i += 1) out.push(`w${String(i).padStart(2, "0")}`);
  return out.join(" ");
}

function cand(keyword: string, score: number): PlanCandidate {
  return candidateFixture({ keyword, score, clusterId: null, id: `SUPPORT:q:${keywordKey(keyword)}` });
}

const NO_CONTEXT = {
  existingTitles: [],
  existingKeywords: [],
  rejectedKeys: [],
  brandTerms: [],
};

describe("keywordKey and tokenJaccard", () => {
  it("is order-free, unique and folded", () => {
    expect(keywordKey("Blue Widget REPAIR")).toBe("blue repair widget");
    expect(keywordKey("repair widget blue blue")).toBe("blue repair widget");
  });

  it("folds Turkish letters", () => {
    expect(keywordKey("Diş Tedavisi")).toBe(keywordKey("dis tedavisi"));
    expect(tokenJaccard("Diş Tedavisi Fiyatları", "dis tedavisi fiyatlari")).toBe(1);
  });

  it("computes Jaccard and handles empties", () => {
    expect(tokenJaccard("alpha beta gamma", "alpha beta gamma delta epsilon")).toBeCloseTo(0.6, 10);
    expect(tokenJaccard("", "alpha")).toBe(0);
    expect(tokenJaccard("an", "an")).toBe(0);
  });
});

describe("locationTemplate", () => {
  it("masks place names and returns null without one", () => {
    expect(locationTemplate("dental implant istanbul")).toBe("dental implant {place}");
    expect(locationTemplate("dental implant ankara")).toBe("dental implant {place}");
    expect(locationTemplate("dental implant cost")).toBeNull();
  });

  it("handles multi-word places", () => {
    expect(locationTemplate("plumber new york")).toBe("plumber {place}");
  });
});

describe("guardCandidates", () => {
  it("merges near duplicates at Jaccard 0.6 but not at 0.571", () => {
    const a = cand("alpha beta gamma", 0.5);
    const near = cand("alpha beta gamma delta epsilon", 0.4);
    const result = guardCandidates([near, a], NO_CONTEXT);
    expect(result.kept.map((c) => c.keyword)).toEqual(["alpha beta gamma"]);
    expect(result.rejected).toEqual([{ candidateId: near.id, reason: "NEAR_DUPLICATE" }]);

    const four = cand("alpha beta gamma delta", 0.5);
    const seven = cand("alpha beta gamma delta epsilon zeta eta", 0.4);
    const ok = guardCandidates([four, seven], NO_CONTEXT);
    expect(ok.kept).toHaveLength(2);
  });

  it("keeps the higher score of a near-duplicate pair", () => {
    const low = cand("alpha beta gamma", 0.1);
    const high = cand("alpha beta gamma delta epsilon", 0.9);
    const result = guardCandidates([low, high], NO_CONTEXT);
    expect(result.kept.map((c) => c.id)).toEqual([high.id]);
  });

  it("rejects near duplicates of an existing keyword", () => {
    // 10 sözcük, 7'si ortak, mevcut anahtar 8 sözcük: Jaccard 0.636, kapsama 0.7.
    const candidate = cand(words(1, 10), 0.5);
    const result = guardCandidates([candidate], {
      ...NO_CONTEXT,
      existingKeywords: [`${words(1, 7)} zzz`],
    });
    expect(result.rejected).toEqual([{ candidateId: candidate.id, reason: "NEAR_DUPLICATE" }]);
  });

  it("rejects a topic an existing title already covers at 0.8 but not 0.76", () => {
    const keyword = words(1, 25);
    const covered = guardCandidates([cand(keyword, 0.5)], {
      ...NO_CONTEXT,
      existingTitles: [`${words(1, 20)} extra tokens here`],
    });
    expect(covered.rejected[0]?.reason).toBe("EXISTING_PAGE");
    const notCovered = guardCandidates([cand(keyword, 0.5)], {
      ...NO_CONTEXT,
      existingTitles: [`${words(1, 19)} extra tokens here`],
    });
    expect(notCovered.kept).toHaveLength(1);
  });

  it("matches existing coverage with Turkish folding", () => {
    const result = guardCandidates([cand("Diş Beyazlatma", 0.5)], {
      ...NO_CONTEXT,
      existingTitles: ["Dis beyazlatma nasil yapilir"],
    });
    expect(result.rejected[0]?.reason).toBe("EXISTING_PAGE");
  });

  it("rejects earlier rejected topics and brand-like keywords", () => {
    const result = guardCandidates(
      [cand("teeth whitening", 0.5), cand("acme dental plan", 0.4)],
      { ...NO_CONTEXT, rejectedKeys: [keywordKey("whitening teeth")], brandTerms: ["acme"] },
    );
    expect(result.rejected.map((r) => r.reason).sort()).toEqual(["BRAND_QUERY", "REJECTED_BEFORE"]);
    expect(result.kept).toHaveLength(0);
  });

  it("keeps none of a location-swapped group (defence in depth)", () => {
    const a = cand("dental implant istanbul", 0.5);
    const b = cand("dental implant ankara", 0.4);
    const c = cand("dental implant izmir", 0.3);
    const result = guardCandidates([a, b, c], NO_CONTEXT);
    expect(result.kept).toHaveLength(0);
    expect(result.rejected).toHaveLength(3);
    expect(new Set(result.rejected.map((r) => r.reason))).toEqual(new Set(["LOCATION_TEMPLATE"]));
  });

  it("rejects the third candidate with the same two-word prefix or suffix", () => {
    const list = [
      cand("how to fix leaking tap", 0.9),
      cand("how to repair broken door", 0.8),
      cand("how to replace loud speaker", 0.7),
      cand("mighty garden spade", 0.5),
    ];
    const result = guardCandidates(list, NO_CONTEXT);
    expect(result.kept.map((c) => c.keyword)).toEqual([
      "how to fix leaking tap",
      "how to repair broken door",
      "mighty garden spade",
    ]);
    expect(result.rejected).toEqual([{ candidateId: list[2]!.id, reason: "TEMPLATE_REPEAT" }]);

    const suffix = guardCandidates(
      [cand("cheap plumbing services", 0.9), cand("urgent plumbing services", 0.8), cand("local plumbing services", 0.7)],
      NO_CONTEXT,
    );
    expect(suffix.rejected[0]?.reason).toBe("TEMPLATE_REPEAT");
  });

  it("lets a candidate that reuses a pool idea pass its own keyword", () => {
    const keyword = "alpha beta gamma delta";
    const context = { ...NO_CONTEXT, existingKeywords: [keyword] };
    const plain = guardCandidates([cand(keyword, 0.5)], context);
    expect(plain.rejected[0]?.reason).toBe("EXISTING_PAGE");
    const reuse = { ...cand(keyword, 0.5), reuseIdeaId: "idea-9" };
    expect(guardCandidates([reuse], context).kept).toHaveLength(1);
  });

  it("orders the output by score then id and never mutates the input", () => {
    const list = Object.freeze([
      Object.freeze(cand("charlie delta echo", 0.2)),
      Object.freeze(cand("alpha bravo foxtrot", 0.9)),
    ]) as readonly PlanCandidate[];
    const context = Object.freeze({
      existingTitles: Object.freeze([]) as readonly string[],
      existingKeywords: Object.freeze([]) as readonly string[],
      rejectedKeys: Object.freeze([]) as readonly string[],
      brandTerms: Object.freeze([]) as readonly string[],
    });
    const result = guardCandidates(list, context);
    expect(result.kept.map((c) => c.keyword)).toEqual(["alpha bravo foxtrot", "charlie delta echo"]);
    expect(list[0]!.keyword).toBe("charlie delta echo");
  });
});

describe("guardTitles", () => {
  it("rejects near-duplicate titles against existing ones and each other (0.7)", () => {
    const result = guardTitles(
      [
        { id: "a", title: "alpha beta gamma delta epsilon zeta eta" },
        // 7 ortak / 10 birleşim = 0.7
        { id: "b", title: "alpha beta gamma delta epsilon zeta eta theta iota kappa" },
        // 6 / 7 olmadığı için geçer
        { id: "c", title: "alpha beta gamma tango uniform victor" },
      ],
      { existingTitles: [] },
    );
    expect(result.ok.map((t) => t.id)).toEqual(["a", "c"]);
    expect(result.rejected).toEqual([{ id: "b", reason: "NEAR_DUPLICATE" }]);

    const vsExisting = guardTitles([{ id: "x", title: "Blue widget repair guide" }], {
      existingTitles: ["Blue widget repair guide"],
    });
    expect(vsExisting.rejected).toEqual([{ id: "x", reason: "NEAR_DUPLICATE" }]);
  });

  it("rejects location-swapped titles", () => {
    const result = guardTitles(
      [
        { id: "a", title: "Dental Implant Istanbul" },
        { id: "b", title: "Dental Implant Ankara" },
      ],
      { existingTitles: [] },
    );
    expect(result.ok.map((t) => t.id)).toEqual(["a"]);
    expect(result.rejected).toEqual([{ id: "b", reason: "LOCATION_TEMPLATE" }]);
  });

  it("also compares a location template with existing titles", () => {
    const result = guardTitles([{ id: "a", title: "Plumber Ankara" }], {
      existingTitles: ["Plumber Istanbul"],
    });
    expect(result.rejected[0]?.reason).toBe("LOCATION_TEMPLATE");
  });

  it("keeps unrelated titles in order", () => {
    const titles = [
      { id: "a", title: "Teeth whitening at home" },
      { id: "b", title: "Implant aftercare, week by week" },
    ];
    const result = guardTitles(titles, { existingTitles: ["Contact us"] });
    expect(result.ok).toEqual(titles);
    expect(result.rejected).toEqual([]);
  });
});

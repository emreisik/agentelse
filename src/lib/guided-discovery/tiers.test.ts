import { describe, expect, it } from "vitest";

import type { BrandConstitutionPayload } from "@/server/agency/constitution/constitution-schema";

import { isCandidateId } from "./contract";
import {
  applyTiers,
  candidateIdFor,
  finalScore,
  tierOf,
  type ConfidenceMap,
} from "./tiers";

function payload(over: Partial<BrandConstitutionPayload> = {}): BrandConstitutionPayload {
  return {
    language: "en",
    country: "TR",
    identity: "A bakery",
    businessModel: "Retail",
    products: ["Bread", "Cake"],
    markets: ["Istanbul"],
    audiences: ["Families"],
    positioning: "Neighbourhood favourite",
    valueProposition: "Fresh daily",
    personality: "Warm",
    toneOfVoice: "Friendly",
    visualIdentity: "Rustic",
    approvedClaims: ["Best bread"],
    forbiddenClaims: ["No gluten claims"],
    negativeBrief: ["No cartoons"],
    customerProblems: [],
    customerObjections: [],
    competitors: ["Rival"],
    differentiators: [],
    legalRestrictions: ["Food law"],
    knownFacts: ["Since 1990"],
    assumptions: ["old assumption"],
    openQuestions: ["old question"],
    logoAssetIds: [],
    ...over,
  };
}

const all = (score: number, evidence: "both" | "site" | "web" | "inferred" = "both"): ConfidenceMap => ({
  identity: { score, evidence },
  businessModel: { score, evidence },
  products: { score, evidence },
  markets: { score, evidence },
  audiences: { score, evidence },
  positioning: { score, evidence },
  valueProposition: { score, evidence },
  toneOfVoice: { score, evidence },
  competitors: { score, evidence },
});

describe("finalScore", () => {
  it("caps by evidence", () => {
    expect(finalScore(100, "inferred")).toBe(70);
    expect(finalScore(100, "site")).toBe(90);
    expect(finalScore(100, "web")).toBe(90);
    expect(finalScore(100, "both")).toBe(100);
    expect(finalScore(50, "inferred")).toBe(50);
  });
  it("clips to 0-100 and maps NaN to 0", () => {
    expect(finalScore(-5, "both")).toBe(0);
    expect(finalScore(250, "both")).toBe(100);
    expect(finalScore(Number.NaN, "both")).toBe(0);
    expect(finalScore(Number.POSITIVE_INFINITY, "both")).toBe(0);
  });
  it("an unknown evidence label gets the inferred cap", () => {
    expect(finalScore(99, "bogus" as never)).toBe(70);
  });
});

describe("tierOf boundaries", () => {
  it.each([
    [100, "accepted"],
    [85, "accepted"],
    [84, "assumed"],
    [60, "assumed"],
    [59, "unknown"],
    [0, "unknown"],
  ])("%i -> %s", (score, tier) => {
    expect(tierOf(score)).toBe(tier);
  });
});

describe("applyTiers: accepted", () => {
  const out = applyTiers(payload(), all(85));
  it("keeps values in payload and dossier, rows hold saved values", () => {
    expect(out.payload.identity).toBe("A bakery");
    expect(out.dossierPayload.identity).toBe("A bakery");
    expect(out.dossierPayload.products).toEqual(["Bread", "Cake"]);
    const about = out.rows.find((r) => r.field === "about")!;
    expect(about).toMatchObject({ tier: "accepted", score: 85, saved: ["A bakery"], candidates: [] });
    expect(out.rows.find((r) => r.field === "products")!.saved).toEqual(["Bread", "Cake"]);
  });
  it("adds no assumptions or questions", () => {
    expect(out.payload.assumptions).toEqual(["old assumption"]);
    expect(out.payload.openQuestions).toEqual(["old question"]);
  });
  it("maps rows in screen order without business model / value proposition", () => {
    expect(out.rows.map((r) => r.field)).toEqual([
      "about", "audience", "products", "markets", "voice", "positioning", "competitors",
    ]);
  });
});

describe("applyTiers: assumed", () => {
  const out = applyTiers(payload(), all(84));
  it("keeps the value in payload, drops it from the dossier, adds an assumption line", () => {
    expect(out.payload.identity).toBe("A bakery");
    expect(out.dossierPayload.identity).toBe("");
    expect(out.dossierPayload.products).toEqual([]);
    expect(out.payload.assumptions).toContain("About: A bakery (assumed, 84%)");
    expect(out.payload.assumptions).toContain("Products: Bread, Cake (assumed, 84%)");
    expect(out.payload.assumptions[0]).toBe("old assumption");
  });
  it("list rows become one candidate per item, text rows one candidate", () => {
    const products = out.rows.find((r) => r.field === "products")!;
    expect(products.tier).toBe("assumed");
    expect(products.saved).toEqual([]);
    expect(products.candidates.map((c) => c.text)).toEqual(["Bread", "Cake"]);
    expect(products.candidates.every((c) => isCandidateId(c.id) && !c.added && c.score === 84)).toBe(true);
    const about = out.rows.find((r) => r.field === "about")!;
    expect(about.candidates.map((c) => c.text)).toEqual(["A bakery"]);
  });
  it("cuts the assumption value to 120 code points", () => {
    const long = "é".repeat(300);
    const r = applyTiers(payload({ identity: long }), all(70));
    const line = r.payload.assumptions.find((l) => l.startsWith("About:"))!;
    expect(line).toBe(`About: ${"é".repeat(120)} (assumed, 70%)`);
    expect(r.rows[0]!.candidates[0]!.text).toBe("é".repeat(140));
  });
  it("does not split a surrogate pair at the cut", () => {
    const r = applyTiers(payload({ identity: "😀".repeat(200) }), all(70));
    const line = r.payload.assumptions.find((l) => l.startsWith("About:"))!;
    expect(line).toBe(`About: ${"😀".repeat(120)} (assumed, 70%)`);
  });
});

describe("applyTiers: unknown", () => {
  const out = applyTiers(payload(), all(59));
  it("empties the fields in both payloads and adds an open question", () => {
    expect(out.payload.identity).toBe("");
    expect(out.payload.products).toEqual([]);
    expect(out.dossierPayload.toneOfVoice).toBe("");
    expect(out.dossierPayload.competitors).toEqual([]);
    expect(out.payload.openQuestions).toContain("About: not found with enough confidence");
    expect(out.payload.openQuestions[0]).toBe("old question");
    const row = out.rows.find((r) => r.field === "about")!;
    expect(row).toMatchObject({ tier: "unknown", saved: [], candidates: [] });
  });
  it("a missing confidence counts as unknown", () => {
    const r = applyTiers(payload(), { identity: { score: 95, evidence: "both" } });
    expect(r.payload.identity).toBe("A bakery");
    expect(r.payload.products).toEqual([]);
    expect(r.rows.find((x) => x.field === "products")!.tier).toBe("unknown");
    expect(r.rows.find((x) => x.field === "products")!.score).toBe(0);
  });
  it("an empty value is unknown even with a high score", () => {
    const r = applyTiers(payload({ products: [], positioning: "  " }), all(95));
    expect(r.rows.find((x) => x.field === "products")!.tier).toBe("unknown");
    expect(r.rows.find((x) => x.field === "positioning")!.tier).toBe("unknown");
  });
});

describe("evidence caps reach the tiers", () => {
  it("inferred 100 can only be assumed", () => {
    const r = applyTiers(payload(), all(100, "inferred"));
    expect(r.rows.every((x) => x.tier === "assumed" && x.score === 70)).toBe(true);
    expect(r.dossierPayload.identity).toBe("");
  });
  it("site/web 100 is 90 and accepted; both 100 is 100", () => {
    expect(applyTiers(payload(), all(100, "site")).rows[0]!.score).toBe(90);
    expect(applyTiers(payload(), all(100, "both")).rows[0]!.score).toBe(100);
  });
});

describe("safety rules", () => {
  it("approvedClaims is always empty, in every tier", () => {
    for (const score of [100, 84, 10]) {
      const r = applyTiers(payload(), all(score));
      expect(r.payload.approvedClaims).toEqual([]);
      expect(r.dossierPayload.approvedClaims).toEqual([]);
    }
    expect(applyTiers(payload(), {}).payload.approvedClaims).toEqual([]);
  });
  it("leaves the untouched lists byte-identical", () => {
    const src = payload();
    for (const score of [100, 70, 10]) {
      const r = applyTiers(src, all(score));
      for (const out of [r.payload, r.dossierPayload]) {
        expect(JSON.stringify([out.forbiddenClaims, out.negativeBrief, out.knownFacts, out.legalRestrictions])).toBe(
          JSON.stringify([src.forbiddenClaims, src.negativeBrief, src.knownFacts, src.legalRestrictions]),
        );
      }
    }
  });
  it("never mutates its input", () => {
    const src = payload();
    const before = JSON.stringify(src);
    applyTiers(src, all(10));
    expect(JSON.stringify(src)).toBe(before);
  });
  it("cuts hostile-length list items and caps candidates", () => {
    const items = Array.from({ length: 20 }, (_, i) => `${i}-${"x".repeat(500)}`);
    const r = applyTiers(payload({ products: items }), all(70));
    const row = r.rows.find((x) => x.field === "products")!;
    expect(row.candidates).toHaveLength(8);
    expect(row.candidates.every((c) => Array.from(c.text).length <= 140)).toBe(true);
  });
  it("accepted saved items are cut and deduped", () => {
    const r = applyTiers(payload({ products: ["Bread", "bread", " ", "y".repeat(400)] }), all(90));
    const saved = r.rows.find((x) => x.field === "products")!.saved;
    expect(saved).toHaveLength(2);
    expect(Array.from(saved[1]!).length).toBe(140);
  });
});

describe("determinism", () => {
  it("same input gives the same output and stable ids", () => {
    const a = applyTiers(payload(), all(70));
    const b = applyTiers(payload(), all(70));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(candidateIdFor("products", "Bread")).toBe(candidateIdFor("products", "Bread"));
    expect(candidateIdFor("products", "Bread")).not.toBe(candidateIdFor("services", "Bread"));
    expect(isCandidateId(candidateIdFor("about", "x"))).toBe(true);
  });
});

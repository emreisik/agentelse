import { describe, expect, it } from "vitest";

import { BrandConstitutionPayloadSchema } from "@/server/agency/constitution/constitution-schema";
import { GUIDED_ONLY_OPEN_QUESTION } from "@/lib/guided-setup/contract";
import {
  baseOf,
  fillEmptyConstitution,
  isGuidedOnly,
  isGuidedOnlyRaw,
  mergeConstitution,
  thinConstitution,
} from "./constitution-merge";

const locale = { language: "tr", country: "TR" };

const rich = BrandConstitutionPayloadSchema.parse({
  language: "tr",
  country: "TR",
  identity: "Qr Hub Menu, restoranlar için QR menü",
  businessModel: "SaaS subscription",
  products: ["QR menu", "Order pad"],
  markets: ["Turkey"],
  audiences: ["Restaurant owners"],
  positioning: "Fast and simple",
  valueProposition: "Menus in minutes",
  personality: "Helpful",
  toneOfVoice: "Warm",
  visualIdentity: "Clean",
  approvedClaims: ["Trusted by venues"],
  forbiddenClaims: ["Best in the world"],
  negativeBrief: ["No neon"],
  customerProblems: ["Paper menus"],
  customerObjections: ["Price"],
  competitors: ["Acme"],
  differentiators: ["Speed"],
  legalRestrictions: ["GDPR"],
  knownFacts: ["Founded 2020 [source: x]"],
  assumptions: ["Mostly cafes"],
  openQuestions: ["Which cities?"],
  logoAssetIds: ["asset1"],
});
const PATCHED = ["identity", "positioning", "toneOfVoice", "audiences"];
const PROTECTED = Object.keys(rich).filter((k) => !PATCHED.includes(k));
const field = (p: object, k: string) => (p as Record<string, unknown>)[k];

describe("mergeConstitution", () => {
  const merged = mergeConstitution(
    rich,
    {
      identity: "New identity",
      audiences: ["Cafe owners", "Hotels"],
      toneOfVoice: "Friendly and warm",
      positioning: "Speed first",
    },
    locale,
  );

  it("changes the four patchable fields", () => {
    expect(merged.payload.identity).toBe("New identity");
    expect(merged.payload.audiences).toEqual(["Cafe owners", "Hotels"]);
    expect(merged.payload.toneOfVoice).toBe("Friendly and warm");
    expect(merged.payload.positioning).toBe("Speed first");
    expect(merged.changed).toBe(true);
  });

  it("G20: every other field is byte-identical over a rich base", () => {
    for (const key of PROTECTED) {
      expect(JSON.stringify(field(merged.payload, key))).toBe(
        JSON.stringify(field(rich, key)),
      );
    }
    expect(merged.payload.approvedClaims).toEqual(["Trusted by venues"]);
    expect(merged.payload.knownFacts).toEqual(["Founded 2020 [source: x]"]);
    expect(merged.payload.negativeBrief).toEqual(["No neon"]);
  });

  it("reports changed=false when the values are equal", () => {
    const noop = mergeConstitution(
      rich,
      { identity: rich.identity, audiences: rich.audiences },
      locale,
    );
    expect(noop.changed).toBe(false);
  });

  it("forces language and country from the project", () => {
    const fixed = mergeConstitution(
      { ...rich, language: "English" },
      {},
      locale,
    );
    expect(fixed.payload.language).toBe("tr");
    expect(fixed.payload.country).toBe("TR");
    expect(fixed.changed).toBe(true);
  });

  it("builds a thin v1 carrying the marker when there is no base", () => {
    const thin = mergeConstitution(
      null,
      { identity: "Software, app or online service" },
      locale,
    );
    expect(thin.changed).toBe(true);
    expect(isGuidedOnly(thin.payload)).toBe(true);
    expect(thin.payload.openQuestions).toEqual([GUIDED_ONLY_OPEN_QUESTION]);
  });

  it("keeps the marker when merging onto a thin base", () => {
    const thin = mergeConstitution(null, { identity: "x" }, locale).payload;
    const next = mergeConstitution(
      thin,
      { audiences: ["Families and parents"] },
      locale,
    );
    expect(isGuidedOnly(next.payload)).toBe(true);
  });

  it("tells a thin base from a rich one", () => {
    expect(isGuidedOnly(thinConstitution(locale))).toBe(true);
    expect(isGuidedOnly(rich)).toBe(false);
    expect(isGuidedOnlyRaw(thinConstitution(locale))).toBe(true);
    expect(isGuidedOnlyRaw(rich)).toBe(false);
    expect(isGuidedOnlyRaw({ nonsense: true })).toBe(false);
  });

  it("a researched section defeats the guided-only reading even with the marker", () => {
    const withFact = { ...thinConstitution(locale), knownFacts: ["A fact"] };
    expect(isGuidedOnly(withFact)).toBe(false);
    const withModel = { ...thinConstitution(locale), businessModel: "SaaS" };
    expect(isGuidedOnly(withModel)).toBe(false);
    const withValue = { ...thinConstitution(locale), valueProposition: "Fast" };
    expect(isGuidedOnly(withValue)).toBe(false);
    const noMarker = { ...thinConstitution(locale), openQuestions: [] };
    expect(isGuidedOnly(noMarker)).toBe(false);
  });
});

describe("thin seed from the dossier", () => {
  const seeded = mergeConstitution(
    null,
    { toneOfVoice: "Friendly and warm" },
    locale,
    {
      identity: "Dossier summary text",
      positioning: "Dossier positioning",
      toneOfVoice: "Dossier tone",
      audiences: ["Dossier audience", "  "],
    },
  );

  it("survives an unrelated patch", () => {
    expect(seeded.payload.identity).toBe("Dossier summary text");
    expect(seeded.payload.positioning).toBe("Dossier positioning");
  });

  it("carries the dossier tone when the patch does not touch it", () => {
    const out = mergeConstitution(null, { identity: "x" }, locale, {
      toneOfVoice: "Dossier tone",
    });
    expect(out.payload.toneOfVoice).toBe("Dossier tone");
  });

  it("is beaten by the patch", () => {
    expect(seeded.payload.toneOfVoice).toBe("Friendly and warm");
  });

  it("drops blank audiences and stays guided-only", () => {
    expect(seeded.payload.audiences).toEqual(["Dossier audience"]);
    expect(isGuidedOnly(seeded.payload)).toBe(true);
  });

  it("without a seed the fields are empty", () => {
    expect(thinConstitution(locale).identity).toBe("");
    expect(thinConstitution(locale).audiences).toEqual([]);
  });
});

describe("baseOf (G57, pure part)", () => {
  it("null is absent", () => {
    expect(baseOf(null).kind).toBe("absent");
  });

  it("a mock row is absent even when rich", () => {
    expect(baseOf({ isMock: true, payload: rich }).kind).toBe("absent");
  });

  it("a readable real row is the base", () => {
    const base = baseOf({ isMock: false, payload: rich });
    expect(base.kind).toBe("base");
    if (base.kind === "base") expect(base.payload.identity).toBe(rich.identity);
  });

  it("an unparseable real row is unreadable", () => {
    expect(baseOf({ isMock: false, payload: { nonsense: true } }).kind).toBe(
      "unreadable",
    );
  });

  it("no mock text reaches the merged payload", () => {
    const mockRich = BrandConstitutionPayloadSchema.parse({
      ...rich,
      knownFacts: ["MOCK FACT"],
      competitors: ["MOCK CO"],
      openQuestions: ["MOCK Q"],
    });
    const base = baseOf({ isMock: true, payload: mockRich });
    const merged = mergeConstitution(
      base.kind === "base" ? base.payload : null,
      { identity: "Real identity" },
      locale,
    );
    expect(merged.payload.knownFacts).toEqual([]);
    expect(merged.payload.competitors).toEqual([]);
    expect(merged.payload.openQuestions).toEqual([GUIDED_ONLY_OPEN_QUESTION]);
    expect(merged.payload.identity).toBe("Real identity");
    expect(isGuidedOnly(merged.payload)).toBe(true);
  });
});

describe("fillEmptyConstitution (G24, pure part)", () => {
  const discovered = BrandConstitutionPayloadSchema.parse({
    ...rich,
    identity: "Discovered identity",
    audiences: ["Discovered audience"],
    approvedClaims: ["SHOULD NEVER APPEAR"],
    openQuestions: ["Which cities?"],
    logoAssetIds: [],
  });
  const guided = mergeConstitution(
    mergeConstitution(
      null,
      { identity: "Software, app or online service" },
      locale,
    ).payload,
    { audiences: ["Families and parents"] },
    locale,
  ).payload;
  const late = fillEmptyConstitution(guided, discovered);

  it("user fields win", () => {
    expect(late.payload.identity).toBe("Software, app or online service");
    expect(late.payload.audiences).toEqual(["Families and parents"]);
  });

  it("empty fields are filled from research", () => {
    expect(late.payload.businessModel).toBe("SaaS subscription");
    expect(late.payload.knownFacts).toHaveLength(1);
    expect(late.changed).toBe(true);
  });

  it("drops the marker and takes the research questions", () => {
    expect(late.payload.openQuestions).not.toContain(GUIDED_ONLY_OPEN_QUESTION);
    expect(late.payload.openQuestions[0]).toBe("Which cities?");
  });

  it("approvedClaims never come from research", () => {
    expect(late.payload.approvedClaims).toEqual([]);
  });

  it("keeps language, country and logo assets of the active payload", () => {
    const other = {
      ...discovered,
      language: "en",
      country: "US",
      logoAssetIds: ["x"],
    };
    const out = fillEmptyConstitution(guided, other);
    expect(out.payload.language).toBe("tr");
    expect(out.payload.country).toBe("TR");
    expect(out.payload.logoAssetIds).toEqual([]);
  });

  it("a researched active is unchanged and nothing set is overridden", () => {
    const out = fillEmptyConstitution(rich, discovered);
    expect(out.payload.identity).toBe(rich.identity);
    expect(out.changed).toBe(false);
  });

  it("a non-guided active keeps its own open questions", () => {
    const active = { ...rich, competitors: [] };
    const out = fillEmptyConstitution(active, {
      ...discovered,
      competitors: ["New rival"],
      openQuestions: ["Other?"],
    });
    expect(out.payload.openQuestions).toEqual(["Which cities?"]);
    expect(out.payload.competitors).toEqual(["New rival"]);
  });
});

import { describe, expect, it } from "vitest";

import { constitutionSynthesisDef } from "./constitution-synthesis";

// The deep synthesis can be handed a first-draft constitution (Quick
// Discovery's) to refine instead of starting from the findings alone, which
// can be thin when only some of the research tasks completed.

const findings = [
  { statement: "Acme sells paint online.", classification: "VERIFIED_FACT" },
  { statement: "Acme may export.", classification: "ASSUMPTION" },
];
const base = {
  brandName: "Acme",
  domain: "acme.com.tr",
  languageName: "Turkish",
  countryName: "Turkey",
  findings,
};

describe("constitutionSynthesisDef.buildPrompt", () => {
  it("is exactly as before when there is no earlier version", () => {
    const { user } = constitutionSynthesisDef.buildPrompt(base);

    expect(user).not.toContain("Earlier draft");
    expect(user).toContain("Research findings:");
    expect(user).toContain("- [VERIFIED_FACT] Acme sells paint online.");
  });

  it("shows an earlier version as the starting point, before the findings", () => {
    const { user } = constitutionSynthesisDef.buildPrompt({
      ...base,
      previousConstitution: { identity: "Acme, İzmir merkezli boya üreticisi" },
    });

    expect(user).toContain("An earlier first-draft constitution exists");
    expect(user).toContain("Acme, İzmir merkezli boya üreticisi");
    expect(user.indexOf("Earlier draft:")).toBeLessThan(
      user.indexOf("Research findings:"),
    );
  });

  it("tells the model to keep established facts and not promote assumptions without support", () => {
    const { user } = constitutionSynthesisDef.buildPrompt({
      ...base,
      previousConstitution: { identity: "x" },
    });

    expect(user).toContain("Do not drop established facts");
    expect(user).toContain("do not turn its assumptions into facts");
  });

  it("caps a very large earlier version", () => {
    const { user } = constitutionSynthesisDef.buildPrompt({
      ...base,
      previousConstitution: { identity: "x".repeat(50_000) },
    });

    expect(user.length).toBeLessThan(12_000);
    expect(user).toContain("…");
  });

  it.each([null, undefined, "not an object"])(
    "ignores an earlier version that is %s",
    (previousConstitution) => {
      const { user } = constitutionSynthesisDef.buildPrompt({
        ...base,
        previousConstitution,
      });

      expect(user).not.toContain("Earlier draft");
    },
  );
});

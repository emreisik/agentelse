import { describe, expect, it } from "vitest";

import {
  FUNNEL_PRESETS,
  funnelPreset,
  validateFunnelDefinition,
} from "./definition";

// Bu dosyanın kanıtladığı (GA-F8 huni tanımı): adım sayısı 2..6, ad kuralları,
// olay adı deseni, sayfa yolu kuralları ('?' ve '#' yok, e-posta yok) ve
// hazır tanımların kendilerinin geçerli olması.

const base = {
  name: "Checkout",
  isOpen: false,
  periodDays: 28,
  steps: [
    { name: "Cart", kind: "event", value: "add_to_cart" },
    { name: "Thanks", kind: "page", value: "/thank-you" },
  ],
};

function withSteps(steps: unknown[]) {
  return validateFunnelDefinition({ ...base, steps });
}

describe("validateFunnelDefinition", () => {
  it("accepts a valid definition and trims text", () => {
    const result = validateFunnelDefinition({
      ...base,
      name: "  Checkout  ",
      isOpen: true,
    });
    expect(result).toMatchObject({
      ok: true,
      definition: { name: "Checkout", isOpen: true, periodDays: 28 },
    });
  });

  it("requires 2 to 6 steps", () => {
    expect(withSteps([base.steps[0]]).ok).toBe(false);
    const six = Array.from({ length: 6 }, (_, i) => ({
      name: `S${i}`,
      kind: "event",
      value: "page_view",
    }));
    expect(withSteps(six).ok).toBe(true);
    expect(withSteps([...six, six[0]]).ok).toBe(false);
  });

  it("rejects missing, long and duplicate names", () => {
    expect(validateFunnelDefinition({ ...base, name: " " }).ok).toBe(false);
    expect(validateFunnelDefinition({ ...base, name: "x".repeat(61) }).ok).toBe(
      false,
    );
    expect(
      withSteps([
        { name: "", kind: "event", value: "a" },
        base.steps[1],
      ]).ok,
    ).toBe(false);
    expect(
      withSteps([
        { name: "Same", kind: "event", value: "a" },
        { name: "same", kind: "event", value: "b" },
      ]),
    ).toEqual({ ok: false, message: "Each step needs its own name." });
  });

  it("validates event names", () => {
    for (const bad of ["1click", "has space", "a-b", "x".repeat(41), ""]) {
      expect(
        withSteps([{ name: "A", kind: "event", value: bad }, base.steps[1]]).ok,
      ).toBe(false);
    }
    expect(
      withSteps([
        { name: "A", kind: "event", value: "generate_lead" },
        base.steps[1],
      ]).ok,
    ).toBe(true);
  });

  it("validates page paths", () => {
    const check = (value: string) =>
      withSteps([base.steps[0], { name: "P", kind: "page", value }]);
    expect(check("/pricing").ok).toBe(true);
    expect(check("/").ok).toBe(true);
    expect(check("pricing").ok).toBe(false);
    expect(check("/pricing?plan=pro").ok).toBe(false);
    expect(check("/pricing#top").ok).toBe(false);
    expect(check("/a b").ok).toBe(false);
    expect(check(`/${"a".repeat(200)}`).ok).toBe(false);
  });

  it("rejects an email address in a page path, plain or encoded", () => {
    const check = (value: string) =>
      withSteps([base.steps[0], { name: "P", kind: "page", value }]);
    expect(check("/u/jane@example.com").ok).toBe(false);
    expect(check("/u/jane%40example.com").ok).toBe(false);
  });

  it("rejects an unknown step type and a bad period", () => {
    expect(
      withSteps([{ name: "A", kind: "url", value: "/x" }, base.steps[1]]).ok,
    ).toBe(false);
    expect(validateFunnelDefinition({ ...base, periodDays: 3 }).ok).toBe(false);
    expect(validateFunnelDefinition({ ...base, periodDays: 400 }).ok).toBe(
      false,
    );
    expect(validateFunnelDefinition({ ...base, periodDays: 7.5 }).ok).toBe(
      false,
    );
  });

  it("never throws on garbage", () => {
    for (const input of [null, undefined, 4, "x", [], { steps: "no" }]) {
      expect(validateFunnelDefinition(input).ok).toBe(false);
    }
  });
});

describe("FUNNEL_PRESETS", () => {
  it("offers lead and shop, and every preset validates", () => {
    expect(FUNNEL_PRESETS.map((preset) => preset.key)).toEqual([
      "lead",
      "shop",
    ]);
    for (const preset of FUNNEL_PRESETS) {
      expect(validateFunnelDefinition(preset.definition).ok).toBe(true);
    }
    expect(funnelPreset("shop")?.label).toBe("Shop");
    expect(funnelPreset("nope")).toBeNull();
  });
});

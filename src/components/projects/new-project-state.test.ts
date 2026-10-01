import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  NEW_PROJECT_ERRORS,
  initialNewProjectState,
  isNewProjectValid,
  languageFallbackNote,
  newProjectReducer,
  toNewProjectFormData,
  type NewProjectAction,
  type NewProjectState,
} from "./new-project-state";

function run(
  state: NewProjectState,
  ...actions: NewProjectAction[]
): NewProjectState {
  return actions.reduce(newProjectReducer, state);
}

const empty = () => initialNewProjectState(null);
const withName = (state: NewProjectState) =>
  run(state, { type: "name", value: "Qr Hub" });

describe("initial state (G52)", () => {
  it("defaults to Turkey/Turkish without a signal, visibly and without a provenance", () => {
    const state = empty();
    expect(state.countries).toEqual(["TR"]);
    expect(state.language).toBe("tr");
    expect(state.localeSource).toBeNull();
    expect(state.defaulted).toBe(true);
    expect(toNewProjectFormData(withName(state)).has("localeSource")).toBe(
      false,
    );
  });

  it("a detected default is not flagged as defaulted", () => {
    const state = initialNewProjectState({
      country: "MK",
      language: "mk",
      source: "previous",
    });
    expect(state.defaulted).toBe(false);
  });

  it("starts from the server default with its provenance", () => {
    const state = initialNewProjectState({
      country: "MK",
      language: "mk",
      source: "previous",
    });
    expect(state.countries).toEqual(["MK"]);
    expect(state.language).toBe("mk");
    expect(state.localeSource).toBe("previous");
  });
});

describe("market chips (G52)", () => {
  it("a chip tap REPLACES the primary market instead of appending", () => {
    const state = run(
      initialNewProjectState({
        country: "TR",
        language: "tr",
        source: "browser",
      }),
      { type: "tapMarket", code: "MK" },
    );
    expect(state.countries).toEqual(["MK"]);
  });

  it("keeps the extra markets when the primary is replaced, without duplicates", () => {
    const state = run(
      empty(),
      { type: "setMarkets", codes: ["TR", "AL", "XK"] },
      { type: "tapMarket", code: "XK" },
    );
    expect(state.countries).toEqual(["XK", "AL"]);
  });

  it("the person's tap ends the provenance; tapping the default keeps it", () => {
    const initial = initialNewProjectState({
      country: "TR",
      language: "tr",
      source: "browser",
    });
    expect(
      run(initial, { type: "tapMarket", code: "TR" }).localeSource,
    ).toBe("browser");
    expect(
      run(initial, { type: "tapMarket", code: "MK" }).localeSource,
    ).toBeNull();
  });
});

describe("language follows the market until touched (G52)", () => {
  it("derives the language from the market", () => {
    const state = run(empty(), { type: "tapMarket", code: "AL" });
    expect(state.language).toBe("sq");
    expect(run(state, { type: "tapMarket", code: "TR" }).language).toBe("tr");
  });

  it("stops following once the person picks a language", () => {
    const state = run(
      empty(),
      { type: "tapMarket", code: "TR" },
      { type: "setLanguage", code: "en" },
      { type: "tapMarket", code: "MK" },
    );
    expect(state.language).toBe("en");
    expect(state.languageTouched).toBe(true);
  });

  it("falls back to English visibly when the market's language is not offered", () => {
    const state = run(empty(), { type: "tapMarket", code: "RO" });
    expect(state.language).toBe("en");
    expect(languageFallbackNote(state)).toBe(
      "We don't write in Romanian yet, so we'll use English.",
    );
    expect(
      languageFallbackNote(run(state, { type: "setLanguage", code: "en" })),
    ).toBeNull();
    expect(
      languageFallbackNote(run(empty(), { type: "tapMarket", code: "US" })),
    ).toBeNull();
  });

  it("clearing every market clears an untouched language", () => {
    const state = run(
      empty(),
      { type: "tapMarket", code: "TR" },
      { type: "setMarkets", codes: [] },
    );
    expect(state.language).toBeNull();
    expect(state.defaulted).toBe(false);
  });

  it("changing the market re-derives the language unless touched", () => {
    const state = run(empty(), { type: "tapMarket", code: "AL" });
    expect(state.language).toBe("sq");
    expect(state.defaulted).toBe(false);
  });

  it("removing the primary in the multi-select re-derives the language", () => {
    const state = run(
      empty(),
      { type: "setMarkets", codes: ["TR", "MK"] },
      { type: "setMarkets", codes: ["MK"] },
    );
    expect(state.countries).toEqual(["MK"]);
    expect(state.language).toBe("mk");
  });
});

describe("the typed website (ccTLD rung)", () => {
  const previous = {
    country: "TR" as const,
    language: "tr" as const,
    source: "previous" as const,
  };

  it("outranks the server default until the person taps a market", () => {
    const state = run(initialNewProjectState(previous), {
      type: "domain",
      value: "shop.mk",
    });
    expect(state.countries).toEqual(["MK"]);
    expect(state.language).toBe("mk");
    expect(state.localeSource).toBe("tld");
  });

  it("falls back to the built-in default when nothing is detected anywhere", () => {
    const state = run(
      empty(),
      { type: "domain", value: "shop.mk" },
      { type: "domain", value: "shop.com" },
    );
    expect(state.countries).toEqual(["TR"]);
    expect(state.language).toBe("tr");
    expect(state.defaulted).toBe(true);
  });

  it("reverts to the server default when the address has no signal", () => {
    const state = run(
      initialNewProjectState(previous),
      { type: "domain", value: "shop.mk" },
      { type: "domain", value: "shop.com" },
    );
    expect(state.countries).toEqual(["TR"]);
    expect(state.localeSource).toBe("previous");
  });

  it("never overrides the person's own tap", () => {
    const state = run(
      initialNewProjectState(previous),
      { type: "tapMarket", code: "AL" },
      { type: "domain", value: "shop.mk" },
    );
    expect(state.countries).toEqual(["AL"]);
    expect(state.localeSource).toBeNull();
  });
});

describe("submit needs only a name", () => {
  it("is valid with a name alone: no market or language tap", () => {
    const state = withName(empty());
    expect(isNewProjectValid(state)).toBe(true);
    expect(run(state, { type: "submit" }).focus).toBeNull();
  });

  it("an empty submit reports only the name", () => {
    const state = run(empty(), { type: "submit" });
    expect(Object.keys(state.errors).filter((k) => state.errors[k as keyof typeof state.errors])).toEqual(["name"]);
  });
});

describe("submit without a market (G52)", () => {
  const cleared = () =>
    run(withName(empty()), { type: "setMarkets", codes: [] });

  it("yields new.error.country and a focus target on the market group", () => {
    const state = run(cleared(), { type: "submit" });
    expect(state.errors.country).toBe(NEW_PROJECT_ERRORS.country);
    expect(state.errors.country).toBe("Pick where your customers are.");
    expect(state.focus).toBe("market");
  });

  it("the error clears as soon as a market is chosen", () => {
    const state = run(
      cleared(),
      { type: "submit" },
      { type: "tapMarket", code: "TR" },
    );
    expect(state.errors.country).toBeUndefined();
  });

  it("an empty submit reports the market only; the language follows the tapped market without a stale error", () => {
    const submitted = run(cleared(), { type: "submit" });
    expect(submitted.errors.country).toBeDefined();
    expect(submitted.errors.language).toBeUndefined();
    const tapped = run(submitted, { type: "tapMarket", code: "TR" });
    expect(tapped.language).toBe("tr");
    expect(tapped.errors.language).toBeUndefined();
  });

  it("a language error left over from before is cleared once a market supplies the language", () => {
    const stale: NewProjectState = {
      ...withName(empty()),
      errors: { language: NEW_PROJECT_ERRORS.language },
    };
    expect(run(stale, { type: "tapMarket", code: "TR" }).errors.language)
      .toBeUndefined();
    expect(run(stale, { type: "setMarkets", codes: ["TR"] }).errors.language)
      .toBeUndefined();
    expect(run(stale, { type: "domain", value: "example.com.tr" }).errors.language)
      .toBeUndefined();
  });

  it("focuses the first problem in visual order and shows all of them", () => {
    const state = run(
      empty(),
      { type: "domain", value: "not a domain" },
      { type: "setMarkets", codes: [] },
      { type: "submit" },
    );
    expect(state.errors.name).toBe(NEW_PROJECT_ERRORS.name);
    expect(state.errors.domain).toBeDefined();
    expect(state.errors.country).toBeDefined();
    expect(state.focus).toBe("name");
  });

  it("flags an invalid website and an over-long name", () => {
    const bad = run(
      empty(),
      { type: "name", value: "x".repeat(121) },
      { type: "domain", value: "not a domain" },
      { type: "tapMarket", code: "TR" },
      { type: "submit" },
    );
    expect(bad.errors.name).toBe(NEW_PROJECT_ERRORS.nameLong);
    expect(bad.errors.domain).toBe(NEW_PROJECT_ERRORS.domain);
    expect(bad.focus).toBe("name");
  });

  it("is valid with a name and a market (website optional)", () => {
    const state = run(withName(empty()), { type: "tapMarket", code: "TR" });
    expect(isNewProjectValid(state)).toBe(true);
    expect(run(state, { type: "submit" }).focus).toBeNull();
  });
});

describe("form data", () => {
  it("posts one country entry per market, first = primary, and the provenance", () => {
    const state = run(
      initialNewProjectState({
        country: "TR",
        language: "tr",
        source: "browser",
      }),
      { type: "name", value: "  Qr Hub  " },
      { type: "domain", value: "example.com" },
    );
    const formData = toNewProjectFormData(state);
    expect(formData.get("name")).toBe("Qr Hub");
    expect(formData.get("domain")).toBe("example.com");
    expect(formData.getAll("country")).toEqual(["TR"]);
    expect(formData.get("language")).toBe("tr");
    expect(formData.get("localeSource")).toBe("browser");
  });

  it("carries no brandName", () => {
    const formData = toNewProjectFormData(withName(empty()));
    expect(formData.has("brandName")).toBe(false);
    expect(formData.getAll("country")).toEqual(["TR"]);
    expect(formData.get("language")).toBe("tr");
  });

  it("omits the provenance once the person chose", () => {
    const state = run(withName(empty()), { type: "tapMarket", code: "MK" });
    expect(toNewProjectFormData(state).has("localeSource")).toBe(false);
  });
});

// The screen itself is thin and has no DOM test, so its two hard rules are
// pinned on the source: the button is never disabled, and the sentences that
// promised behaviour that no longer exists are gone.
describe("new-project-form.tsx source rules", () => {
  const source = readFileSync(
    path.join(__dirname, "new-project-form.tsx"),
    "utf8",
  );

  it("never disables the submit button", () => {
    expect(source).not.toMatch(/(?<![-\w])disabled=/);
    expect(source).toContain("aria-disabled");
  });

  it("does not repeat the three false promises of the four-step wizard", () => {
    expect(source).not.toContain("Create and Start Setup");
    expect(source).not.toMatch(/analyze your brand automatically/i);
    expect(source).not.toContain("12-stage");
  });

  it("has no brand-name override and one Change disclosure for the market", () => {
    expect(source).not.toContain("Different brand name?");
    expect(source).toContain("Customers in ");
    expect(source).toMatch(/aria-expanded=\{marketOpen\}/);
  });

  it("uses no effect hook (defaults are derived, not synced)", () => {
    expect(source).not.toMatch(/useEffect|useLayoutEffect/);
  });
});

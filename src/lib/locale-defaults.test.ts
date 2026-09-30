import { describe, expect, it } from "vitest";

import {
  countryForTld,
  isLocaleSource,
  languageForCountry,
  parseAcceptLanguage,
  pickLocaleDefault,
} from "./locale-defaults";
import {
  SUPPORTED_COUNTRIES,
  isSupportedCountry,
  isSupportedLanguage,
} from "./locales";

// The new-project screen suggests a market and a content language and shows
// where the suggestion came from. These rules decide when it may suggest at
// all: a wrong guess is worse than none, so the ladder is conservative.

describe("languageForCountry", () => {
  it("answers with a supported language for every supported market", () => {
    for (const { code } of SUPPORTED_COUNTRIES) {
      expect(isSupportedLanguage(languageForCountry(code))).toBe(true);
    }
  });

  it.each([
    ["TR", "tr"],
    ["MK", "mk"],
    ["AL", "sq"],
    ["XK", "sq"],
    ["RS", "sr"],
    ["BG", "bg"],
    ["GR", "el"],
    ["DE", "de"],
    ["AT", "de"],
    ["FR", "fr"],
    ["ES", "es"],
    ["GB", "en"],
    ["AE", "ar"],
  ])("maps %s to %s", (country, language) => {
    expect(languageForCountry(country)).toBe(language);
  });

  it("falls back to English where no language of the market is offered", () => {
    for (const country of ["RO", "HR", "PT", "PL", "SE", "NO", "DK"]) {
      expect(languageForCountry(country)).toBe("en");
    }
  });

  it("reads anything that is not a supported market as English", () => {
    expect(languageForCountry("ZZ")).toBe("en");
    expect(languageForCountry("")).toBe("en");
    expect(languageForCountry("tr")).toBe("en");
  });
});

describe("countryForTld", () => {
  it.each([
    ["shop.com.tr", "TR"],
    ["shop.co.uk", "GB"],
    ["example.de", "DE"],
    ["example.mk", "MK"],
    ["https://www.Example.AL/path?x=1", "AL"],
    ["example.ca", "CA"],
  ])("reads %s as %s", (domain, country) => {
    expect(countryForTld(domain)).toBe(country);
  });

  it.each([
    "example.com",
    "example.net",
    "example.io",
    "example.me",
    "example.xk",
    "example.info",
    "localhost",
    "tr",
    "example.constructor",
    "example.__proto__",
    "",
  ])("says nothing for %s", (domain) => {
    expect(countryForTld(domain)).toBeNull();
  });

  it("only ever answers with a supported market", () => {
    for (const label of [
      "tr",
      "mk",
      "al",
      "rs",
      "bg",
      "gr",
      "ro",
      "ba",
      "hr",
      "de",
      "at",
      "ch",
      "nl",
      "be",
      "fr",
      "it",
      "es",
      "pt",
      "uk",
      "ie",
      "pl",
      "se",
      "no",
      "dk",
      "ae",
      "sa",
      "us",
      "ca",
    ]) {
      const country = countryForTld(`brand.${label}`);
      expect(country && isSupportedCountry(country)).toBe(true);
    }
  });

  it("ignores a trailing dot", () => {
    expect(countryForTld("example.com.tr.")).toBe("TR");
  });
});

describe("parseAcceptLanguage", () => {
  it("orders by quality and keeps the region", () => {
    expect(parseAcceptLanguage("en;q=0.5,tr-TR,de-AT;q=0.8")).toEqual([
      { language: "tr", country: "TR" },
      { language: "de", country: "AT" },
      { language: "en" },
    ]);
  });

  it("keeps the header order between equal qualities", () => {
    expect(parseAcceptLanguage("mk,bg,el")).toEqual([
      { language: "mk" },
      { language: "bg" },
      { language: "el" },
    ]);
  });

  it("reads the two-letter subtag as the region, not a script or a number", () => {
    expect(parseAcceptLanguage("sr-Latn-RS")).toEqual([
      { language: "sr", country: "RS" },
    ]);
    expect(parseAcceptLanguage("es-419")).toEqual([{ language: "es" }]);
  });

  it("drops a wildcard, a zero quality, an invalid quality and garbage", () => {
    expect(
      parseAcceptLanguage("*,tr;q=0,de;q=abc,fr;q=2,;;;,%%%,i-default,it"),
    ).toEqual([{ language: "it" }]);
  });

  it("normalizes the case", () => {
    expect(parseAcceptLanguage("TR-tr")).toEqual([
      { language: "tr", country: "TR" },
    ]);
  });

  it("answers with nothing for an absent or empty header", () => {
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
  });

  it("caps a huge header instead of parsing all of it", () => {
    const huge = Array.from({ length: 500 }, () => "tr").join(",");

    expect(parseAcceptLanguage(huge).length).toBeLessThanOrEqual(16);
  });
});

describe("pickLocaleDefault", () => {
  it("prefers the website's country-code TLD over everything else", () => {
    expect(
      pickLocaleDefault({
        domain: "shop.com.tr",
        previous: { language: "mk", country: "MK" },
        acceptLanguage: "de-DE",
      }),
    ).toEqual({ country: "TR", language: "tr", source: "tld" });
  });

  it("uses the workspace's latest project when the website says nothing", () => {
    expect(
      pickLocaleDefault({
        domain: "example.com",
        previous: { language: "en", country: "TR" },
        acceptLanguage: "de-DE",
      }),
    ).toEqual({ country: "TR", language: "en", source: "previous" });
  });

  it("ignores a previous project whose values are no longer supported", () => {
    expect(
      pickLocaleDefault({
        previous: { language: "xx", country: "TR" },
        acceptLanguage: "tr-TR",
      }),
    ).toMatchObject({ source: "browser" });
    expect(
      pickLocaleDefault({ previous: { language: "tr", country: "ZZ" } }),
    ).toBeNull();
  });

  it("falls to the browser last", () => {
    expect(pickLocaleDefault({ acceptLanguage: "de-CH,en;q=0.5" })).toEqual({
      country: "CH",
      language: "de",
      source: "browser",
    });
  });

  it("names a market from a bare language only where it is unambiguous", () => {
    expect(pickLocaleDefault({ acceptLanguage: "tr" })).toEqual({
      country: "TR",
      language: "tr",
      source: "browser",
    });
    expect(pickLocaleDefault({ acceptLanguage: "el" })).toMatchObject({
      country: "GR",
    });
    expect(pickLocaleDefault({ acceptLanguage: "de" })).toBeNull();
    expect(pickLocaleDefault({ acceptLanguage: "sq" })).toBeNull();
    expect(pickLocaleDefault({ acceptLanguage: "ar" })).toBeNull();
  });

  it("treats plain English and en-US as no signal at all", () => {
    expect(pickLocaleDefault({ acceptLanguage: "en" })).toBeNull();
    expect(pickLocaleDefault({ acceptLanguage: "en-US" })).toBeNull();
    expect(pickLocaleDefault({ acceptLanguage: "en-US,en;q=0.9" })).toBeNull();
  });

  it("still lets a deliberate second language through past en-US", () => {
    expect(pickLocaleDefault({ acceptLanguage: "en-US,tr;q=0.9" })).toEqual({
      country: "TR",
      language: "tr",
      source: "browser",
    });
  });

  it("takes a deliberate regional English", () => {
    expect(pickLocaleDefault({ acceptLanguage: "en-GB" })).toEqual({
      country: "GB",
      language: "en",
      source: "browser",
    });
  });

  it("suggests nothing when there is no signal, so no chip is pre-selected", () => {
    expect(pickLocaleDefault({})).toBeNull();
    expect(
      pickLocaleDefault({
        domain: "example.com",
        previous: null,
        acceptLanguage: null,
      }),
    ).toBeNull();
  });

  it("only ever answers with values from the closed lists", () => {
    const answers = [
      pickLocaleDefault({ domain: "a.co.uk" }),
      pickLocaleDefault({ acceptLanguage: "sr-Latn-RS" }),
      pickLocaleDefault({ previous: { language: "tr", country: "TR" } }),
    ];

    for (const answer of answers) {
      expect(answer).not.toBeNull();
      expect(isSupportedCountry(answer?.country ?? "")).toBe(true);
      expect(isSupportedLanguage(answer?.language ?? "")).toBe(true);
    }
  });
});

describe("isLocaleSource", () => {
  it("accepts the three sources and nothing else", () => {
    expect(isLocaleSource("tld")).toBe(true);
    expect(isLocaleSource("previous")).toBe(true);
    expect(isLocaleSource("browser")).toBe(true);
    expect(isLocaleSource("gps")).toBe(false);
    expect(isLocaleSource(undefined)).toBe(false);
    expect(isLocaleSource(1)).toBe(false);
  });
});

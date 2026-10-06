import { describe, expect, it } from "vitest";

import { isLocalQuery, placesIn, ruleIntent } from "./intent";
import { LOCAL_MARKERS, PLACE_NAMES, TURKISH_PROVINCE_COUNT } from "./places";

const plain = { isBrand: false };

describe("ruleIntent", () => {
  it("classifies by markers on folded tokens", () => {
    expect(ruleIntent("acme shoes", { isBrand: true })).toBe("navigational");
    expect(ruleIntent("buy running shoes", plain)).toBe("transactional");
    expect(ruleIntent("diş beyazlatma FİYATI", plain)).toBe("transactional");
    expect(ruleIntent("online satın al", plain)).toBe("transactional");
    expect(ruleIntent("en iyi diş hekimi", plain)).toBe("commercial");
    expect(ruleIntent("nike vs adidas", plain)).toBe("commercial");
    expect(ruleIntent("nasıl yapılır", plain)).toBe("informational");
    expect(ruleIntent("How to tie a tie", plain)).toBe("informational");
    expect(ruleIntent("seo worth it?", plain)).toBe("informational");
    expect(ruleIntent("kedi süt içer mi", plain)).toBe("informational");
    expect(ruleIntent("running shoes", plain)).toBeNull();
    expect(ruleIntent("   ", plain)).toBeNull();
  });

  it("matches whole words only", () => {
    expect(ruleIntent("bus stop schedule", plain)).toBeNull();
    expect(ruleIntent("bookshelf ideas", plain)).toBeNull();
    expect(ruleIntent("ensemble cast", plain)).toBeNull();
  });

  it("folds İ and ı the same way", () => {
    expect(ruleIntent("İNDİRİM kodu", plain)).toBe("transactional");
    expect(ruleIntent("INDIRIM kodu", plain)).toBe("transactional");
    expect(ruleIntent("NASIL yapilir", plain)).toBe("informational");
  });
});

describe("local intent", () => {
  it("detects proximity markers", () => {
    expect(isLocalQuery("dentist near me")).toBe(true);
    expect(isLocalQuery("en yakın eczane")).toBe(true);
    expect(isLocalQuery("YAKINIMDAKİ kuaför")).toBe(true);
    expect(isLocalQuery("dentist prices")).toBe(false);
    expect(isLocalQuery("")).toBe(false);
  });

  it("finds built-in places, multi-word ones too", () => {
    expect(placesIn("kuaför izmir")).toEqual(["izmir"]);
    expect(placesIn("İSTANBUL diş hekimi")).toEqual(["istanbul"]);
    expect(placesIn("best pizza new york")).toEqual(["new york"]);
    expect(placesIn("ohrid hotels and skopje")).toEqual(["ohrid", "skopje"]);
    expect(placesIn("newyork")).toEqual([]);
    expect(isLocalQuery("kuaför izmir")).toBe(true);
  });

  it("ships the full province list, folded", () => {
    expect(TURKISH_PROVINCE_COUNT).toBe(81);
    expect(PLACE_NAMES).toContain("sanliurfa");
    expect(PLACE_NAMES).toContain("igdir");
    expect(LOCAL_MARKERS).toContain("yakinimda");
    for (const place of PLACE_NAMES) {
      expect(place).toBe(place.toLowerCase());
    }
  });
});

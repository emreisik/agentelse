import { describe, expect, it } from "vitest";

import {
  SEARCH_ALERT_KIND_NAMES,
  SEARCH_ALERT_KINDS,
  SEARCH_TELEGRAM_FALLBACK,
  isSearchAlertKind,
  kindsForSource,
  searchDedupeKey,
  seoTelegramPhrase,
} from "./alert-kinds";

describe("search alert kinds", () => {
  it("gives every kind a source, check and part", () => {
    expect(SEARCH_ALERT_KIND_NAMES).toHaveLength(35);
    for (const kind of SEARCH_ALERT_KIND_NAMES) {
      const def = SEARCH_ALERT_KINDS[kind];
      expect(["GSC", "SEO"]).toContain(def.source);
      expect(def.check).toMatch(/^(SH\d+|CRAWL)$/);
      expect([
        "indexing",
        "technical",
        "sitemap_robots",
        "cwv",
        "data",
      ]).toContain(def.part);
      // Kaynak tür adının önekiyle aynı.
      expect(kind.startsWith(`${def.source}_`)).toBe(true);
    }
  });

  it("never sends GSC kinds to Telegram and gives every SEO kind a phrase", () => {
    for (const kind of kindsForSource("GSC")) {
      expect(SEARCH_ALERT_KINDS[kind].telegram).toBeNull();
    }
    for (const kind of kindsForSource("SEO")) {
      expect(SEARCH_ALERT_KINDS[kind].telegram).toEqual(expect.any(String));
    }
    expect(SEARCH_ALERT_KINDS.SEO_KEY_PAGE_NOINDEX.telegram).toBe(
      "a key page is set to noindex",
    );
    expect(SEARCH_ALERT_KINDS.SEO_CWV_POOR.telegram).toBe(
      "page speed for real visitors is poor",
    );
  });

  it("builds dedupe keys from the source", () => {
    for (const kind of SEARCH_ALERT_KIND_NAMES) {
      const prefix =
        SEARCH_ALERT_KINDS[kind].source === "GSC" ? "gsc:" : "seo:";
      expect(searchDedupeKey(kind)).toBe(`${prefix}${kind}`);
    }
  });

  it("keeps phrases free of digits, slashes, links, handles and quotes", () => {
    const phrases = [
      ...kindsForSource("SEO").map((kind) => SEARCH_ALERT_KINDS[kind].telegram),
      SEARCH_TELEGRAM_FALLBACK,
    ];
    for (const phrase of phrases) {
      expect(phrase).not.toMatch(/[0-9/@"'`’]/);
      expect(phrase).not.toMatch(/http/i);
      // Cümle içine girer: küçük harfle başlar.
      expect(phrase?.[0]).toBe(phrase?.[0]?.toLowerCase());
    }
  });

  it("falls back for GSC and unknown kinds", () => {
    expect(seoTelegramPhrase("GSC_SEARCH_DROP")).toBe(SEARCH_TELEGRAM_FALLBACK);
    expect(seoTelegramPhrase("SOMETHING_ELSE")).toBe(SEARCH_TELEGRAM_FALLBACK);
    expect(seoTelegramPhrase("SEO_ROBOTS_ERROR")).toBe(
      "robots.txt is returning server errors",
    );
    expect(isSearchAlertKind("SEO_HTTPS")).toBe(true);
    expect(isSearchAlertKind("toString")).toBe(false);
  });
});

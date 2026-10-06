import { describe, expect, it } from "vitest";

import type { RuleSnapshot } from "@/lib/seo/opportunity-types";

import { COUNTRY_LANGUAGE, primaryLanguage, SO13 } from "./international";
import {
  crawlPage,
  draftInvariantErrors,
  snapshotFixture,
} from "./test-support";

function run(snapshot: RuleSnapshot) {
  const result = SO13.evaluate(snapshot);
  if (!result.evaluable) throw new Error("not evaluable");
  return result;
}

function germany(impressions: number, overrides: Partial<RuleSnapshot> = {}) {
  return snapshotFixture({
    countries: [{ country: "deu", clicks: 5, impressions }],
    ...overrides,
  });
}

describe("SO13 international", () => {
  it("maps about sixty countries to their main language", () => {
    expect(Object.keys(COUNTRY_LANGUAGE).length).toBeGreaterThanOrEqual(60);
    expect(COUNTRY_LANGUAGE.mkd).toBe("mk");
    expect(COUNTRY_LANGUAGE.tur).toBe("tr");
    expect(primaryLanguage("en-US")).toBe("en");
    expect(primaryLanguage("x-default")).toBeNull();
  });

  it("fires from 500 impressions in a country whose language the site lacks", () => {
    expect(run(germany(499)).drafts).toHaveLength(0);
    const snapshot = germany(500);
    const draft = run(snapshot).drafts[0]!;
    expect(draft.subject).toBe("country:deu");
    expect(draft.actionKind).toBe("LOCALIZE");
    expect(draft.effort).toBe("L");
    expect(draft.signalWorthy).toBe(true);
    expect(draft.evidence.country).toBe("deu");
    expect(draft.title).toContain("Germany");
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("treats hreflang and page languages as covered", () => {
    const hreflang = germany(900, {
      crawl: {
        complete: true,
        pages: [
          crawlPage("h", "/", {
            lang: "en",
            hreflang: ["en", "de-DE", "x-default"],
          }),
        ],
        links: [],
      },
    });
    expect(run(hreflang).drafts).toHaveLength(0);
    const sameLanguage = snapshotFixture({
      countries: [{ country: "usa", clicks: 50, impressions: 9000 }],
    });
    expect(run(sameLanguage).drafts).toHaveLength(0);
  });

  it("stays quiet when no site language is known", () => {
    expect(run(germany(900, { projectLanguage: null })).drafts).toHaveLength(0);
  });

  it("caps at five but reports every country in seen", () => {
    const codes = ["deu", "fra", "ita", "esp", "nld", "pol", "swe"];
    const snapshot = snapshotFixture({
      countries: codes.map((country, i) => ({
        country,
        clicks: 1,
        impressions: 600 + i,
      })),
    });
    const result = run(snapshot);
    expect(result.drafts).toHaveLength(5);
    expect(result.seen).toHaveLength(7);
  });
});

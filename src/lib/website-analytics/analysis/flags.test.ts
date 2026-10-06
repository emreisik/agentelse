import { describe, expect, it } from "vitest";

import {
  gaInsightsDevProjectScope,
  gaInsightsListed,
  gaInsightsMode,
  gaInsightsModeFor,
  gaInsightsProjects,
  gaInsightsReplacesScanner,
  type GaInsightsEnv,
} from "./flags";

// Bu dosyanın kanıtladığı: GA_INSIGHTS çağrı anında okunur, GA_SYNC=true
// olmadan daima kapalıdır; gölge modda GA_INSIGHTS_PROJECTS projeleri "on"
// olur; canlı veritabanını paylaşan geliştirme süreci yalnız
// GA_SYNC_DEV_PROJECTS'i analiz eder.

const LIVE = "postgresql://user:pw@ep-cool-base.neon.tech/neondb";
const LOCAL = "postgresql://user@localhost:5432/test";

function env(extra: GaInsightsEnv): GaInsightsEnv {
  return { GA_SYNC: "true", NODE_ENV: "production", ...extra };
}

describe("gaInsightsMode", () => {
  it("parses off, shadow and on (trimmed, case-insensitive)", () => {
    expect(gaInsightsMode(env({}))).toBe("off");
    expect(gaInsightsMode(env({ GA_INSIGHTS: "" }))).toBe("off");
    expect(gaInsightsMode(env({ GA_INSIGHTS: "off" }))).toBe("off");
    expect(gaInsightsMode(env({ GA_INSIGHTS: "maybe" }))).toBe("off");
    expect(gaInsightsMode(env({ GA_INSIGHTS: "shadow" }))).toBe("shadow");
    expect(gaInsightsMode(env({ GA_INSIGHTS: " Shadow " }))).toBe("shadow");
    expect(gaInsightsMode(env({ GA_INSIGHTS: "on" }))).toBe("on");
    expect(gaInsightsMode(env({ GA_INSIGHTS: "ON" }))).toBe("on");
  });

  it("requires GA_SYNC to be exactly 'true'", () => {
    expect(gaInsightsMode({ GA_INSIGHTS: "on" })).toBe("off");
    expect(gaInsightsMode({ GA_INSIGHTS: "on", GA_SYNC: "TRUE" })).toBe("off");
    expect(gaInsightsMode({ GA_INSIGHTS: "on", GA_SYNC: "1" })).toBe("off");
    expect(gaInsightsMode({ GA_INSIGHTS: "on", GA_SYNC: "true" })).toBe("on");
  });

  it("only the 'on' mode replaces the old scanner globally", () => {
    expect(gaInsightsReplacesScanner(env({ GA_INSIGHTS: "on" }))).toBe(true);
    expect(gaInsightsReplacesScanner(env({ GA_INSIGHTS: "shadow" }))).toBe(
      false,
    );
    expect(
      gaInsightsReplacesScanner({ GA_INSIGHTS: "on", GA_SYNC: "false" }),
    ).toBe(false);
  });
});

describe("gaInsightsModeFor", () => {
  it("promotes listed projects to on while the global mode is shadow", () => {
    const e = env({ GA_INSIGHTS: "shadow", GA_INSIGHTS_PROJECTS: "p1, p2 ,," });
    expect(gaInsightsProjects(e)).toEqual(["p1", "p2"]);
    expect(gaInsightsModeFor("p1", e)).toBe("on");
    expect(gaInsightsModeFor("p2", e)).toBe("on");
    expect(gaInsightsModeFor("p3", e)).toBe("shadow");
  });

  it("keeps the list inert when the global mode is off or on", () => {
    expect(
      gaInsightsModeFor(
        "p1",
        env({ GA_INSIGHTS: "off", GA_INSIGHTS_PROJECTS: "p1" }),
      ),
    ).toBe("off");
    expect(
      gaInsightsModeFor(
        "p9",
        env({ GA_INSIGHTS: "on", GA_INSIGHTS_PROJECTS: "p1" }),
      ),
    ).toBe("on");
  });

  it("turns projects off in a dev process sharing the live database", () => {
    const dev: GaInsightsEnv = {
      GA_SYNC: "true",
      GA_INSIGHTS: "on",
      NODE_ENV: "development",
      DATABASE_URL: LIVE,
      GA_SYNC_DEV_PROJECTS: "dev-1",
    };
    expect(gaInsightsModeFor("dev-1", dev)).toBe("on");
    expect(gaInsightsModeFor("client-1", dev)).toBe("off");
    // Yerel tek kullanımlık veritabanında her proje.
    expect(gaInsightsModeFor("client-1", { ...dev, DATABASE_URL: LOCAL })).toBe(
      "on",
    );
  });
});

describe("gaInsightsListed", () => {
  it("is true when on, or shadow with a non-empty project list", () => {
    expect(gaInsightsListed(env({ GA_INSIGHTS: "on" }))).toBe(true);
    expect(gaInsightsListed(env({ GA_INSIGHTS: "shadow" }))).toBe(false);
    expect(
      gaInsightsListed(
        env({ GA_INSIGHTS: "shadow", GA_INSIGHTS_PROJECTS: "p1" }),
      ),
    ).toBe(true);
    expect(
      gaInsightsListed(env({ GA_INSIGHTS: "off", GA_INSIGHTS_PROJECTS: "p1" })),
    ).toBe(false);
    expect(gaInsightsListed({ GA_INSIGHTS: "on" })).toBe(false);
  });
});

describe("gaInsightsDevProjectScope", () => {
  it("is null in production and on a local database", () => {
    expect(gaInsightsDevProjectScope({ NODE_ENV: "production" })).toBeNull();
    expect(
      gaInsightsDevProjectScope({
        NODE_ENV: "development",
        DATABASE_URL: LOCAL,
        GA_SYNC_DEV_PROJECTS: "a",
      }),
    ).toBeNull();
  });

  it("is the dev project list (possibly empty) against the shared database", () => {
    expect(
      gaInsightsDevProjectScope({
        NODE_ENV: "development",
        DATABASE_URL: LIVE,
        GA_SYNC_DEV_PROJECTS: " a , b ",
      }),
    ).toEqual(["a", "b"]);
    expect(
      gaInsightsDevProjectScope({
        NODE_ENV: "development",
        DATABASE_URL: LIVE,
      }),
    ).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GA_FIX_ALPHA_KINDS,
  GaFixFlags,
  gaAutoAnnotationsEnabled,
  gaFixAlphaEnabled,
  gaFixKindEnabled,
  gaFixesEnabled,
  gaFixesEnabledFor,
  gaPublishAnnotationsEnabled,
  gaSyncProjectAllowList,
} from "./flags";

// Bu dosyanın kanıtladığı: GA-F7 bayrakları çağrı anında okunur, yalnız
// "true" açar; GA_FIXES tek başına yetmez (GA_SYNC de ister); alpha ailesi,
// otomatik not ve yayın notu zincirleme bağlıdır; yerel geliştirme süreci
// canlı veritabanını paylaşırken yalnız izin listesindeki projeler açılır.

const LIVE = "postgresql://user:pw@ep-cool-base.neon.tech/neondb";
const LOCAL = "postgresql://user@localhost:5432/test";

afterEach(() => {
  vi.unstubAllEnvs();
});

function setAll(values: Record<string, string>) {
  for (const name of [
    "GA_SYNC",
    "GA_FIXES",
    "GA_FIXES_ALPHA",
    "GA_FIXES_ANNOTATIONS",
    "GA_FIXES_ANNOTATIONS_PUBLISH",
  ]) {
    vi.stubEnv(name, values[name] ?? "");
  }
}

describe("GA-F7 flags", () => {
  const cases = [
    ["GA_FIXES", GaFixFlags.fixes],
    ["GA_FIXES_ALPHA", GaFixFlags.alpha],
    ["GA_FIXES_ANNOTATIONS", GaFixFlags.annotations],
    ["GA_FIXES_ANNOTATIONS_PUBLISH", GaFixFlags.publishAnnotations],
  ] as const;

  it.each(cases)("%s only turns on with the exact string 'true'", (name, flag) => {
    vi.stubEnv(name, "");
    expect(flag()).toBe(false);
    vi.stubEnv(name, "1");
    expect(flag()).toBe(false);
    vi.stubEnv(name, "TRUE");
    expect(flag()).toBe(false);
    vi.stubEnv(name, "true");
    expect(flag()).toBe(true);
    vi.stubEnv(name, "false");
    expect(flag()).toBe(false);
  });

  it("needs GA_SYNC as well as GA_FIXES", () => {
    setAll({ GA_FIXES: "true" });
    expect(gaFixesEnabled()).toBe(false);
    setAll({ GA_FIXES: "true", GA_SYNC: "true" });
    expect(gaFixesEnabled()).toBe(true);
    setAll({ GA_SYNC: "true" });
    expect(gaFixesEnabled()).toBe(false);
  });

  it("gates the alpha kinds on the kill switch and the others on GA_FIXES", () => {
    setAll({ GA_FIXES: "true", GA_SYNC: "true" });
    expect(gaFixAlphaEnabled()).toBe(false);
    expect(gaFixKindEnabled("KEY_EVENT_CREATE")).toBe(true);
    expect(gaFixKindEnabled("RETENTION_14M")).toBe(true);
    for (const kind of GA_FIX_ALPHA_KINDS) {
      expect(gaFixKindEnabled(kind)).toBe(false);
    }

    setAll({ GA_FIXES: "true", GA_SYNC: "true", GA_FIXES_ALPHA: "true" });
    expect(gaFixAlphaEnabled()).toBe(true);
    for (const kind of GA_FIX_ALPHA_KINDS) {
      expect(gaFixKindEnabled(kind)).toBe(true);
    }

    setAll({ GA_FIXES_ALPHA: "true" });
    expect(gaFixAlphaEnabled()).toBe(false);
    expect(gaFixKindEnabled("KEY_EVENT_CREATE")).toBe(false);
  });

  it("lists exactly the three v1alpha kinds", () => {
    expect([...GA_FIX_ALPHA_KINDS].sort()).toEqual([
      "ANNOTATION_CREATE",
      "CHANNEL_GROUP_AI",
      "ENHANCED_MEASUREMENT",
    ]);
  });

  it("chains automatic annotations on three flags and the publish note on four", () => {
    setAll({ GA_FIXES_ANNOTATIONS: "true", GA_FIXES_ANNOTATIONS_PUBLISH: "true" });
    expect(gaAutoAnnotationsEnabled()).toBe(false);

    setAll({
      GA_SYNC: "true",
      GA_FIXES: "true",
      GA_FIXES_ANNOTATIONS: "true",
    });
    expect(gaAutoAnnotationsEnabled()).toBe(false);

    setAll({
      GA_SYNC: "true",
      GA_FIXES: "true",
      GA_FIXES_ALPHA: "true",
      GA_FIXES_ANNOTATIONS: "true",
    });
    expect(gaAutoAnnotationsEnabled()).toBe(true);
    expect(gaPublishAnnotationsEnabled()).toBe(false);

    setAll({
      GA_SYNC: "true",
      GA_FIXES: "true",
      GA_FIXES_ALPHA: "true",
      GA_FIXES_ANNOTATIONS: "true",
      GA_FIXES_ANNOTATIONS_PUBLISH: "true",
    });
    expect(gaPublishAnnotationsEnabled()).toBe(true);

    setAll({
      GA_SYNC: "true",
      GA_FIXES: "true",
      GA_FIXES_ALPHA: "true",
      GA_FIXES_ANNOTATIONS_PUBLISH: "true",
    });
    expect(gaPublishAnnotationsEnabled()).toBe(false);
  });
});

describe("GA-F7 on a developer machine", () => {
  it("honours the shared dev guard", () => {
    setAll({ GA_FIXES: "true", GA_SYNC: "true" });
    const env = {
      NODE_ENV: "development",
      DATABASE_URL: LIVE,
      GA_SYNC_DEV_PROJECTS: "proj-a, proj-b",
    };
    expect(gaFixesEnabledFor("proj-a", env)).toBe(true);
    expect(gaFixesEnabledFor("proj-c", env)).toBe(false);
    expect(
      gaFixesEnabledFor("proj-c", { NODE_ENV: "production", DATABASE_URL: LIVE }),
    ).toBe(true);
  });

  it("is off for every project while the flags are off", () => {
    setAll({});
    expect(
      gaFixesEnabledFor("proj-a", { NODE_ENV: "production", DATABASE_URL: LIVE }),
    ).toBe(false);
  });

  it("lists the allowed project ids only on a shared remote database", () => {
    expect(
      gaSyncProjectAllowList({ NODE_ENV: "production", DATABASE_URL: LIVE }),
    ).toBeNull();
    expect(
      gaSyncProjectAllowList({ NODE_ENV: "development", DATABASE_URL: LOCAL }),
    ).toBeNull();
    expect(
      gaSyncProjectAllowList({
        NODE_ENV: "development",
        DATABASE_URL: LIVE,
        GA_SYNC_DEV_PROJECTS: " proj-a ,, proj-b ",
      }),
    ).toEqual(["proj-a", "proj-b"]);
    expect(
      gaSyncProjectAllowList({ NODE_ENV: "development", DATABASE_URL: LIVE }),
    ).toEqual([]);
  });
});

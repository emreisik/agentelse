import { describe, expect, it } from "vitest";

import {
  aspectOfDesignFormat,
  designForAspect,
  designFormatOfAspect,
  parseDesignProfile,
  withDesign,
} from "./design-profile";

describe("parseDesignProfile", () => {
  it("reads a design per format", () => {
    expect(
      parseDesignProfile({
        formats: { feed: "editorial", story: "statement" },
        source: "user",
      }),
    ).toEqual({
      formats: { feed: "editorial", story: "statement" },
      source: "user",
    });
  });

  it("reads the first shape (one design for all) as every format", () => {
    expect(parseDesignProfile({ archetype: "promo", source: "user" })).toEqual({
      formats: {
        feed: "promo",
        square: "promo",
        landscape: "promo",
        story: "promo",
      },
      source: "user",
    });
  });

  it("lets a format's own pick win over the old single one", () => {
    const profile = parseDesignProfile({
      archetype: "promo",
      formats: { story: "minimal-luxe" },
      source: "user",
    });
    expect(profile?.formats.story).toBe("minimal-luxe");
    expect(profile?.formats.feed).toBe("promo");
  });

  it("ignores anything else", () => {
    expect(parseDesignProfile(null)).toBeNull();
    expect(parseDesignProfile("promo")).toBeNull();
    expect(parseDesignProfile({ formats: {}, source: "user" })).toBeNull();
    expect(parseDesignProfile({ formats: { feed: "nope" }, source: "user" })).toBeNull();
    expect(parseDesignProfile({ archetype: "promo" })).toBeNull();
    expect(parseDesignProfile({ archetype: "promo", source: "auto" })).toBeNull();
  });
});

describe("formats and canvases", () => {
  it("map both ways", () => {
    expect(aspectOfDesignFormat("feed")).toBe("portrait");
    expect(aspectOfDesignFormat("story")).toBe("vertical");
    expect(designFormatOfAspect("landscape")).toBe("landscape");
    expect(designFormatOfAspect("square")).toBe("square");
  });
});

describe("designForAspect", () => {
  const profile = parseDesignProfile({
    formats: { feed: "editorial", story: "statement" },
    source: "user",
  });

  it("gives the pick of that format, null where the brand decides", () => {
    expect(designForAspect(profile, "portrait")).toBe("editorial");
    expect(designForAspect(profile, "vertical")).toBe("statement");
    expect(designForAspect(profile, "square")).toBeNull();
    expect(designForAspect(null, "square")).toBeNull();
  });
});

describe("withDesign", () => {
  it("sets one format and leaves the others", () => {
    const a = withDesign(null, "feed", "promo")!;
    const b = withDesign(a, "story", "statement")!;
    expect(b.formats).toEqual({ feed: "promo", story: "statement" });
  });

  it("sets every format at once", () => {
    const profile = withDesign(null, "all", "info")!;
    expect(Object.values(profile.formats)).toEqual(["info", "info", "info", "info"]);
  });

  it("takes one format back to automatic, and everything back with the last", () => {
    const both = withDesign(withDesign(null, "feed", "promo"), "story", "info");
    const noFeed = withDesign(both, "feed", null)!;
    expect(noFeed.formats).toEqual({ story: "info" });
    expect(withDesign(noFeed, "story", null)).toBeNull();
    expect(withDesign(both, "all", null)).toBeNull();
  });
});

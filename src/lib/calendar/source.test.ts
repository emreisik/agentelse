import { describe, expect, it } from "vitest";

import { sourceOf } from "./source";

describe("sourceOf", () => {
  it("sosyal kanallar gerçek marka simgesi alır", () => {
    for (const key of ["instagram", "tiktok", "linkedin", "x"] as const) {
      expect(sourceOf(key, null).brand).toBe(key);
    }
  });

  it("Blog/SEO ve Ads marka simgesi almaz, renkli rozet kullanır", () => {
    const seo = sourceOf("seo", null);
    expect(seo.brand).toBeNull();
    expect(seo.short).toBe("SEO");
    expect(sourceOf("ads", null).brand).toBeNull();
  });

  it("kanalı olmayan eski parça platformdan çözülür", () => {
    expect(sourceOf(null, "INSTAGRAM")).toMatchObject({
      key: "instagram",
      brand: "instagram",
      label: "Instagram",
    });
    expect(sourceOf(null, "FACEBOOK")).toMatchObject({
      key: "facebook",
      brand: "facebook",
      label: "Facebook",
    });
  });

  it("markasız platform (YouTube) rozetle gelir; hiçbir şey yoksa Other", () => {
    expect(sourceOf(null, "YOUTUBE")).toMatchObject({
      key: "youtube",
      brand: null,
      label: "YouTube",
    });
    expect(sourceOf(null, null).key).toBe("other");
  });

  it("kanal platformdan önceliklidir", () => {
    expect(sourceOf("linkedin", "INSTAGRAM").key).toBe("linkedin");
  });
});

import { describe, expect, it } from "vitest";

import {
  buildLineage,
  classifyHook,
  detectOffer,
  lengthBucket,
} from "./lineage";

describe("classifyHook", () => {
  it.each([
    ["Saçınız neden dökülüyor?", "question"],
    ["Why does your site load slowly?", "question"],
    ["Nasıl daha hızlı büyürsün: 3 adım", "how-to"],
    ["Son 3 gün: sepette ekstra fırsat", "urgency"],
    ["Limited seats, hurry", "urgency"],
    ["500+ müşteri bize güveniyor", "proof"],
    ["Rated 4.9 by our customers", "proof"],
    ["3 sebep, bugün başlamak için", "urgency"],
    ["7 yeni model geldi", "number"],
    ["Daha kolay muhasebe", "benefit"],
    ["Yeni koleksiyon burada", "statement"],
    ["", "statement"],
  ])("%s -> %s", (text, expected) => {
    expect(classifyHook(text)).toBe(expected);
  });

  it("looks at the first line only", () => {
    expect(classifyHook("Yeni koleksiyon burada\nSon 3 gün!")).toBe("statement");
  });
});

describe("detectOffer", () => {
  it.each([
    ["%20 indirim bu hafta", "discount"],
    ["Get 30% off today", "discount"],
    ["Ücretsiz kargo", "free"],
    ["Free consultation", "free"],
    ["Sadece 499 TL", "price"],
    ["Only $49", "price"],
    ["Yeni sezon geldi", "none"],
  ])("%s -> %s", (text, expected) => {
    expect(detectOffer(text)).toBe(expected);
  });
});

describe("lengthBucket", () => {
  it("buckets by words", () => {
    expect(lengthBucket("Kısa metin")).toBe("short");
    expect(lengthBucket("kelime ".repeat(20))).toBe("medium");
    expect(lengthBucket("kelime ".repeat(60))).toBe("long");
  });
});

describe("buildLineage", () => {
  const origins = {
    c1: { postId: "p1", ideaId: "i1", angle: "Behind the scenes", pillar: "Behind the Scenes", ideaSource: "brand" },
    c2: { postId: "p2", ideaId: "i1" },
    c3: { postId: "p3" },
  };

  it("carries the creatives, the distinct ideas, the angle and the tags", () => {
    const lineage = buildLineage({
      creativeIds: ["c1", "c2", "c3"],
      text: "Neden herkes bunu konuşuyor?",
      shape: "carousel",
      callToAction: "LEARN_MORE",
      origins,
    });
    expect(lineage.creativeIds).toEqual(["c1", "c2", "c3"]);
    expect(lineage.ideaIds).toEqual(["i1"]);
    expect(lineage.angle).toBe("Behind the scenes");
    expect(lineage.tags).toMatchObject({
      format: "carousel",
      hook: "question",
      offer: "none",
      cta: "learn_more",
      pillar: "behind-the-scenes",
      ideaSource: "brand",
    });
  });

  it("still tags an ad whose post has no idea behind it", () => {
    const lineage = buildLineage({
      creativeIds: ["unknown"],
      text: "%10 indirim",
      shape: "image",
      callToAction: "SHOP_NOW",
      origins,
    });
    expect(lineage.ideaIds).toEqual([]);
    expect(lineage.angle).toBeUndefined();
    expect(lineage.tags.offer).toBe("discount");
    expect(lineage.tags.pillar).toBeUndefined();
  });
});

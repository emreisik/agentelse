import { describe, expect, it } from "vitest";

import { creativeCards, imageSlots, slotKey, videoSlots } from "./launch-images";
import type { AdsLaunchSpec } from "./launch-spec";

type Ad = AdsLaunchSpec["ads"][number];

const base = {
  name: "Ad",
  adSetIndex: 0,
  urlTags: "utm_source=meta",
};
const single: Ad = {
  ...base,
  creative: { imageAssetId: "a1", message: "Hi", link: "https://x.test", callToAction: "LEARN_MORE" },
};
const carousel: Ad = {
  ...base,
  creative: {
    imageAssetId: "c1",
    message: "Hi",
    link: "https://x.test",
    callToAction: "LEARN_MORE",
    cards: [
      { imageAssetId: "c1", headline: "One", link: "https://x.test" },
      { imageAssetId: "c2", link: "https://x.test/2", description: "Two" },
      { imageAssetId: "c3", headline: "Three", link: "https://x.test" },
    ],
  },
};

describe("image slots", () => {
  it("keeps the first card on the ad's own key and numbers the rest", () => {
    expect(slotKey(2, null)).toBe("2");
    expect(slotKey(2, 0)).toBe("2");
    expect(slotKey(2, 3)).toBe("2:3");
    expect(imageSlots([single, carousel]).map((slot) => [slot.key, slot.assetId])).toEqual([
      ["0", "a1"],
      ["1", "c1"],
      ["1:1", "c2"],
      ["1:2", "c3"],
    ]);
  });
});

describe("creative cards", () => {
  it("is undefined for a single picture", () => {
    expect(creativeCards(single, 0, { "0": "h" })).toBeUndefined();
  });

  it("returns the uploaded hashes in order, with each card's own text and link", () => {
    expect(creativeCards(carousel, 1, { "1": "h1", "1:1": "h2", "1:2": "h3" })).toEqual([
      { imageHash: "h1", link: "https://x.test", headline: "One" },
      { imageHash: "h2", link: "https://x.test/2", description: "Two" },
      { imageHash: "h3", link: "https://x.test", headline: "Three" },
    ]);
  });

  it("is null while a card's picture isn't uploaded", () => {
    expect(creativeCards(carousel, 1, { "1": "h1", "1:2": "h3" })).toBeNull();
    expect(creativeCards(carousel, 1, undefined)).toBeNull();
  });
});

describe("video slots", () => {
  it("lists the video of each video ad by the ad's own key", () => {
    const video: Ad = {
      ...single,
      creative: { ...single.creative, video: { assetId: "vid1" } },
    };
    expect(videoSlots([single, video])).toEqual([{ key: "1", assetId: "vid1", adIndex: 1 }]);
    expect(videoSlots([single, carousel])).toEqual([]);
  });
});

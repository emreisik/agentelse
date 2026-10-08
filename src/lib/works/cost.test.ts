import { describe, expect, it } from "vitest";

import { estimateImageCostUsd } from "@/server/reasoning/reasoning-pricing";
import {
  IMAGE_PIECE_COST_USD,
  formatUsd,
  isImagePiece,
  pieceCostUsd,
  produceCostNote,
} from "./cost";

const post = { formatKey: "instagram.post" };
const story = { formatKey: "instagram.story" };

describe("produceCostNote", () => {
  it("is null for a text-only plan", () => {
    expect(produceCostNote([{ formatKey: "linkedin.post" }, { channel: "x" }])).toBeNull();
    expect(produceCostNote([])).toBeNull();
  });
  it("sums posts and stories", () => {
    expect(produceCostNote([post, post, post])).toBe("about $0.24");
    expect(produceCostNote([story, story, story])).toBe("about $0.32");
    expect(produceCostNote([post, story, { formatKey: "linkedin.post" }])).toBe(
      "about $0.18",
    );
  });
  it("counts an instagram piece without formatKey as a post", () => {
    expect(isImagePiece({ channel: "instagram" })).toBe(true);
    expect(pieceCostUsd({ channel: "instagram" })).toBe(IMAGE_PIECE_COST_USD.post);
  });
  it("prices an unknown formatKey at 0", () => {
    expect(pieceCostUsd({ formatKey: "nope.thing" })).toBe(0);
    expect(pieceCostUsd({ formatKey: "instagram.nope" })).toBe(0);
  });
});

describe("formatUsd", () => {
  it("always shows 2 decimals", () => {
    expect(formatUsd(0.2373)).toBe("$0.24");
    expect(formatUsd(1)).toBe("$1.00");
  });
});

describe("constants vs estimateImageCostUsd", () => {
  it("stay within 0.002 USD for the real Post and Story sizes", () => {
    const p = estimateImageCostUsd({ quality: "medium", size: "1080x1440" });
    const s = estimateImageCostUsd({ quality: "medium", size: "1080x1920" });
    expect(Math.abs(IMAGE_PIECE_COST_USD.post - p)).toBeLessThan(0.002);
    expect(Math.abs(IMAGE_PIECE_COST_USD.story - s)).toBeLessThan(0.002);
  });
});

describe("a post made from the brand's own photo", () => {
  it("costs nothing in pictures", () => {
    expect(pieceCostUsd({ ...post, photo: true })).toBe(0);
    expect(produceCostNote([{ ...post, photo: true }, { ...story, photo: true }])).toBeNull();
    expect(produceCostNote([{ ...post, photo: true }, post])).toBe("about $0.08");
  });
});

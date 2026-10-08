import { describe, expect, it } from "vitest";

import { fitLogoBox } from "./logo-fit";

const SQUARE = { width: 1080, height: 1080 };
const PORTRAIT = { width: 1080, height: 1350 };
const LANDSCAPE = { width: 1080, height: 566 };

describe("fitLogoBox", () => {
  it("keeps the logo's own proportions", () => {
    for (const aspect of [0.6, 1, 2.2, 4, 7]) {
      const box = fitLogoBox({ aspect, canvas: PORTRAIT, sizePercent: 16 });
      expect(Math.abs(box.width / box.height - aspect) / aspect).toBeLessThan(0.03);
    }
  });

  it("gives a wide wordmark more width and a square emblem less than the reference", () => {
    const wordmark = fitLogoBox({ aspect: 4, canvas: SQUARE, sizePercent: 16 });
    const reference = fitLogoBox({ aspect: 2.2, canvas: SQUARE, sizePercent: 16 });
    const emblem = fitLogoBox({ aspect: 1, canvas: SQUARE, sizePercent: 16 });
    expect(wordmark.width).toBeGreaterThan(reference.width);
    expect(emblem.width).toBeLessThan(reference.width);
  });

  it("never lets a logo get taller than 12% of the short side, or wider than a third", () => {
    for (const canvas of [SQUARE, PORTRAIT, LANDSCAPE]) {
      for (const aspect of [0.4, 1, 2.2, 4, 8]) {
        for (const sizePercent of [8, 16, 30]) {
          const box = fitLogoBox({ aspect, canvas, sizePercent });
          const short = Math.min(canvas.width, canvas.height);
          expect(box.height).toBeLessThanOrEqual(Math.ceil(short * 0.12) + 1);
          expect(box.width).toBeLessThanOrEqual(Math.ceil(canvas.width * 0.32) + 1);
        }
      }
    }
  });

  it("does not let a small request shrink the logo below a readable width", () => {
    const box = fitLogoBox({ aspect: 4, canvas: SQUARE, sizePercent: 8 });
    expect(box.width).toBeGreaterThanOrEqual(96);
  });

  it("stays proportionate on a landscape post", () => {
    const emblem = fitLogoBox({ aspect: 1, canvas: LANDSCAPE, sizePercent: 16 });
    // A square emblem was 31% of a landscape post's height with a plain percent.
    expect(emblem.height / LANDSCAPE.height).toBeLessThanOrEqual(0.15);
  });

  it("falls back to a square for a nonsense aspect", () => {
    const box = fitLogoBox({ aspect: Number.NaN, canvas: SQUARE, sizePercent: 16 });
    expect(box.width).toBe(box.height);
  });
});

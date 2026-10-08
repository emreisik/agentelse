import { describe, expect, it } from "vitest";

import { fitMode, keptShare, planCoverCrop } from "./photo-crop";

const FEED = { width: 1080, height: 1440 };
const SQUARE = { width: 1080, height: 1080 };
const LANDSCAPE = { width: 1080, height: 566 };
const STORY = { width: 1080, height: 1920 };

describe("keptShare and fitMode", () => {
  it("keeps most of a photo that is near the canvas's shape", () => {
    expect(keptShare({ width: 4000, height: 3000 }, SQUARE)).toBeCloseTo(0.75, 2);
    expect(fitMode({ width: 4000, height: 3000 }, SQUARE)).toBe("cover");
    expect(fitMode({ width: 3000, height: 4000 }, FEED)).toBe("cover");
  });

  it("shows the whole photo when a crop would throw most of it away", () => {
    // A landscape photo on a Story keeps about 40%.
    expect(keptShare({ width: 4000, height: 3000 }, STORY)).toBeLessThan(0.5);
    expect(fitMode({ width: 4000, height: 3000 }, STORY)).toBe("extend");
    // A tall photo on a landscape post.
    expect(fitMode({ width: 3000, height: 4000 }, LANDSCAPE)).toBe("extend");
  });

  it("is symmetric: the same loss whichever way the photo is off", () => {
    expect(keptShare({ width: 2000, height: 1000 }, SQUARE)).toBeCloseTo(
      keptShare({ width: 1000, height: 2000 }, SQUARE),
      6,
    );
  });
});

describe("planCoverCrop", () => {
  const wide = { width: 4000, height: 3000 };
  const tall = { width: 3000, height: 4000 };

  it("always gives a window of the canvas's shape, inside the photo", () => {
    for (const photo of [wide, tall, { width: 3000, height: 3000 }]) {
      for (const canvas of [FEED, SQUARE, LANDSCAPE, STORY]) {
        const crop = planCoverCrop({ photo, canvas, focal: { x: 0.9, y: 0.1 } });
        expect(crop.left).toBeGreaterThanOrEqual(0);
        expect(crop.top).toBeGreaterThanOrEqual(0);
        expect(crop.left + crop.width).toBeLessThanOrEqual(photo.width);
        expect(crop.top + crop.height).toBeLessThanOrEqual(photo.height);
        expect(Math.abs(crop.width / crop.height - canvas.width / canvas.height)).toBeLessThan(0.01);
      }
    }
  });

  it("centres on the subject when there is room", () => {
    // A wide photo into a square: the window slides sideways to the subject.
    const crop = planCoverCrop({ photo: wide, canvas: SQUARE, focal: { x: 0.7, y: 0.5 } });
    expect(crop.width).toBe(3000);
    const centre = (crop.left + crop.width / 2) / wide.width;
    expect(centre).toBeGreaterThan(0.6);
    expect(crop.left + crop.width).toBeLessThanOrEqual(wide.width);
  });

  it("keeps the subject inside the window even at the photo's edge", () => {
    const crop = planCoverCrop({ photo: wide, canvas: SQUARE, focal: { x: 0.02, y: 0.5 } });
    expect(crop.left).toBe(0);
    expect(0.02 * wide.width).toBeLessThan(crop.width);
  });

  it("pushes the subject down when the headline goes on top, up when it goes below", () => {
    // A tall photo into a square has vertical room to slide.
    const focal = { x: 0.5, y: 0.5 };
    const subjectAt = (zone: "TOP" | "BOTTOM") => {
      const crop = planCoverCrop({ photo: tall, canvas: SQUARE, focal, avoidZone: zone });
      return (focal.y * tall.height - crop.top) / crop.height;
    };
    expect(subjectAt("TOP")).toBeGreaterThan(0.55);
    expect(subjectAt("BOTTOM")).toBeLessThan(0.45);
  });

  it("pushes the subject right when the headline is a left column", () => {
    const crop = planCoverCrop({
      photo: wide,
      canvas: SQUARE,
      focal: { x: 0.5, y: 0.5 },
      avoidZone: "LEFT_COLUMN",
    });
    expect((0.5 * wide.width - crop.left) / crop.width).toBeGreaterThan(0.6);
  });

  it("falls back to the centre without a subject", () => {
    const crop = planCoverCrop({ photo: wide, canvas: SQUARE });
    expect(crop.left).toBe(500);
    expect(crop.top).toBe(0);
  });
});

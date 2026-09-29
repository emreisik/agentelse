import { describe, expect, it } from "vitest";

import { imageProgress, previewBlurPx } from "./image-progress";

const base = { startedAt: 1_000, partials: 0, done: false };

describe("imageProgress", () => {
  it("starts low and creeps up but stays below the next milestone", () => {
    const start = imageProgress(base, 1_000).pct;
    const later = imageProgress(base, 1_000 + 20_000).pct;
    expect(start).toBeLessThan(10);
    expect(later).toBeGreaterThan(start);
    expect(later).toBeLessThan(45);
  });

  it("jumps to a higher band with each streamed preview", () => {
    const at = 1_000 + 5_000;
    const p0 = imageProgress(base, at).pct;
    const p1 = imageProgress({ ...base, partials: 1 }, at).pct;
    const p2 = imageProgress({ ...base, partials: 2 }, at).pct;
    expect(p1).toBeGreaterThan(p0);
    expect(p2).toBeGreaterThan(p1);
    expect(p2).toBeLessThan(100);
  });

  it("only reaches 100% when the render is actually done", () => {
    expect(imageProgress({ ...base, partials: 2 }, 1_000 + 10 * 60_000).pct).toBeLessThan(100);
    expect(imageProgress({ ...base, done: true }, 1_000)).toEqual({
      pct: 100,
      label: "Done",
    });
  });

  it("never moves backwards", () => {
    expect(imageProgress(base, 1_000, 60).pct).toBe(60);
  });

  it("names the stage", () => {
    expect(imageProgress(base, 2_000).label).toBe("Preparing the scene");
    expect(imageProgress({ ...base, partials: 1 }, 2_000).label).toBe("Shaping the image");
    expect(imageProgress({ ...base, partials: 2 }, 2_000).label).toBe("Refining details");
  });
});

describe("previewBlurPx", () => {
  it("is heavy at 0%, sharper as it progresses, none at 100%", () => {
    expect(previewBlurPx(0)).toBe(28);
    expect(previewBlurPx(50)).toBeLessThan(previewBlurPx(20));
    expect(previewBlurPx(100)).toBe(0);
  });
});

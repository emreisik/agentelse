import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const { keepLivePhotoIds } = await import("./content-plan");

describe("keepLivePhotoIds", () => {
  const live = new Set(["a", "b"]);

  it("keeps live photos and drops unknown ones", () => {
    const [item] = keepLivePhotoIds([{ topic: "x", photoAssetIds: ["a", "zzz"] }], live);
    expect(item?.photoAssetIds).toEqual(["a"]);
  });

  it("gives a photo to one post of the plan only", () => {
    const items = keepLivePhotoIds(
      [
        { topic: "1", photoAssetIds: ["a"] },
        { topic: "2", photoAssetIds: ["a"] },
        { topic: "3", photoAssetIds: ["b"] },
      ],
      live,
    );
    expect(items.map((item) => item.photoAssetIds)).toEqual([["a"], undefined, ["b"]]);
  });

  it("leaves items without photos alone", () => {
    const item = { topic: "plain" };
    expect(keepLivePhotoIds([item], live)[0]).toBe(item);
  });
});

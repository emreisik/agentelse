import { describe, expect, it } from "vitest";

import { mergeCardAlternatives, swapCurrentPicture } from "./variant-card";

const ids = (list: { assetId: string }[]) => list.map((a) => a.assetId);

describe("swapCurrentPicture", () => {
  it("puts the displaced picture where the adopted one was", () => {
    const out = swapCurrentPicture(
      {
        assetId: "a0",
        assetWidth: 1080,
        assetHeight: 1350,
        alternatives: [{ assetId: "a1" }, { assetId: "a2" }],
      },
      "a1",
    );
    expect(ids(out)).toEqual(["a0", "a2"]);
    expect(out[0]).toMatchObject({ assetWidth: 1080, assetHeight: 1350 });
  });

  it("is a no-op shape-wise when the card already shows the adopted picture", () => {
    const out = swapCurrentPicture(
      { assetId: "a1", alternatives: [{ assetId: "a1" }, { assetId: "a2" }] },
      "a1",
    );
    expect(ids(out)).toEqual(["a2"]);
  });

  it("appends the displaced picture when the adopted one was not listed", () => {
    const out = swapCurrentPicture(
      { assetId: "a0", alternatives: [{ assetId: "a2" }] },
      "a1",
      "a0",
    );
    expect(ids(out)).toEqual(["a2", "a0"]);
  });

  it("going back to the first picture restores the original set", () => {
    const first = swapCurrentPicture(
      { assetId: "a0", alternatives: [{ assetId: "a1" }, { assetId: "a2" }] },
      "a1",
    );
    const back = swapCurrentPicture(
      { assetId: "a1", alternatives: first },
      "a0",
    );
    expect(ids(back)).toEqual(["a1", "a2"]);
  });
});

describe("mergeCardAlternatives", () => {
  it("keeps the card's own list first and drops the current picture and repeats", () => {
    const out = mergeCardAlternatives(
      { assetId: "a1", alternatives: [{ assetId: "a0" }, { assetId: "a2" }] },
      [{ assetId: "a1" }, { assetId: "a2" }, { assetId: "a3" }],
    );
    expect(ids(out)).toEqual(["a0", "a2", "a3"]);
  });

  it("uses the stored list when the card has none", () => {
    expect(
      ids(mergeCardAlternatives({ assetId: "a0" }, [{ assetId: "a1" }])),
    ).toEqual(["a1"]);
  });
});

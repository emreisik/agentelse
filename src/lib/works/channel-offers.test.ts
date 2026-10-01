import { describe, expect, it } from "vitest";

import { channelOffers, type OfferWork } from "./channel-offers";

const work = (id: string, channels: OfferWork["channels"], status = "ACTIVE"): OfferWork => ({
  id,
  title: `T ${id}`,
  channels,
  status,
});

describe("channelOffers", () => {
  it("returns a back link (newest wins) for a connected channel an ACTIVE Work covers", () => {
    const r = channelOffers({ instagram: { connected: true } }, [
      work("new", ["instagram"]),
      work("old", ["instagram"]),
    ]);
    expect(r.back).toEqual([{ channel: "instagram", workId: "new", title: "T new" }]);
    expect(r.open).toEqual([]);
  });

  it("offers to open a Work when only DONE, ARCHIVED or Today Works cover it", () => {
    const r = channelOffers({ instagram: { connected: true } }, [
      work("a", ["instagram"], "DONE"),
      work("b", ["instagram"], "ARCHIVED"),
      work("today_2026-10-01", ["instagram"]),
    ]);
    expect(r.back).toEqual([]);
    expect(r.open).toEqual(["instagram"]);
  });

  it("ignores channels that are not connected and never offers seo", () => {
    const r = channelOffers({ instagram: { connected: false }, seo: { connected: true } }, [
      work("a", ["instagram", "seo"]),
    ]);
    expect(r).toEqual({ open: [], back: [] });
  });

  it("orders results by CHANNEL_KEYS", () => {
    const r = channelOffers(
      { x: { connected: true }, instagram: { connected: true }, tiktok: { connected: true } },
      [work("w", ["x", "instagram"])],
    );
    expect(r.back.map((b) => b.channel)).toEqual(["instagram", "x"]);
    expect(r.open).toEqual(["tiktok"]);
  });
});

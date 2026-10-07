import { describe, expect, it } from "vitest";

import { googleAdsRowsOf, googleAdsViewRows, roasOf } from "./google-ads";
import type { GoogleAdsCampaignRow } from "./types";

// GA4 Google Ads raporu: satır ayrıştırma, ROAS ve önceki dönem eşlemesi.

function ads(
  campaign: string,
  cost: number,
  keyEvents: number,
  revenue: number,
): GoogleAdsCampaignRow {
  return { campaign, cost, clicks: 100, sessions: 80, keyEvents, revenue };
}

describe("googleAdsRowsOf", () => {
  it("maps the catalog order cost, clicks, sessions, key events, revenue", () => {
    expect(
      googleAdsRowsOf([{ key: ["Brand"], values: [12.5, 40, 35, 3, 150] }]),
    ).toEqual([
      { campaign: "Brand", cost: 12.5, clicks: 40, sessions: 35, keyEvents: 3, revenue: 150 },
    ]);
  });
});

describe("roasOf", () => {
  it("is null without cost", () => {
    expect(roasOf(100, 0)).toBeNull();
    expect(roasOf(100, 50)).toBe(2);
    expect(roasOf(0, 50)).toBe(0);
  });
});

describe("googleAdsViewRows", () => {
  it("matches the previous period by campaign name", () => {
    const rows = googleAdsViewRows(
      [ads("Brand", 100, 10, 300), ads("New", 50, 5, 0)],
      [ads("Brand", 80, 4, 80)],
    );
    expect(rows[0]).toMatchObject({
      campaign: "Brand",
      roas: 3,
      costPerKeyEvent: 10,
      previousRoas: 1,
      previousCostPerKeyEvent: 20,
    });
    expect(rows[1]).toMatchObject({
      campaign: "New",
      roas: 0,
      costPerKeyEvent: 10,
      previousRoas: null,
      previousCostPerKeyEvent: null,
    });
  });

  it("masks personal data in campaign names and merges rows that collapse", () => {
    const rows = googleAdsViewRows(
      [
        ads("Promo ayse@example.com", 100, 10, 300),
        ads("Promo mehmet@example.com", 50, 5, 100),
        ads("   ", 40, 1, 0),
      ],
      [ads("Promo ali@example.com", 80, 4, 80)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      campaign: "Promo [email]",
      cost: 150,
      keyEvents: 15,
      previousRoas: 1,
    });
    expect(JSON.stringify(rows)).not.toContain("@example.com");
  });

  it("gives no cost per key event without key events or cost", () => {
    const rows = googleAdsViewRows(
      [ads("A", 100, 0, 0), ads("B", 0, 5, 10)],
      [],
    );
    expect(rows.find((row) => row.campaign === "A")?.costPerKeyEvent).toBeNull();
    expect(rows.find((row) => row.campaign === "B")?.costPerKeyEvent).toBeNull();
    expect(rows.find((row) => row.campaign === "B")?.roas).toBeNull();
  });

  it("sorts by cost desc and honours the limit", () => {
    const current = Array.from({ length: 15 }, (_, index) =>
      ads(`C${index}`, index + 1, 1, 1),
    );
    const rows = googleAdsViewRows(current, []);
    expect(rows).toHaveLength(10);
    expect(rows[0]?.campaign).toBe("C14");
    expect(googleAdsViewRows(current, [], 3)).toHaveLength(3);
  });
});

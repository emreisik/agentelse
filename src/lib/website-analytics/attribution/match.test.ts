import { describe, expect, it } from "vitest";

import type { TrackedLinkRef } from "@/lib/tracked-links/types";

import {
  attributeCampaignRows,
  campaignRowsOf,
  engagementPct,
  fromAgentelseRows,
  legacyAdCandidates,
} from "./match";
import type { CampaignSliceRow } from "./types";

// Atıf eşleştirmesi: agx kodu → eski Meta reklam kimliği → agx kampanyası →
// "Other tagged links"; agx olmayan satırlar yok sayılır.

function link(overrides: Partial<TrackedLinkRef> & { code: string }): TrackedLinkRef {
  return {
    id: `link_${overrides.code}`,
    entityType: "meta_ad",
    entityId: `cmd:${overrides.code}`,
    channel: "meta_ads",
    utmSource: "facebook",
    utmMedium: "paid_social",
    utmCampaign: "agx-spring",
    utmContent: `agx_${overrides.code}`,
    label: "Spring sale",
    campaignExternalId: "camp1",
    adExternalId: `ad_${overrides.code}`,
    carriesCode: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function row(
  overrides: Partial<CampaignSliceRow> & { content: string },
): CampaignSliceRow {
  return {
    campaign: "agx-spring",
    source: "facebook",
    medium: "paid_social",
    sessions: 10,
    engagedSessions: 6,
    keyEvents: 1,
    revenue: 5,
    ...overrides,
  };
}

describe("campaignRowsOf", () => {
  it("maps dimensions and metrics in catalog order", () => {
    expect(
      campaignRowsOf([
        {
          key: ["agx-spring", "facebook", "paid_social", "agx_abc123"],
          values: [10, 6, 2, 12.5],
        },
      ]),
    ).toEqual([
      {
        campaign: "agx-spring",
        source: "facebook",
        medium: "paid_social",
        content: "agx_abc123",
        sessions: 10,
        engagedSessions: 6,
        keyEvents: 2,
        revenue: 12.5,
      },
    ]);
  });
});

describe("attributeCampaignRows", () => {
  const a = link({ code: "aaaaaa" });
  const b = link({ code: "bbbbbb" });

  it("maps a content code to its link even when the user's own campaign was kept", () => {
    const result = attributeCampaignRows(
      [row({ content: "agx_aaaaaa", campaign: "my own campaign" })],
      [a],
    );
    expect(result.byLink[a.id]?.sessions).toBe(10);
    expect(result.groups[0]?.key).toBe("meta:camp1");
    expect(result.matchedRows).toBe(1);
  });

  it("groups two Meta ads of one campaign and keeps both links", () => {
    const result = attributeCampaignRows(
      [
        row({ content: "agx_aaaaaa", sessions: 10 }),
        row({ content: "agx_bbbbbb", sessions: 20 }),
      ],
      [a, b],
    );
    expect(result.groups).toHaveLength(1);
    const group = result.groups[0]!;
    expect(group.key).toBe("meta:camp1");
    expect(group.linkIds).toEqual([a.id, b.id]);
    expect(group.adExternalIds).toEqual(["ad_aaaaaa", "ad_bbbbbb"]);
    expect(group.metrics.sessions).toBe(30);
    expect(result.byLink[a.id]?.sessions).toBe(10);
    expect(result.byLink[b.id]?.sessions).toBe(20);
    expect(result.byCampaign.camp1?.sessions).toBe(30);
  });

  it("keys an unresolved Meta campaign by its utm campaign", () => {
    const unresolved = link({
      code: "cccccc",
      campaignExternalId: null,
      adExternalId: null,
    });
    const result = attributeCampaignRows([], [unresolved]);
    expect(result.groups[0]?.key).toBe("meta:c:agx-spring");
    expect(result.groups[0]?.campaignExternalId).toBeNull();
    expect(result.byCampaign).toEqual({});
  });

  it("counts adMetrics only for code- and legacy-matched rows of listed ads", () => {
    const result = attributeCampaignRows(
      [
        row({ content: "agx_aaaaaa", sessions: 10 }),
        // Yalnız kampanya eşleşmesi: grup toplamına girer, adMetrics'e girmez.
        row({ content: "(not set)", sessions: 7 }),
        row({ content: "900000001", source: "meta", campaign: "x", sessions: 4 }),
      ],
      [a],
      [{ adExternalId: "900000001", campaignExternalId: "camp1", label: "Old" }],
    );
    const group = result.groups[0]!;
    expect(group.metrics.sessions).toBe(21);
    expect(group.adMetrics.sessions).toBe(14);
    expect(group.adExternalIds).toEqual(["ad_aaaaaa", "900000001"]);
  });

  it("credits a campaign-only row to the group metrics but not adMetrics or the link", () => {
    const result = attributeCampaignRows(
      [row({ content: "(not set)", sessions: 9 })],
      [a],
    );
    expect(result.groups[0]?.metrics.sessions).toBe(9);
    expect(result.groups[0]?.adMetrics.sessions).toBe(0);
    expect(result.byLink[a.id]?.sessions).toBe(0);
  });

  it("sends an agx campaign shared by two groups to unknownAgx", () => {
    const other = link({
      code: "dddddd",
      campaignExternalId: "camp2",
      adExternalId: "ad_dddddd",
    });
    const result = attributeCampaignRows(
      [row({ content: "(not set)", sessions: 8 })],
      [a, other],
    );
    expect(result.unknownAgx.sessions).toBe(8);
    expect(result.groups.every((group) => group.metrics.sessions === 0)).toBe(
      true,
    );
  });

  it("sends an unknown code to unknownAgx", () => {
    const result = attributeCampaignRows(
      [row({ content: "agx_zzzzzz", campaign: "agx-other", sessions: 3 })],
      [a],
    );
    expect(result.unknownAgx.sessions).toBe(3);
    expect(result.matchedRows).toBe(0);
  });

  it("ignores a non-agx campaign without a code", () => {
    const result = attributeCampaignRows(
      [row({ content: "banner", campaign: "summer", sessions: 50 })],
      [a],
    );
    expect(result.total.sessions).toBe(0);
    expect(result.unknownAgx.sessions).toBe(0);
  });

  it("creates a legacy-only group from a numeric ad id with a Meta-like source", () => {
    const result = attributeCampaignRows(
      [row({ content: "900000002", source: "meta", campaign: "{{campaign.name}}" })],
      [],
      [{ adExternalId: "900000002", campaignExternalId: "camp9", label: "Old ads" }],
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      key: "meta:camp9",
      kind: "meta_campaign",
      entityType: "meta_ad",
      channel: "meta_ads",
      linkIds: [],
      adExternalIds: ["900000002"],
      label: "Old ads",
      campaignExternalId: "camp9",
    });
    expect(result.byCampaign.camp9?.sessions).toBe(10);
  });

  it("ignores a legacy ad id seen from a non-Meta source", () => {
    const result = attributeCampaignRows(
      [row({ content: "900000002", source: "google", campaign: "x" })],
      [],
      [{ adExternalId: "900000002", campaignExternalId: "camp9", label: "Old ads" }],
    );
    expect(result.groups).toEqual([]);
    expect(result.total.sessions).toBe(0);
  });

  it("keeps a link that does not carry the code out of adExternalIds", () => {
    const silent = link({ code: "eeeeee", carriesCode: false });
    const result = attributeCampaignRows(
      [row({ content: "agx_eeeeee", sessions: 5 })],
      [silent],
    );
    const group = result.groups[0]!;
    expect(group.adExternalIds).toEqual([]);
    expect(group.metrics.sessions).toBe(5);
    expect(group.adMetrics.sessions).toBe(0);
  });

  it("labels the bio link group and credits an agx campaign row to it", () => {
    const bio = link({
      code: "ffffff",
      entityType: "instagram_bio",
      entityId: "bio",
      channel: "instagram",
      utmCampaign: "agx-bio",
      campaignExternalId: null,
      adExternalId: null,
      label: null,
    });
    const result = attributeCampaignRows(
      [
        row({ content: "agx_ffffff", campaign: "agx-bio", sessions: 4 }),
        row({ content: "(not set)", campaign: "AGX-Bio", sessions: 2 }),
      ],
      [bio],
    );
    const group = result.groups[0]!;
    expect(group.key).toBe(`link:${bio.id}`);
    expect(group.kind).toBe("link");
    expect(group.label).toBe("Instagram bio link");
    expect(group.metrics.sessions).toBe(6);
    expect(result.byLink[bio.id]?.sessions).toBe(4);
  });

  it("sorts groups by sessions then key and sums the total", () => {
    const bio = link({
      code: "ffffff",
      entityType: "instagram_bio",
      entityId: "bio",
      channel: "instagram",
      utmCampaign: "agx-bio",
      campaignExternalId: null,
      adExternalId: null,
    });
    const result = attributeCampaignRows(
      [
        row({ content: "agx_aaaaaa", sessions: 10 }),
        row({ content: "agx_ffffff", campaign: "agx-bio", sessions: 30 }),
        row({ content: "agx_zzzzzz", campaign: "agx-gone", sessions: 5 }),
      ],
      [a, bio],
    );
    expect(result.groups.map((group) => group.key)).toEqual([
      `link:${bio.id}`,
      "meta:camp1",
    ]);
    expect(result.total.sessions).toBe(45);
    expect(result.unknownAgx.sessions).toBe(5);
  });
});

describe("fromAgentelseRows", () => {
  it("puts overflow groups and unknown agx rows into other", () => {
    const links = ["aaaaaa", "bbbbbb", "cccccc"].map((code, index) =>
      link({
        code,
        campaignExternalId: `camp${index}`,
        adExternalId: `ad_${code}`,
        utmCampaign: `agx-c${index}`,
      }),
    );
    const result = attributeCampaignRows(
      [
        row({ content: "agx_aaaaaa", campaign: "agx-c0", sessions: 30 }),
        row({ content: "agx_bbbbbb", campaign: "agx-c1", sessions: 20 }),
        row({ content: "agx_cccccc", campaign: "agx-c2", sessions: 10 }),
        row({ content: "agx_zzzzzz", campaign: "agx-x", sessions: 5 }),
      ],
      links,
    );
    const view = fromAgentelseRows(result, 2);
    expect(view.rows.map((r) => r.sessions)).toEqual([30, 20]);
    expect(view.rows[0]?.kindLabel).toBe("Meta ads");
    expect(view.other?.sessions).toBe(15);
    expect(view.other?.engagementRate).toBe(80);
  });

  it("returns a null other when everything fits", () => {
    const a = link({ code: "aaaaaa" });
    const result = attributeCampaignRows(
      [row({ content: "agx_aaaaaa" })],
      [a],
    );
    expect(fromAgentelseRows(result).other).toBeNull();
  });
});

describe("engagementPct", () => {
  it("rounds to one decimal and is null without sessions", () => {
    expect(
      engagementPct({ sessions: 3, engagedSessions: 1, keyEvents: 0, revenue: 0 }),
    ).toBe(33.3);
    expect(
      engagementPct({ sessions: 0, engagedSessions: 0, keyEvents: 0, revenue: 0 }),
    ).toBeNull();
  });
});

describe("legacyAdCandidates", () => {
  it("keeps unique numeric contents from Meta-like sources only", () => {
    expect(
      legacyAdCandidates([
        row({ content: "120000001", source: "meta" }),
        row({ content: "120000001", source: "Facebook" }),
        row({ content: "120000002", source: "google" }),
        row({ content: "12345", source: "meta" }),
        row({ content: "agx_aaaaaa", source: "meta" }),
      ]),
    ).toEqual(["120000001"]);
  });

  it("caps the list at 500", () => {
    const many = Array.from({ length: 600 }, (_, index) =>
      row({ content: String(100000 + index), source: "meta" }),
    );
    expect(legacyAdCandidates(many)).toHaveLength(500);
  });
});

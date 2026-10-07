import { describe, expect, it } from "vitest";

import { launchSpecFromFlow } from "@/lib/module-flows/ads/launch";
import type { AdsBrief } from "@/lib/module-flows/ads/state";

import {
  TRACKING_ADDED_NOTE,
  hasAgentelseTracking,
  metaAdTaggable,
  metaAdUrlTags,
  withTrackingNote,
} from "./ads";

const link = "https://acme.test/spring";
const brief: AdsBrief = {
  objective: "OUTCOME_ENGAGEMENT",
  dailyBudget: 20,
  days: 7,
  countries: ["TR"],
  ageMin: 18,
  ageMax: 65,
  gender: "all",
  link,
  callToAction: "LEARN_MORE",
  source: { creativeId: "c1", assetId: "a1", title: "Spring" },
  extraSources: [
    { creativeId: "c2", assetId: "a2", title: "Summer" },
    { creativeId: "c3", assetId: "a3", title: "Autumn" },
  ],
  currency: "TRY",
  dsaBeneficiary: "Acme",
  dsaPayor: "Acme Ltd",
};
const plan = {
  campaignName: "Spring Sale",
  adSetName: "TR",
  adName: "Ad",
  primaryText: "Hello",
};
const context = {
  adAccountId: "act_1",
  currency: "TRY",
  timezone: "Europe/Istanbul",
  pageId: "9",
  minCampaignSpendCapMinor: null,
  dsaBeneficiary: null,
  dsaPayor: null,
};

const campaign = "agx-spring-sale";
const codes = ["abc123", "def456", "ghi789"];
const domains = ["acme.test"];

describe("metaAdUrlTags", () => {
  it("puts the agx template on every ad of a launch spec", () => {
    const spec = launchSpecFromFlow({ brief, plan, context, activate: true });
    expect(spec.ads).toHaveLength(3);
    const tagged = spec.ads.map((ad, index) => ({
      ...ad,
      urlTags: metaAdUrlTags({ link, campaign, code: codes[index]! }),
    }));

    for (const [index, ad] of tagged.entries()) {
      expect(ad.urlTags).toContain("utm_source=facebook");
      expect(ad.urlTags).toContain("utm_medium=paid_social");
      expect(ad.urlTags).toContain(`utm_campaign=${campaign}`);
      expect(ad.urlTags).toContain(`utm_content=agx_${codes[index]}`);
      expect(ad.urlTags).toContain("utm_term={{site_source_name}}");
    }
    expect(new Set(tagged.map((ad) => ad.urlTags)).size).toBe(3);
    expect(hasAgentelseTracking({ ads: tagged })).toBe(true);
    // Etiketsiz spec bugünkü DEFAULT_URL_TAGS ile kalır: iz yok.
    expect(hasAgentelseTracking(spec)).toBe(false);
  });

  it("leaves out keys the link already carries", () => {
    const tags = metaAdUrlTags({
      link: "https://acme.test/?utm_campaign=spring",
      campaign,
      code: "abc123",
    });
    expect(tags).not.toContain("utm_campaign");
    expect(tags).toContain("utm_content=agx_abc123");
  });
});

describe("metaAdTaggable", () => {
  it("is true for a link on the own site or its subdomain", () => {
    expect(metaAdTaggable({ link, domains })).toBe(true);
    expect(metaAdTaggable({ link: "https://shop.acme.test/x", domains })).toBe(true);
  });

  it("is false for messaging ads, empty and foreign links", () => {
    expect(metaAdTaggable({ link, messages: { app: "WHATSAPP" }, domains })).toBe(false);
    expect(metaAdTaggable({ link: "", domains })).toBe(false);
    expect(metaAdTaggable({ link: null, domains })).toBe(false);
    expect(metaAdTaggable({ link: "https://other.example/", domains })).toBe(false);
    expect(metaAdTaggable({ link, domains: [] })).toBe(false);
  });

  it("is false when the link already has utm_content (any case)", () => {
    expect(metaAdTaggable({ link: `${link}?utm_content=x`, domains })).toBe(false);
    expect(metaAdTaggable({ link: `${link}?UTM_Content=x`, domains })).toBe(false);
  });

  it("stays true when only other utm keys exist", () => {
    expect(metaAdTaggable({ link: `${link}?utm_campaign=spring`, domains })).toBe(true);
  });
});

describe("withTrackingNote", () => {
  const check = { notes: ["Existing note"] };

  it("returns the same object when no ad carries a code", () => {
    const spec = { ads: [{ urlTags: "utm_source=meta&utm_content={{ad.id}}" }] };
    expect(withTrackingNote(check, spec)).toBe(check);
  });

  it("appends the note once when an ad carries a code", () => {
    const spec = { ads: [{ urlTags: "utm_content=agx_abc123" }] };
    const noted = withTrackingNote(check, spec);
    expect(noted).not.toBe(check);
    expect(noted.notes).toEqual(["Existing note", TRACKING_ADDED_NOTE]);
    expect(check.notes).toEqual(["Existing note"]);
    expect(withTrackingNote(noted, spec).notes).toEqual(noted.notes);
  });
});

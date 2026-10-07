import { describe, expect, it } from "vitest";

import {
  agxCampaignName,
  agxContent,
  isAgxCampaign,
  isOwnSiteUrl,
  mergeUtm,
  parseAgxCode,
  parseUtm,
  siteDomainsOf,
  stripUtm,
  tagOutboundUrl,
  urlTagsFor,
  utmFor,
} from "./utm";

// Bu dosyanın kanıtladığı: etiketler yalnız projenin kendi sitesine giden
// http(s) linklere, var olan utm_* değerleri ezilmeden ve diğer parametrelerin
// ham metni bozulmadan eklenir; Meta makrosu kodlanmaz.

const meta = (campaign = "agx-spring") =>
  utmFor({ channel: "meta_ads", campaign, code: "ab12cd" });

describe("utmFor", () => {
  it("adds utm_term only for meta_ads", () => {
    expect(meta()).toEqual({
      utm_source: "facebook",
      utm_medium: "paid_social",
      utm_campaign: "agx-spring",
      utm_content: "agx_ab12cd",
      utm_term: "{{site_source_name}}",
    });
    const bio = utmFor({
      channel: "instagram",
      campaign: "agx-bio",
      code: "ab12cd",
    });
    expect(bio).toEqual({
      utm_source: "instagram",
      utm_medium: "social",
      utm_campaign: "agx-bio",
      utm_content: "agx_ab12cd",
    });
    expect(
      utmFor({ channel: "linkedin", campaign: "agx-x", code: "ab12cd" })
        .utm_term,
    ).toBeUndefined();
  });
});

describe("mergeUtm", () => {
  it("adds the four utm keys plus utm_term for meta_ads to an own-domain link", () => {
    const merged = mergeUtm("https://acme.test/", meta());
    expect(merged.added).toEqual([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
    ]);
    expect(merged.url).toBe(
      "https://acme.test/?utm_source=facebook&utm_medium=paid_social&utm_campaign=agx-spring&utm_term={{site_source_name}}&utm_content=agx_ab12cd",
    );
  });

  it("keeps an existing utm_campaign and mixed-case keys without duplicating", () => {
    const merged = mergeUtm(
      "https://acme.test/p?UTM_Source=newsletter&utm_campaign=Spring",
      meta(),
    );
    expect(merged.kept).toEqual(["utm_source", "utm_campaign"]);
    expect(merged.added).toEqual(["utm_medium", "utm_term", "utm_content"]);
    expect(merged.url.match(/utm_campaign=/gi)).toHaveLength(1);
    expect(
      merged.url.startsWith(
        "https://acme.test/p?UTM_Source=newsletter&utm_campaign=Spring&",
      ),
    ).toBe(true);
  });

  it("keeps other params raw and in order, and keeps the fragment", () => {
    const merged = mergeUtm(
      "https://acme.test/p?a=1%202&b=x+y#top",
      utmFor({ channel: "instagram", campaign: "agx-bio", code: "ab12cd" }),
    );
    expect(merged.url).toBe(
      "https://acme.test/p?a=1%202&b=x+y&utm_source=instagram&utm_medium=social&utm_campaign=agx-bio&utm_content=agx_ab12cd#top",
    );
  });

  it("keeps the site_source_name macro raw but encodes ordinary values", () => {
    const merged = mergeUtm("https://acme.test/", {
      utm_term: "{{site_source_name}}",
      utm_campaign: "a b&c",
    });
    expect(merged.url).toBe(
      "https://acme.test/?utm_campaign=a%20b%26c&utm_term={{site_source_name}}",
    );
  });

  it("leaves non-http inputs unchanged", () => {
    for (const input of [
      "mailto:a@acme.test",
      "tel:+90555",
      "/pricing",
      "not a url",
    ]) {
      expect(mergeUtm(input, meta())).toEqual({
        url: input,
        added: [],
        kept: [],
      });
    }
  });
});

describe("tagOutboundUrl", () => {
  const domains = ["acme.test"];
  const params = meta();

  it("tags own-site links, including subdomains and www.", () => {
    for (const url of [
      "https://acme.test/",
      "https://www.acme.test/x",
      "https://shop.acme.test/x",
    ]) {
      const decision = tagOutboundUrl({
        url,
        domains,
        params,
        context: "outbound",
      });
      expect(decision.tagged).toBe(true);
    }
  });

  it("skips foreign hosts and lookalikes", () => {
    for (const url of [
      "https://other.test/",
      "https://notacme.test/",
      "https://acme.test.evil.com/",
    ]) {
      expect(
        tagOutboundUrl({ url, domains, params, context: "outbound" }),
      ).toEqual({
        tagged: false,
        url,
        reason: "not_own_site",
      });
    }
  });

  it("never tags internal links, even on the own site", () => {
    expect(
      tagOutboundUrl({
        url: "https://acme.test/",
        domains,
        params,
        context: "internal",
      }),
    ).toEqual({ tagged: false, url: "https://acme.test/", reason: "internal" });
  });

  it("leaves mailto:, tel:, relative and invalid urls untouched", () => {
    const reasons = [
      ["mailto:a@acme.test", "not_http"],
      ["tel:+90555", "not_http"],
      ["/pricing", "not_http"],
      ["not a url", "invalid"],
      ["http://", "invalid"],
    ] as const;
    for (const [url, reason] of reasons) {
      expect(
        tagOutboundUrl({ url, domains, params, context: "outbound" }),
      ).toEqual({
        tagged: false,
        url,
        reason,
      });
    }
  });

  it("reports no_domain and all_present", () => {
    expect(
      tagOutboundUrl({
        url: "https://acme.test/",
        domains: [],
        params,
        context: "outbound",
      }),
    ).toMatchObject({ tagged: false, reason: "no_domain" });
    const full =
      "https://acme.test/?utm_source=a&utm_medium=b&utm_campaign=c&utm_term=d&utm_content=e";
    expect(
      tagOutboundUrl({ url: full, domains, params, context: "outbound" }),
    ).toEqual({
      tagged: false,
      url: full,
      reason: "all_present",
    });
  });
});

describe("urlTagsFor", () => {
  it("omits keys already present and keeps the macro raw", () => {
    expect(
      urlTagsFor({ link: "https://acme.test/?utm_campaign=x", params: meta() }),
    ).toBe(
      "utm_source=facebook&utm_medium=paid_social&utm_term={{site_source_name}}&utm_content=agx_ab12cd",
    );
  });

  it("returns an empty string when every key is present", () => {
    const link =
      "https://acme.test/?utm_source=a&UTM_MEDIUM=b&utm_campaign=c&utm_term=d&utm_content=e";
    expect(urlTagsFor({ link, params: meta() })).toBe("");
  });
});

describe("stripUtm / parseUtm", () => {
  it("removes utm_* case-insensitively and keeps other params and the fragment", () => {
    expect(
      stripUtm("https://acme.test/p?UTM_Source=a&a=1&utm_content=b#x"),
    ).toBe("https://acme.test/p?a=1#x");
  });

  it("drops the question mark when nothing is left and ignores other inputs", () => {
    expect(stripUtm("https://acme.test/p?utm_source=a")).toBe(
      "https://acme.test/p",
    );
    expect(stripUtm("https://acme.test/p")).toBe("https://acme.test/p");
    expect(stripUtm("mailto:a@b.c?utm_source=a")).toBe(
      "mailto:a@b.c?utm_source=a",
    );
  });

  it("parses decoded values with case-insensitive keys and rejects non-http", () => {
    expect(
      parseUtm("https://acme.test/?UTM_Campaign=a%20b&utm_content=agx_ab12cd"),
    ).toEqual({
      utm_campaign: "a b",
      utm_content: "agx_ab12cd",
    });
    expect(parseUtm("/relative?utm_source=a")).toBeNull();
    expect(parseUtm("mailto:a@b.c")).toBeNull();
  });
});

describe("agx names", () => {
  it("folds Turkish characters into a slug", () => {
    expect(agxCampaignName("Bahar İndirimi – Lead")).toBe(
      "agx-bahar-indirimi-lead",
    );
    expect(agxCampaignName("ÇİĞDEM Şöleni")).toBe("agx-cigdem-soleni");
  });

  it("is idempotent", () => {
    expect(agxCampaignName("agx-spring")).toBe("agx-spring");
    expect(agxCampaignName(agxCampaignName("Bahar İndirimi – Lead"))).toBe(
      "agx-bahar-indirimi-lead",
    );
  });

  it("caps at 40 characters, cutting at a hyphen", () => {
    const name = agxCampaignName(
      "alpha beta gamma delta epsilon zeta eta theta iota kappa",
    );
    // 40 karakterlik sınırda ("...-eta-theta" 45) son tire noktasından kesilir.
    expect(name).toBe("agx-alpha-beta-gamma-delta-epsilon-zeta-eta");
    expect(name.length - 4).toBeLessThanOrEqual(40);
    expect(agxCampaignName("x".repeat(60))).toBe(`agx-${"x".repeat(40)}`);
  });

  it("falls back to agx-campaign for empty input", () => {
    expect(agxCampaignName("")).toBe("agx-campaign");
    expect(agxCampaignName("!!! ???")).toBe("agx-campaign");
  });

  it("parses codes strictly", () => {
    expect(parseAgxCode("agx_ABC123")).toBe("abc123");
    expect(parseAgxCode("agx_abc12")).toBeNull();
    expect(parseAgxCode("agx-abc123")).toBeNull();
    expect(parseAgxCode(null)).toBeNull();
    expect(agxContent("abc123")).toBe("agx_abc123");
  });

  it("recognizes agx campaigns case-insensitively", () => {
    expect(isAgxCampaign("AGX-Spring")).toBe(true);
    expect(isAgxCampaign("  agx-x ")).toBe(true);
    expect(isAgxCampaign("spring")).toBe(false);
    expect(isAgxCampaign(undefined)).toBe(false);
  });
});

describe("site domains", () => {
  it("normalizes, validates and dedupes", () => {
    expect(
      siteDomainsOf({
        projectDomain: "https://www.Acme.test/",
        streamUri: "https://acme.test/shop",
      }),
    ).toEqual(["acme.test"]);
    expect(
      siteDomainsOf({
        projectDomain: "acme.test",
        streamUri: "https://shop.example.org",
      }),
    ).toEqual(["acme.test", "shop.example.org"]);
    expect(
      siteDomainsOf({ projectDomain: "nonsense", streamUri: null }),
    ).toEqual([]);
    expect(siteDomainsOf({ projectDomain: null, streamUri: null })).toEqual([]);
  });

  it("matches hosts by suffix on a dot boundary only", () => {
    expect(isOwnSiteUrl("https://a.b.acme.test/", ["acme.test"])).toBe(true);
    expect(isOwnSiteUrl("https://xacme.test/", ["acme.test"])).toBe(false);
    expect(isOwnSiteUrl("ftp://acme.test/", ["acme.test"])).toBe(false);
  });
});

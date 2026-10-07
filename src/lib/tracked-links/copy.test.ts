import { describe, expect, it } from "vitest";

import { LINK_TRACKING_COPY, bioDefaultUrl } from "./copy";

describe("bioDefaultUrl", () => {
  it("normalizes the project domain to a home page link", () => {
    expect(bioDefaultUrl("WWW.Acme.com/path")).toBe("https://acme.com/");
    expect(bioDefaultUrl("https://shop.acme.com")).toBe("https://shop.acme.com/");
  });

  it("returns null without a usable domain", () => {
    expect(bioDefaultUrl(null)).toBeNull();
    expect(bioDefaultUrl("")).toBeNull();
    expect(bioDefaultUrl("not a domain")).toBeNull();
  });
});

describe("LINK_TRACKING_COPY", () => {
  it("keeps the card title and toggle label stable", () => {
    expect(LINK_TRACKING_COPY.title).toBe("Link tracking");
    expect(LINK_TRACKING_COPY.toggle).toBe("Add tracking (UTM) to links");
  });
});

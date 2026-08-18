import { describe, expect, it } from "vitest";

import {
  fingerprintOf,
  insightFingerprint,
  opportunityFingerprint,
  signalFingerprint,
  taskFingerprint,
} from "@/server/agency/fingerprint";

describe("fingerprint", () => {
  it("is deterministic", () => {
    expect(fingerprintOf("a", "b")).toBe(fingerprintOf("a", "b"));
  });

  it("normalizes case, punctuation, and whitespace", () => {
    expect(
      signalFingerprint({
        category: "PRODUCT_LAUNCH",
        source: "news",
        title: "New iPhone Launch!!",
      }),
    ).toBe(
      signalFingerprint({
        category: "PRODUCT_LAUNCH",
        source: "news",
        title: "  new iphone   launch",
      }),
    );
  });

  it("differs across categories and titles", () => {
    const a = signalFingerprint({ category: "SEO", source: "scan", title: "x" });
    const b = signalFingerprint({ category: "MEDIA", source: "scan", title: "x" });
    const c = signalFingerprint({ category: "SEO", source: "scan", title: "y" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("prefers externalRef over title for signals when present", () => {
    const withRef = signalFingerprint({
      category: "COMPETITOR",
      source: "rss",
      externalRef: "item-123",
      title: "one phrasing",
    });
    const samePhrasingDifferentTitle = signalFingerprint({
      category: "COMPETITOR",
      source: "rss",
      externalRef: "item-123",
      title: "totally different phrasing",
    });
    expect(withRef).toBe(samePhrasingDifferentTitle);
  });

  it("scopes insight/opportunity/task fingerprints by kind", () => {
    const insight = insightFingerprint({ category: "SEO", title: "gap" });
    const opportunity = opportunityFingerprint({ category: "SEO", title: "gap" });
    const task = taskFingerprint({
      capability: "CREATE_COPY",
      department: "COPY_CONTENT",
      subject: "gap",
    });
    expect(new Set([insight, opportunity, task]).size).toBe(3);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activeDeliverables,
  buildAgencyCapabilities,
  DELIVERABLE_KEYS,
  DELIVERABLES,
  isDeliverableActive,
} from "./deliverables";

afterEach(() => vi.unstubAllEnvs());

describe("deliverables catalog", () => {
  it("offers every deliverable when the full agency runs", () => {
    expect(activeDeliverables().map((d) => d.key)).toEqual([...DELIVERABLE_KEYS]);
  });

  it("drops deliverables of departments outside agency focus mode", () => {
    vi.stubEnv("AGENCY_FOCUS", "social_ads");
    // SEO is switched off in focus mode; Creative and Social stay.
    expect(isDeliverableActive("seo_article")).toBe(false);
    expect(isDeliverableActive("instagram_post")).toBe(true);
    expect(activeDeliverables().map((d) => d.key)).not.toContain("seo_article");
  });

  it("only image deliverables need a format", () => {
    expect(DELIVERABLES.instagram_post.needsFormat).toBe(true);
    expect(DELIVERABLES.seo_article.needsFormat).toBe(false);
  });

  it("describes the agency for the model's context", () => {
    const context = buildAgencyCapabilities(["instagram"]);
    expect(context.activeDepartments).toContain("SEO");
    expect(context.connectedChannels).toEqual(["instagram"]);
    expect(context.deliverables.find((d) => d.key === "seo_article")).toMatchObject({
      department: "SEO",
    });
  });
});

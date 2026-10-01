import { describe, expect, it } from "vitest";

import { creativeFieldsOfPlanItem } from "./plan-item-fields";

const base = { date: "2026-10-02", time: "10:00", topic: "T", captionIdea: "cap" };

describe("creativeFieldsOfPlanItem", () => {
  it("maps a catalog instagram.post", () => {
    expect(
      creativeFieldsOfPlanItem({ ...base, channel: "instagram", formatKey: "instagram.post" }),
    ).toMatchObject({
      platform: "INSTAGRAM",
      channel: "instagram",
      formatKey: "instagram.post",
      title: "T",
      brief: "cap",
    });
  });
  it("maps seo.article without a platform", () => {
    const f = creativeFieldsOfPlanItem({ ...base, channel: "seo", formatKey: "seo.article" });
    expect(f.platform).toBeUndefined();
    expect(f.type).toBe("COPY");
    expect(f.brief).toBe("cap");
  });
  it("maps a legacy INSTAGRAM + Carousel item", () => {
    const f = creativeFieldsOfPlanItem({ ...base, platform: "INSTAGRAM", format: "Carousel" });
    expect(f.channel).toBe("instagram");
    expect(f.formatKey).toBe("instagram.carousel");
    expect(f.platform).toBe("INSTAGRAM");
    expect(f.brief).toBe("cap");
  });
  it("keeps an unknown legacy platform with the format folded into the brief", () => {
    expect(
      creativeFieldsOfPlanItem({ ...base, platform: "FACEBOOK", format: "Photo" }),
    ).toEqual({
      type: "SOCIAL_POST",
      platform: "FACEBOOK",
      channel: undefined,
      formatKey: undefined,
      title: "T",
      brief: "[Photo] cap",
    });
  });
  it("leaves the brief alone for an unknown platform without a format", () => {
    expect(creativeFieldsOfPlanItem({ ...base, platform: "FACEBOOK" }).brief).toBe("cap");
  });
});

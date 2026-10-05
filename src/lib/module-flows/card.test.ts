import { describe, expect, it } from "vitest";

import {
  isFlowModuleKey,
  isModuleFlowCard,
  newModuleFlowCard,
} from "./card";

describe("module flow card", () => {
  it("starts a flow at its brief with no data", () => {
    expect(newModuleFlowCard("ads", "Ads Manager")).toEqual({
      kind: "module-flow",
      module: "ads",
      title: "Ads Manager",
      step: "brief",
      data: {},
    });
  });

  it("accepts only the three flow modules and a well-formed envelope", () => {
    expect(isFlowModuleKey("seo")).toBe(true);
    expect(isFlowModuleKey("social")).toBe(false);
    expect(isModuleFlowCard(newModuleFlowCard("analytics", "Analytics"))).toBe(
      true,
    );
    expect(
      isModuleFlowCard({ ...newModuleFlowCard("seo", "SEO"), step: "launch" }),
    ).toBe(false);
    expect(
      isModuleFlowCard({ ...newModuleFlowCard("seo", "SEO"), data: [] }),
    ).toBe(false);
  });
});

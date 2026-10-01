import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { toInsightsRow } from "./meta-client";

const row = {
  spend: "100",
  actions: [
    { action_type: "link_click", value: "50" },
    { action_type: "lead", value: "4" },
  ],
};

describe("toInsightsRow lead preference", () => {
  it("default keeps the highest-count action", () => {
    const r = toInsightsRow(row);
    expect(r.resultLabel).toBe("Link Clicks");
    expect(r.costPerResult).toBe(2);
  });

  it("preferLead picks the lead action when its count > 0", () => {
    const r = toInsightsRow(row, { preferLead: true });
    expect(r.resultLabel).toBe("Leads");
    expect(r.costPerResult).toBe(25);
  });

  it("preferLead falls back when there are no leads", () => {
    const r = toInsightsRow(
      { spend: "10", actions: [{ action_type: "link_click", value: "5" }] },
      { preferLead: true },
    );
    expect(r.resultLabel).toBe("Link Clicks");
    const z = toInsightsRow(
      { spend: "10", actions: [{ action_type: "lead", value: "0" }, { action_type: "post", value: "3" }] },
      { preferLead: true },
    );
    expect(z.resultLabel).toBe("Post Shares");
  });

  it("onsite lead_grouped is labelled honestly", () => {
    const r = toInsightsRow(
      { spend: "10", actions: [{ action_type: "onsite_conversion.lead_grouped", value: "2" }] },
      { preferLead: true },
    );
    expect(r.resultCount).toBe(2);
  });
});

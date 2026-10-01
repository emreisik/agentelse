import { describe, expect, it } from "vitest";

import {
  worksPlanSummary,
  worksPublishMode,
  worksPublishTone,
} from "./plan-publish-truth";

describe("worksPublishMode", () => {
  it("keeps Instagram auto as auto", () => {
    expect(
      worksPublishMode({ channel: "instagram", formatKey: "instagram.post", publish: "auto" }),
    ).toBe("auto");
    expect(
      worksPublishMode({ channel: "instagram", formatKey: "instagram.story", publish: "auto" }),
    ).toBe("auto");
  });

  it("turns LinkedIn and X auto into manual: only Instagram is ever posted by the app", () => {
    expect(
      worksPublishMode({ channel: "linkedin", formatKey: "linkedin.post", publish: "auto" }),
    ).toBe("manual");
    expect(
      worksPublishMode({ channel: "x", formatKey: "x.post", publish: "auto" }),
    ).toBe("manual");
  });

  it("reads the channel from the format key when the channel is missing", () => {
    expect(worksPublishMode({ formatKey: "x.post", publish: "auto" })).toBe("manual");
    expect(worksPublishMode({ formatKey: "instagram.post", publish: "auto" })).toBe("auto");
    // No way to tell: not claimed as automatic.
    expect(worksPublishMode({ publish: "auto" })).toBe("manual");
  });

  it("leaves manual and approval unchanged", () => {
    expect(worksPublishMode({ channel: "seo", publish: "manual" })).toBe("manual");
    expect(worksPublishMode({ channel: "instagram", publish: "manual" })).toBe("manual");
    expect(worksPublishMode({ channel: "ads", publish: "approval" })).toBe("approval");
  });
});

describe("worksPlanSummary", () => {
  it("counts what really happens to each piece", () => {
    expect(
      worksPlanSummary([
        { channel: "instagram", publish: "auto" },
        { channel: "instagram", publish: "auto" },
        { channel: "linkedin", publish: "auto" },
        { channel: "ads", publish: "approval" },
      ]),
    ).toBe(
      "2 on Instagram, posted once approved · 1 you post yourself · 1 waiting for your approval",
    );
  });

  it("omits the parts with no pieces", () => {
    expect(worksPlanSummary([{ channel: "x", publish: "auto" }])).toBe("1 you post yourself");
    expect(worksPlanSummary([{ channel: "ads", publish: "approval" }])).toBe(
      "1 waiting for your approval",
    );
    expect(worksPlanSummary([{ channel: "instagram", publish: "auto" }])).toBe(
      "1 on Instagram, posted once approved",
    );
  });

  it("is empty for no pieces and skips pieces of an unknown platform", () => {
    expect(worksPlanSummary([])).toBe("");
    expect(worksPlanSummary([{}])).toBe("");
  });
});

describe("worksPublishTone", () => {
  it("says it plainly", () => {
    expect(worksPublishTone("auto")).toBe("Posts to Instagram once you approve it");
    expect(worksPublishTone("manual")).toBe("You post it yourself");
    expect(worksPublishTone("approval")).toBe("Waits for your approval");
  });
});

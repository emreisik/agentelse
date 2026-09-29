import { describe, expect, it } from "vitest";

import {
  extractResultText,
  shouldExpandTaskResult,
} from "./execution-result-text";

describe("extractResultText", () => {
  it("prefers the provider's text, then caption + copy, then the raw JSON", () => {
    expect(extractResultText({ text: "Makale" })).toBe("Makale");
    expect(extractResultText({ caption: "c", copy: "d" })).toBe("c\n\nd");
    expect(extractResultText({ other: 1 })).toContain('"other": 1');
    expect(extractResultText(null)).toBeNull();
  });
});

describe("shouldExpandTaskResult", () => {
  it("opens a text deliverable the client asked for", () => {
    expect(shouldExpandTaskResult("CREATE_COPY", "USER")).toBe(true);
    expect(shouldExpandTaskResult("CREATE_CAPTION", "USER")).toBe(true);
    expect(shouldExpandTaskResult("EMAIL_DRAFT", "USER")).toBe(true);
  });

  it("keeps autonomous work-plan output and research collapsed", () => {
    expect(shouldExpandTaskResult("CREATE_COPY", "AI")).toBe(false);
    expect(shouldExpandTaskResult("CREATE_COPY", "SYSTEM")).toBe(false);
    expect(shouldExpandTaskResult("CREATE_COPY", undefined)).toBe(false);
    expect(shouldExpandTaskResult("MARKET_RESEARCH", "USER")).toBe(false);
    expect(shouldExpandTaskResult("CREATE_CAMPAIGN_BRIEF", "USER")).toBe(false);
  });
});

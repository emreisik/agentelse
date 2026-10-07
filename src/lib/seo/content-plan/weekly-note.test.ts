import { describe, expect, it } from "vitest";

import { weeklySeoNoteText } from "./weekly-note";

describe("weeklySeoNoteText", () => {
  it("is empty for none", () => {
    expect(weeklySeoNoteText(0)).toBe("");
    expect(weeklySeoNoteText(-2)).toBe("");
    expect(weeklySeoNoteText(Number.NaN)).toBe("");
  });

  it("reads naturally for one and several", () => {
    expect(weeklySeoNoteText(1)).toBe(
      "One SEO article from this month's plan is also due this week.",
    );
    expect(weeklySeoNoteText(3)).toBe(
      "3 SEO articles from this month's plan are also due this week.",
    );
  });
});

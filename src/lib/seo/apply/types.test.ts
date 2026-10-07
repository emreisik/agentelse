import { describe, expect, it } from "vitest";

import {
  SEO_CHANGE_ERROR_CODES,
  SEO_CHANGE_KINDS,
  SEO_CHANGE_STATUSES,
} from "./types";

describe("SC-F8 type constants", () => {
  it("lists the four change kinds", () => {
    expect([...SEO_CHANGE_KINDS]).toEqual([
      "PUBLISH_ARTICLE",
      "PUBLISH_LIVE",
      "TITLE_META",
      "INTERNAL_LINKS",
    ]);
  });

  it("lists the ten statuses without duplicates", () => {
    expect(SEO_CHANGE_STATUSES).toHaveLength(10);
    expect(new Set(SEO_CHANGE_STATUSES).size).toBe(10);
  });

  it("has unique error codes", () => {
    expect(new Set(SEO_CHANGE_ERROR_CODES).size).toBe(SEO_CHANGE_ERROR_CODES.length);
    expect(SEO_CHANGE_ERROR_CODES).toContain("page_changed");
    expect(SEO_CHANGE_ERROR_CODES).toContain("cannot_undo");
  });
});

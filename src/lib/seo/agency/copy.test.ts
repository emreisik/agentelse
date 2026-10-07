import { describe, expect, it } from "vitest";

import {
  ADD_SITE_MESSAGE,
  BQ_BADGE_LABEL,
  PAGE_GROUP_MATCH_LABEL,
  SECONDARY_NOTE,
} from "./copy";

describe("agency copy", () => {
  it("has a fixed message for every add-site code", () => {
    expect(Object.keys(ADD_SITE_MESSAGE).sort()).toEqual(
      [
        "ALREADY_ADDED",
        "IS_PRIMARY",
        "LIMIT",
        "NOT_ALLOWED",
        "NOT_CONNECTED",
        "NOT_IN_ACCOUNT",
        "OTHER_MODE",
        "UNVERIFIED",
      ].sort(),
    );
    expect(ADD_SITE_MESSAGE.LIMIT).toBe(
      "A project can track up to 5 Search Console sites.",
    );
    expect(ADD_SITE_MESSAGE.OTHER_MODE).toBe(
      "This site already exists in another mode.",
    );
  });

  it("labels every badge and match type", () => {
    expect(BQ_BADGE_LABEL.ACTIVE).toBe("On");
    expect(BQ_BADGE_LABEL.BUDGET).toBe("Monthly budget used");
    expect(Object.keys(BQ_BADGE_LABEL)).toHaveLength(7);
    expect(PAGE_GROUP_MATCH_LABEL).toEqual({
      PREFIX: "Starts with",
      GLOB: "Pattern (* and **)",
      EXACT: "Exactly",
    });
    expect(SECONDARY_NOTE).toContain("primary site");
  });
});

import { describe, expect, it } from "vitest";

import { mergeUtm, utmFor } from "@/lib/utm";

import {
  TRACKED_ENTITY_TYPES,
  carriesAgxCode,
  entityKindLabel,
  isTrackedEntityType,
  metaAdEntityId,
  parseMetaAdEntityId,
} from "./types";

describe("meta ad entity id", () => {
  it("round-trips", () => {
    const id = metaAdEntityId("cmd1", 3);
    expect(id).toBe("cmd1:3");
    expect(parseMetaAdEntityId(id)).toEqual({ commandId: "cmd1", adIndex: 3 });
  });

  it("rejects malformed ids", () => {
    for (const bad of ["cmd1", "cmd1:", ":2", "cmd1:x", "cmd1:-1", "cmd1:1.5"]) {
      expect(parseMetaAdEntityId(bad)).toBeNull();
    }
  });
});

describe("entity kinds", () => {
  it("labels every type", () => {
    expect(TRACKED_ENTITY_TYPES.map(entityKindLabel)).toEqual([
      "Meta ads",
      "Instagram bio link",
      "Facebook post",
      "Social post",
    ]);
  });

  it("guards the entity type", () => {
    expect(isTrackedEntityType("meta_ad")).toBe(true);
    expect(isTrackedEntityType("nope")).toBe(false);
    expect(isTrackedEntityType(1)).toBe(false);
  });
});

describe("carriesAgxCode", () => {
  const params = utmFor({ channel: "meta_ads", campaign: "agx-x", code: "ab12cd" });

  it("is true for a freshly tagged url", () => {
    const taggedUrl = mergeUtm("https://acme.test/", params).url;
    expect(carriesAgxCode({ code: "ab12cd", taggedUrl })).toBe(true);
  });

  it("is false when the destination kept its own utm_content", () => {
    const taggedUrl = mergeUtm("https://acme.test/?utm_content=mine", params).url;
    expect(carriesAgxCode({ code: "ab12cd", taggedUrl })).toBe(false);
  });
});

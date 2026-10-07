import { describe, expect, it } from "vitest";

import {
  LINK_TRACKING_DEFAULTS,
  parseLinkTrackingForm,
  readLinkTrackingSettings,
} from "./settings";

describe("link tracking settings", () => {
  it("defaults to on when no row exists", () => {
    expect(readLinkTrackingSettings(null)).toEqual({ utmEnabled: true, stored: false });
    expect(LINK_TRACKING_DEFAULTS).toEqual({ utmEnabled: true });
  });

  it("reads a stored boolean and falls back for anything else", () => {
    expect(readLinkTrackingSettings({ utmEnabled: false })).toEqual({ utmEnabled: false, stored: true });
    expect(readLinkTrackingSettings({ utmEnabled: "no" })).toEqual({ utmEnabled: true, stored: true });
    expect(readLinkTrackingSettings({})).toEqual({ utmEnabled: true, stored: true });
  });

  it("parses the checkbox form", () => {
    const on = new FormData();
    on.set("utmEnabled", "on");
    expect(parseLinkTrackingForm(on)).toEqual({ utmEnabled: true });
    expect(parseLinkTrackingForm(new FormData())).toEqual({ utmEnabled: false });
  });
});

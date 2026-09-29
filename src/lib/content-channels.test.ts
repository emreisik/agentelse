import { describe, expect, it } from "vitest";

import { DELIVERABLE_KEYS } from "@/server/chat/deliverables";
import {
  ALL_FORMAT_KEYS,
  CHANNELS,
  CHANNEL_KEYS,
  channelOfFormatKey,
  legacyToFormat,
  resolveFormat,
  resolvePlanItem,
} from "./content-channels";
import { getCreativePlatformFormat } from "./creative-platform-format";

describe("channel catalog", () => {
  it("keeps every format key unique and prefixed with its channel", () => {
    expect(new Set(ALL_FORMAT_KEYS).size).toBe(ALL_FORMAT_KEYS.length);
    for (const channel of CHANNEL_KEYS) {
      expect(CHANNELS[channel].formats.length).toBeGreaterThan(0);
      for (const format of CHANNELS[channel].formats) {
        expect(format.key.startsWith(`${channel}.`)).toBe(true);
        expect(channelOfFormatKey(format.key)).toBe(channel);
      }
    }
  });

  it("only points at real deliverables and real pixel formats", () => {
    for (const channel of CHANNEL_KEYS) {
      const { platform, formats } = CHANNELS[channel];
      for (const format of formats) {
        if (format.deliverable) {
          expect(DELIVERABLE_KEYS).toContain(format.deliverable);
        }
        if (format.contentFormat) {
          expect(platform).toBeDefined();
          expect(
            getCreativePlatformFormat(platform!, format.contentFormat)
              .contentFormat,
          ).toBe(format.contentFormat);
        }
      }
    }
  });

  it("never lets an ad brief publish without approval, or a blog article by itself", () => {
    expect(resolveFormat("ads", "ads.campaign")?.publish).toBe("approval");
    expect(resolveFormat("seo", "seo.article")?.publish).toBe("manual");
    expect(CHANNELS.ads.platform).toBeUndefined();
    expect(CHANNELS.seo.platform).toBeUndefined();
  });
});

describe("legacy plan items", () => {
  it("maps a platform and free-text format onto the catalog", () => {
    expect(legacyToFormat("INSTAGRAM", "Reel")?.format.key).toBe(
      "instagram.reel",
    );
    expect(legacyToFormat("INSTAGRAM", "Carousel")?.format.key).toBe(
      "instagram.carousel",
    );
    expect(legacyToFormat("INSTAGRAM", "Static post")?.format.key).toBe(
      "instagram.post",
    );
    expect(legacyToFormat("LINKEDIN")?.format.key).toBe("linkedin.post");
    expect(legacyToFormat("INSTAGRAM", "something odd")?.format.key).toBe(
      "instagram.post",
    );
  });

  it("returns undefined for platforms outside the catalog", () => {
    expect(legacyToFormat("FACEBOOK", "Live")).toBeUndefined();
    expect(resolvePlanItem({ platform: "YOUTUBE" })).toBeUndefined();
  });

  it("prefers the catalog fields over the legacy ones", () => {
    expect(
      resolvePlanItem({
        channel: "seo",
        formatKey: "seo.article",
        platform: "INSTAGRAM",
      })?.channel,
    ).toBe("seo");
    // An invalid format key falls back to the legacy platform.
    expect(
      resolvePlanItem({
        channel: "instagram",
        formatKey: "instagram.nope",
        platform: "INSTAGRAM",
        format: "Reel",
      })?.format.key,
    ).toBe("instagram.reel");
  });
});

import { describe, expect, it } from "vitest";
import type { CapabilityKey } from "@prisma/client";

import {
  ACCOUNT_SETUP_PLATFORMS,
  accountSetupPlatformName,
  isAccountSetupPlatform,
  missingCapabilityInput,
  missingInputAdvice,
  missingInputMessage,
} from "./capability-input";
import { STANDARD_BROWSER_PROFILE_PURPOSES } from "@/server/projects/standard-browser-profiles";

// The one rule for "this capability cannot run without an input": which
// capabilities, what counts as given, and the two texts (developer, client).

describe("missingCapabilityInput", () => {
  it("asks for a platform when a new account is to be set up and none is given", () => {
    expect(missingCapabilityInput("SOCIAL_ACCOUNT_SETUP", {})).toEqual({
      field: "platform",
      problem: "missing",
      allowed: ["INSTAGRAM", "TIKTOK", "LINKEDIN"],
    });
  });

  it.each([undefined, null, "", "   ", 3, {}, ["INSTAGRAM"]])(
    "treats %j as no platform",
    (platform) => {
      expect(
        missingCapabilityInput("SOCIAL_ACCOUNT_SETUP", { platform })?.problem,
      ).toBe("missing");
    },
  );

  it.each(ACCOUNT_SETUP_PLATFORMS)("accepts %s", (platform) => {
    expect(
      missingCapabilityInput("SOCIAL_ACCOUNT_SETUP", { platform }),
    ).toBeNull();
  });

  it.each(["FACEBOOK", "YOUTUBE", "PINTEREST", "X", "instagram", "GOOGLE_ADS"])(
    "says an account cannot be set up on %s",
    (platform) => {
      expect(
        missingCapabilityInput("SOCIAL_ACCOUNT_SETUP", { platform }),
      ).toMatchObject({ problem: "unsupported", got: platform });
    },
  );

  it("is case sensitive: the value is an enum, not free text", () => {
    expect(isAccountSetupPlatform("Instagram")).toBe(false);
    expect(isAccountSetupPlatform("INSTAGRAM")).toBe(true);
  });

  it.each([
    "CREATE_COPY",
    "CREATE_CAPTION",
    "INSTAGRAM_PUBLISH",
    "X_PUBLISH",
    "SOCIAL_PROFILE_AUDIT",
    "COMPETITOR_RESEARCH",
    "META_CAMPAIGN_CREATE",
  ] as CapabilityKey[])("asks nothing for %s", (capability) => {
    expect(missingCapabilityInput(capability, {})).toBeNull();
    expect(
      missingCapabilityInput(capability, { platform: "FACEBOOK" }),
    ).toBeNull();
  });
});

describe("the platforms an account can be set up on", () => {
  it("are exactly the ones with a browser profile", () => {
    expect([...ACCOUNT_SETUP_PLATFORMS]).toEqual([
      "INSTAGRAM",
      "TIKTOK",
      "LINKEDIN",
    ]);
  });

  it("all have a profile in the standard bundle every project gets", () => {
    // The compile-time `satisfies` in capability-input.ts says the same; this
    // keeps the runtime values honest too.
    for (const platform of ACCOUNT_SETUP_PLATFORMS) {
      expect(STANDARD_BROWSER_PROFILE_PURPOSES).toContain(platform);
    }
  });

  it("leave out X: nothing ever creates an X browser profile", () => {
    expect(STANDARD_BROWSER_PROFILE_PURPOSES).not.toContain("X");
    expect(isAccountSetupPlatform("X")).toBe(false);
  });

  it("have a name a person would write", () => {
    expect(ACCOUNT_SETUP_PLATFORMS.map(accountSetupPlatformName)).toEqual([
      "Instagram",
      "TikTok",
      "LinkedIn",
    ]);
  });
});

describe("the texts", () => {
  const missing = missingCapabilityInput("SOCIAL_ACCOUNT_SETUP", {})!;
  const unsupported = missingCapabilityInput("SOCIAL_ACCOUNT_SETUP", {
    platform: "FACEBOOK",
  })!;

  it("keep the developer message this error has always had for a missing platform", () => {
    expect(missingInputMessage("SOCIAL_ACCOUNT_SETUP", missing)).toBe(
      "SOCIAL_ACCOUNT_SETUP requires a `platform` field in the request payload",
    );
  });

  it("name the offending platform for a developer", () => {
    expect(missingInputMessage("SOCIAL_ACCOUNT_SETUP", unsupported)).toBe(
      "SOCIAL_ACCOUNT_SETUP cannot open an account on FACEBOOK; supported platforms: INSTAGRAM, TIKTOK, LINKEDIN",
    );
  });

  it("tell the client what is wrong and what to do, without enum names or payload jargon", () => {
    const advice = missingInputAdvice(missing);

    expect(advice).toContain("does not say which platform");
    expect(advice).toContain("Instagram, TikTok or LinkedIn");
    expect(advice).toContain("Reject it and ask again");
    expect(advice).not.toMatch(/SOCIAL_ACCOUNT_SETUP|payload|`/);
  });

  it("name the unsupported platform for the client", () => {
    expect(missingInputAdvice(unsupported)).toContain(
      "cannot be set up on FACEBOOK",
    );
  });

  it("fit a Telegram alert (200 characters)", () => {
    expect(missingInputAdvice(missing).length).toBeLessThanOrEqual(200);
    expect(missingInputAdvice(unsupported).length).toBeLessThanOrEqual(200);
  });
});

import type { CapabilityKey, SocialPlatform } from "@prisma/client";

import type { StandardBrowserProfilePurpose } from "@/server/projects/standard-browser-profiles";

// Some capabilities cannot run without an input that free text does not carry.
// This is the one place that says which, so every door that can start a task
// (the chat agent, the legacy classifier, the composer shortcuts, an approval
// clicked later) applies the same rule as the router that finally needs it,
// instead of finding out after a person has already approved.
//
// Pure (no server-only, no database) so tests, the router and the doors can all
// import it.

// Platforms a browser agent can open a NEW account on: the ones that are both a
// SocialPlatform (what a client names) and have a profile in the standard
// browser-profile bundle (the profile the agent works in, created by
// projects/browser-profiles.ts). The `satisfies` ties the list to that bundle at
// compile time. Facebook, YouTube and Pinterest are valid platforms for other
// things but have no profile to set an account up in; X has none either (no
// code ever creates one), so offering it ended in PROVIDER_UNAVAILABLE after the
// client had approved.
export const ACCOUNT_SETUP_PLATFORMS = [
  "INSTAGRAM",
  "TIKTOK",
  "LINKEDIN",
] as const satisfies readonly (SocialPlatform &
  StandardBrowserProfilePurpose)[];

export type AccountSetupPlatform = (typeof ACCOUNT_SETUP_PLATFORMS)[number];

export function isAccountSetupPlatform(
  value: unknown,
): value is AccountSetupPlatform {
  return (
    typeof value === "string" &&
    (ACCOUNT_SETUP_PLATFORMS as readonly string[]).includes(value)
  );
}

export type MissingCapabilityInput = {
  field: "platform";
  // "missing": no platform was given. "unsupported": one was, but account setup
  // cannot work on it.
  problem: "missing" | "unsupported";
  got?: string;
  allowed: readonly AccountSetupPlatform[];
};

// What is missing for this capability to be runnable, or null when nothing is.
// `platform` is what the task payload will carry (the caller merges the intent's
// target platform and any explicit payload override the same way the planner
// does).
export function missingCapabilityInput(
  capability: CapabilityKey,
  input: { platform?: unknown },
): MissingCapabilityInput | null {
  if (capability !== "SOCIAL_ACCOUNT_SETUP") return null;

  const { platform } = input;
  if (isAccountSetupPlatform(platform)) return null;
  if (typeof platform === "string" && platform.trim() !== "") {
    return {
      field: "platform",
      problem: "unsupported",
      got: platform,
      allowed: ACCOUNT_SETUP_PLATFORMS,
    };
  }
  return {
    field: "platform",
    problem: "missing",
    allowed: ACCOUNT_SETUP_PLATFORMS,
  };
}

// For logs and developers (the router's error). The "missing" wording is the one
// this error always had.
export function missingInputMessage(
  capability: CapabilityKey,
  missing: MissingCapabilityInput,
): string {
  return missing.problem === "missing"
    ? `${capability} requires a \`platform\` field in the request payload`
    : `${capability} cannot open an account on ${missing.got}; supported platforms: ${missing.allowed.join(", ")}`;
}

const PLATFORM_NAME: Record<AccountSetupPlatform, string> = {
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
  LINKEDIN: "LinkedIn",
};

export const accountSetupPlatformName = (platform: AccountSetupPlatform) =>
  PLATFORM_NAME[platform];

// For the person looking at the task (an approval card, a Telegram alert): what
// is wrong in plain words and what to do about it.
export function missingInputAdvice(missing: MissingCapabilityInput): string {
  const names = missing.allowed.map(accountSetupPlatformName);
  const list = `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return missing.problem === "missing"
    ? `This task cannot run: it does not say which platform the new account is for (${list}). Reject it and ask again naming the platform.`
    : `This task cannot run: a new account cannot be set up on ${missing.got} (only ${list}). Reject it and ask again with one of those.`;
}

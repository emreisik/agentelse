// The browser profiles every project gets (see browser-profiles.ts). Kept in a
// module of its own, with no imports, so that other rules can be tied to it at
// compile time (execution/capability-input.ts: a new account can only be set up
// on a platform that has a profile here).
export const STANDARD_BROWSER_PROFILE_PURPOSES = [
  "PUBLIC_RESEARCH",
  "INSTAGRAM",
  "TIKTOK",
  "META_ADS",
  "GOOGLE_ADS",
  "LINKEDIN",
] as const;

export type StandardBrowserProfilePurpose =
  (typeof STANDARD_BROWSER_PROFILE_PURPOSES)[number];

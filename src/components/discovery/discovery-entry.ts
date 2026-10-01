import type { DiscoveryView } from "@/lib/guided-discovery/contract";

// Which entry points (Welcome card, chip, "+" menu item) show, and with what
// words. Pure: the components only add the thread-empty split on top.

export type DiscoveryEntryKind = "start" | "running" | "review" | "update";

export type DiscoveryEntry = {
  label: string;
  kind: DiscoveryEntryKind;
  // Welcome card: empty thread only (the component applies that), never once
  // the profile is confirmed.
  welcome: boolean;
  // Chip: non-empty thread only (the component applies that), never once the
  // profile is confirmed.
  chip: boolean;
};

export function discoveryEntryOf(
  view: DiscoveryView | null,
  brandName: string,
): DiscoveryEntry {
  if (!view) {
    return { label: "Set up your brand", kind: "start", welcome: true, chip: true };
  }
  switch (view.status) {
    case "RUNNING":
      return {
        label: `Getting to know ${brandName}…`,
        kind: "running",
        welcome: true,
        chip: true,
      };
    case "READY":
      return {
        label: "Review your brand profile",
        kind: "review",
        welcome: true,
        chip: true,
      };
    case "CONFIRMED":
      return {
        label: "Update your setup",
        kind: "update",
        welcome: false,
        chip: false,
      };
    default:
      // FAILED: the sheet explains and offers "Try again"; the entry reads as
      // the start so a person can get back to it.
      return { label: "Set up your brand", kind: "start", welcome: true, chip: true };
  }
}

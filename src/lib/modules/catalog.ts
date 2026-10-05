import type { ChannelKey } from "@/lib/content-channels";
import { SOCIAL_PLATFORMS } from "@/lib/works/plan-platforms";

// The modules a New Chat opens into (plan P4): Social Media Planner, Ads
// Manager, Analytics and SEO Manager. Each walks the same steps (flow.ts) with
// the same design system; a Work remembers its module (Work.module, null = a
// general chat). Isomorphic and pure: the launcher, the sidebar, the page and
// the chat agent read the same catalog. Icons are the UI's choice, not here.

export const MODULE_KEYS = ["social", "ads", "analytics", "seo"] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export type ModuleLabel =
  "Social Media Planner" | "Ads Manager" | "Analytics" | "SEO Manager";

// The verb of a module's last step (flow.ts "deliver").
export type DeliverLabel = "Publish" | "Launch" | "Share";

export type ModuleDef = {
  key: ModuleKey;
  label: ModuleLabel;
  // One short line under the label.
  blurb: string;
  deliverLabel: DeliverLabel;
  // Built and usable. A module that is not ready shows as "Coming soon" (all
  // four are built since P5-P7; the switch stays for a module added later).
  ready: boolean;
  // The channels the module's work goes to (content-channels.ts keys).
  channels: readonly ChannelKey[];
};

export const MODULES: Readonly<Record<ModuleKey, ModuleDef>> = {
  social: {
    key: "social",
    label: "Social Media Planner",
    blurb: "Plan, create and publish posts for your channels.",
    deliverLabel: "Publish",
    ready: true,
    channels: SOCIAL_PLATFORMS,
  },
  ads: {
    key: "ads",
    label: "Ads Manager",
    blurb: "Plan and launch ad campaigns on Meta.",
    deliverLabel: "Launch",
    ready: true,
    channels: ["ads"],
  },
  analytics: {
    key: "analytics",
    label: "Analytics",
    blurb: "See how your channels perform in one clear report.",
    deliverLabel: "Share",
    ready: true,
    channels: [],
  },
  seo: {
    key: "seo",
    label: "SEO Manager",
    blurb: "Find keywords and write articles that rank.",
    deliverLabel: "Publish",
    ready: true,
    channels: ["seo"],
  },
};

export function isModuleKey(value: unknown): value is ModuleKey {
  return (
    typeof value === "string" &&
    (MODULE_KEYS as readonly string[]).includes(value)
  );
}

// A stored or requested module (Work.module, `?module=`): a known key, else null
// (a general chat). Exact match only: "Social" or " ads" are not modules.
export function parseModuleKey(value: unknown): ModuleKey | null {
  return isModuleKey(value) ? value : null;
}

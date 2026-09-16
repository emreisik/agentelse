import type { CapabilityKey, SocialPlatform } from "@prisma/client";
import type { LucideIcon } from "lucide-react";
import {
  BadgeCheck,
  BarChart3,
  Building2,
  CalendarRange,
  FileText,
  Globe,
  Globe2,
  HeartHandshake,
  ImagePlus,
  Mail,
  Megaphone,
  MessageSquareText,
  PackageSearch,
  PenLine,
  Search,
  SearchCheck,
  Send,
  Share2,
  Swords,
  TrendingUp,
  UserPlus,
} from "lucide-react";

import {
  ALL_DEPARTMENT_KEYS_UI,
  DEPARTMENT_KEY,
  capabilityLabel,
} from "@/lib/labels";
import { PURPOSE_ICONS } from "@/features/dashboard/purpose-icons";
import { entityHref } from "@/components/hub-core/hub-core-params";

// The composer "+" menu's full catalog — departments, integrations, and
// capability shortcuts, each either a pure navigation link or a
// precomputed CAPABILITY intent (see command-service.ts's
// SubmitCommandInput.intent comment: "the composer's integration
// quick-actions... from the '+' menu" — this IS that menu). "capability"
// items bypass the chat LLM entirely via CommandService.submit, same
// pattern as the (now superseded) quick-action.ts.
export type ComposerShortcut =
  | {
      id: string;
      label: string;
      icon: LucideIcon;
      kind: "navigate";
      href: (projectId: string) => string;
    }
  | {
      id: string;
      label: string;
      icon: LucideIcon;
      kind: "capability";
      capability: CapabilityKey;
      request: string;
      targetPlatform?: SocialPlatform;
      // When set, the menu checks getPublishTargets for this platform
      // first — if it isn't connected, the item behaves as "navigate" to
      // the integrations page instead of firing a doomed task (see
      // composer-plus-menu.tsx).
      requiresConnectedPlatform?: "instagram" | "linkedin" | "x";
    };

const INTEGRATIONS_HREF = (projectId: string) =>
  `/projects/${projectId}/integrations`;

export const DEPARTMENT_SHORTCUTS: ComposerShortcut[] =
  ALL_DEPARTMENT_KEYS_UI.map((key) => ({
    id: `department-${key}`,
    label: DEPARTMENT_KEY[key].label,
    // EnumMeta.icon is optional in general, but every DEPARTMENT_KEY entry
    // sets one — Building2 is just a defensive fallback for the type.
    icon: DEPARTMENT_KEY[key].icon ?? Building2,
    kind: "navigate",
    href: (projectId: string) =>
      entityHref(projectId, { kind: "department", id: key }),
  }));

// Instagram/LinkedIn/X double as "Create {Platform} post" — the same
// CREATE_SOCIAL_CREATIVE quick action the old ChatQuickActions pill row
// offered, now folded in here. TikTok is deliberately absent from that
// trio: CREATE_SOCIAL_CREATIVE only produces an image, but TIKTOK_PUBLISH
// needs a video asset — a "create" shortcut here would make something that
// can never actually be published. The remaining integrations have no
// project-level connection status available cheaply on this component (only
// getPublishTargets' 4 social platforms are), so they just navigate to the
// integrations page rather than risk firing a task against an unconnected
// provider.
export const INTEGRATION_SHORTCUTS: ComposerShortcut[] = [
  {
    id: "integration-instagram",
    label: "Create Instagram post",
    icon: PURPOSE_ICONS.INSTAGRAM.icon,
    kind: "capability",
    capability: "CREATE_SOCIAL_CREATIVE",
    request: "Create an Instagram post",
    targetPlatform: "INSTAGRAM",
    requiresConnectedPlatform: "instagram",
  },
  {
    id: "integration-linkedin",
    label: "Create LinkedIn post",
    icon: PURPOSE_ICONS.LINKEDIN.icon,
    kind: "capability",
    capability: "CREATE_SOCIAL_CREATIVE",
    request: "Create a LinkedIn post",
    targetPlatform: "LINKEDIN",
    requiresConnectedPlatform: "linkedin",
  },
  {
    id: "integration-x",
    label: "Create X post",
    icon: PURPOSE_ICONS.X.icon,
    kind: "capability",
    capability: "CREATE_SOCIAL_CREATIVE",
    request: "Create an X post",
    targetPlatform: "X",
    requiresConnectedPlatform: "x",
  },
  {
    id: "integration-tiktok",
    label: "TikTok",
    icon: PURPOSE_ICONS.TIKTOK.icon,
    kind: "navigate",
    href: INTEGRATIONS_HREF,
  },
  {
    id: "integration-meta-ads",
    label: "Meta Ads",
    icon: PURPOSE_ICONS.META_ADS.icon,
    kind: "navigate",
    href: INTEGRATIONS_HREF,
  },
  {
    id: "integration-google-ads",
    label: "Google Ads",
    icon: PURPOSE_ICONS.GOOGLE_ADS.icon,
    kind: "navigate",
    href: INTEGRATIONS_HREF,
  },
  {
    id: "integration-ga4",
    label: "Google Analytics",
    icon: PURPOSE_ICONS.GA4.icon,
    kind: "navigate",
    href: INTEGRATIONS_HREF,
  },
  {
    id: "integration-search-console",
    label: "Search Console",
    icon: PURPOSE_ICONS.SEARCH_CONSOLE.icon,
    kind: "navigate",
    href: INTEGRATIONS_HREF,
  },
  {
    id: "integration-telegram",
    // Not a BrowserProfilePurpose, so it isn't in PURPOSE_ICONS — Send
    // matches the icon the integrations page itself uses for Telegram.
    label: "Telegram",
    icon: Send,
    kind: "navigate",
    href: INTEGRATIONS_HREF,
  },
  {
    id: "integration-crm",
    label: "CRM",
    icon: PURPOSE_ICONS.CRM.icon,
    kind: "navigate",
    href: INTEGRATIONS_HREF,
  },
  {
    id: "integration-email",
    label: "Email",
    icon: PURPOSE_ICONS.EMAIL.icon,
    kind: "navigate",
    href: INTEGRATIONS_HREF,
  },
];

const CAPABILITY_ICON: Partial<Record<CapabilityKey, LucideIcon>> = {
  CREATE_COPY: PenLine,
  CREATE_CAPTION: MessageSquareText,
  CREATE_CAMPAIGN_BRIEF: FileText,
  CREATE_CONTENT_PLAN: CalendarRange,
  CREATE_AD_CREATIVE: ImagePlus,
  COMPETITOR_RESEARCH: Swords,
  MARKET_RESEARCH: Globe2,
  TREND_RESEARCH: TrendingUp,
  CUSTOMER_INTELLIGENCE: HeartHandshake,
  PRODUCT_RESEARCH: PackageSearch,
  WEB_RESEARCH: Globe,
  SEO_RESEARCH: Search,
  SEO_ANALYSIS: SearchCheck,
  SOCIAL_RESEARCH: Share2,
  SOCIAL_PROFILE_AUDIT: BadgeCheck,
  SOCIAL_ACCOUNT_SETUP: UserPlus,
  EMAIL_DRAFT: Mail,
  REPORTING: BarChart3,
};

// The default brief sent as-is when the item is clicked — same "generic
// brief, let brand context fill in the rest" approach the CREATE_SOCIAL_
// CREATIVE quick action already proved out; the underlying capability
// handler already copes with a vague request the same way it does when a
// user types something equally short in chat.
const CAPABILITY_REQUEST: Partial<Record<CapabilityKey, string>> = {
  CREATE_COPY: "Write marketing copy",
  CREATE_CAPTION: "Write a social media caption",
  CREATE_CAMPAIGN_BRIEF: "Create a campaign brief",
  CREATE_CONTENT_PLAN: "Create a content plan",
  CREATE_AD_CREATIVE: "Create an ad creative",
  COMPETITOR_RESEARCH: "Research our competitors",
  MARKET_RESEARCH: "Research the market",
  TREND_RESEARCH: "Research current trends",
  CUSTOMER_INTELLIGENCE: "Analyze our customers",
  PRODUCT_RESEARCH: "Research the product",
  WEB_RESEARCH: "Research this on the web",
  SEO_RESEARCH: "Research SEO opportunities",
  SEO_ANALYSIS: "Run an SEO analysis",
  SOCIAL_RESEARCH: "Research our social media presence",
  SOCIAL_PROFILE_AUDIT: "Audit our social media profiles",
  SOCIAL_ACCOUNT_SETUP: "Set up a new social media account",
  EMAIL_DRAFT: "Draft an email",
  REPORTING: "Generate a performance report",
};

// chat-turn.ts's CHAT_CAPABILITIES minus: the 4 platform publish
// capabilities and META_ADS_ANALYSIS/GOOGLE_ADS_ANALYSIS/ANALYTICS_ANALYSIS
// (all live under "Integrations" above, or on the creative card's own
// "Share" button — publishing needs an existing creative, which this menu
// has no context for), and META_CAMPAIGN_CREATE (needs budget/targeting a
// generic brief can't carry — see command-service.ts's
// FORM_REQUIRED_CAPABILITIES; it's a plain navigate item below instead).
const CAPABILITY_SHORTCUT_KEYS: CapabilityKey[] = [
  "CREATE_COPY",
  "CREATE_CAPTION",
  "CREATE_CAMPAIGN_BRIEF",
  "CREATE_CONTENT_PLAN",
  "CREATE_AD_CREATIVE",
  "COMPETITOR_RESEARCH",
  "MARKET_RESEARCH",
  "TREND_RESEARCH",
  "CUSTOMER_INTELLIGENCE",
  "PRODUCT_RESEARCH",
  "WEB_RESEARCH",
  "SEO_RESEARCH",
  "SEO_ANALYSIS",
  "SOCIAL_RESEARCH",
  "SOCIAL_PROFILE_AUDIT",
  "SOCIAL_ACCOUNT_SETUP",
  "EMAIL_DRAFT",
  "REPORTING",
];

export const CAPABILITY_SHORTCUTS: ComposerShortcut[] = [
  ...CAPABILITY_SHORTCUT_KEYS.map((capability): ComposerShortcut => ({
    id: `capability-${capability}`,
    label: capabilityLabel(capability),
    icon: CAPABILITY_ICON[capability] ?? FileText,
    kind: "capability",
    capability,
    request: CAPABILITY_REQUEST[capability] ?? capabilityLabel(capability),
  })),
  // Same shape as command-service.ts's private adsFormHref — that file is
  // server-only, so this is a small client-side copy of the same URL.
  {
    id: "capability-META_CAMPAIGN_CREATE",
    label: capabilityLabel("META_CAMPAIGN_CREATE"),
    icon: Megaphone,
    kind: "navigate",
    href: (projectId: string) => `/projects/${projectId}/ads?create=campaign`,
  },
];

import type {
  CapabilityKey,
  DepartmentKey,
  SocialPlatform,
} from "@prisma/client";

import { DEPARTMENTS } from "@/server/agency/departments/department-registry";
import { isDepartmentInFocus } from "@/server/agency/agency-focus";

// What the chat agent can offer the client as a deliverable, and which
// department + capability produces it. One catalog shared by the model's
// context (so it proposes only what the agency can actually make), the
// propose_content_package tool (validation) and the package start action
// (which capability to queue) — so the three can never drift apart.

export const DELIVERABLE_KEYS = [
  "instagram_post",
  "seo_article",
  "reel_idea",
  "ad_copy",
  "email_draft",
] as const;
export type DeliverableKey = (typeof DELIVERABLE_KEYS)[number];

export type Deliverable = {
  key: DeliverableKey;
  // Plain-language name shown to the client.
  label: string;
  department: DepartmentKey;
  capability: CapabilityKey;
  // The channel the piece is made for (sizes the visual / frames the copy).
  platform?: SocialPlatform;
  // Social image deliverables need a format (Post 3:4 / Story / Reel / Square).
  needsFormat: boolean;
  // Instruction folded into the task brief so the worker knows the shape.
  brief: string;
};

export const DELIVERABLES: Record<DeliverableKey, Deliverable> = {
  instagram_post: {
    key: "instagram_post",
    label: "Instagram post",
    department: "CREATIVE",
    capability: "CREATE_SOCIAL_CREATIVE",
    platform: "INSTAGRAM",
    needsFormat: true,
    brief: "Instagram visual with a short caption",
  },
  seo_article: {
    key: "seo_article",
    label: "SEO article",
    department: "SEO",
    capability: "CREATE_COPY",
    needsFormat: false,
    brief:
      "SEO blog article: target keyword and search intent, an H1 plus H2 outline, then the full article (about 900-1200 words) with a meta title and meta description",
  },
  reel_idea: {
    key: "reel_idea",
    label: "Reel idea",
    department: "SOCIAL_MEDIA",
    capability: "CREATE_COPY",
    platform: "INSTAGRAM",
    needsFormat: false,
    brief:
      "Instagram Reel concept: the hook for the first 3 seconds, a short scene-by-scene script, on-screen text, and a caption",
  },
  ad_copy: {
    key: "ad_copy",
    label: "Ad copy",
    department: "PERFORMANCE_MARKETING",
    capability: "CREATE_COPY",
    needsFormat: false,
    brief:
      "Paid social ad copy: 3 headline variants, 3 primary-text variants and a call to action",
  },
  email_draft: {
    key: "email_draft",
    label: "Email draft",
    department: "COPY_CONTENT",
    capability: "EMAIL_DRAFT",
    needsFormat: false,
    brief: "Marketing email: subject line, preview text and body",
  },
};

// Formats an Instagram post deliverable may use (the client picks one).
export const INSTAGRAM_POST_FORMATS = [
  "FEED_PORTRAIT",
  "STORY",
  "REEL",
  "FEED_SQUARE",
] as const;

export function isDeliverableActive(key: DeliverableKey): boolean {
  return isDepartmentInFocus(DELIVERABLES[key].department);
}

export function activeDeliverables(): Deliverable[] {
  return DELIVERABLE_KEYS.filter(isDeliverableActive).map(
    (key) => DELIVERABLES[key],
  );
}

// The agency-capabilities block of the model's context: which departments
// are working and what each can hand the client right now.
export function buildAgencyCapabilities(connectedChannels: string[]) {
  return {
    activeDepartments: [
      ...new Set(activeDeliverables().map((d) => d.department)),
    ].map((key) => DEPARTMENTS[key].label),
    deliverables: activeDeliverables().map((d) => ({
      key: d.key,
      label: d.label,
      department: DEPARTMENTS[d.department].label,
      needsFormat: d.needsFormat,
    })),
    connectedChannels,
  };
}

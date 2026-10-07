import type { CmsSite, SeoChange } from "@prisma/client";

import type { SeoChangeView } from "./view-types";

// SC-F8: diğer paketlerin testlerinin kullandığı sabit satırlar. Saf nesne
// değişmezleri; üzerine yazma alanları verilerek özelleştirilir.

const NOW = new Date("2026-10-07T10:00:00.000Z");

export function changeFixture(overrides: Partial<SeoChange> = {}): SeoChange {
  return {
    id: "chg_1",
    workspaceId: "ws_1",
    projectId: "proj_1",
    siteId: "site_1",
    isMock: false,
    kind: "TITLE_META",
    status: "PROPOSED",
    source: "ACTION",
    title: "Change a page title and description on WordPress",
    targetUrl: "https://example.com/pricing",
    wpType: "page",
    wpId: 42,
    liveUrl: null,
    params: {
      kind: "TITLE_META",
      url: "https://example.com/pricing",
      wpType: "page",
      wpId: 42,
      expectModified: "2026-10-01T08:00:00.000Z",
      title: "Pricing for small teams",
      metaDescription: null,
    },
    before: null,
    after: null,
    dedupeKey: "meta:page:42",
    openKey: "meta:page:42",
    noop: false,
    seoActionId: null,
    creativeId: null,
    taskId: null,
    approvalId: null,
    proposedByType: "USER",
    proposedByUserId: "user_1",
    approvedByUserId: null,
    undoneByUserId: null,
    attempts: 0,
    nextAttemptAt: null,
    leaseUntil: null,
    leaseOwner: null,
    expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60_000),
    approvedAt: null,
    appliedAt: null,
    verifiedAt: null,
    rolledBackAt: null,
    failedAt: null,
    error: null,
    indexNow: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function siteFixture(overrides: Partial<CmsSite> = {}): CmsSite {
  return {
    id: "site_1",
    workspaceId: "ws_1",
    projectId: "proj_1",
    isMock: false,
    kind: "WORDPRESS",
    credentialId: "cred_1",
    origin: "https://example.com",
    restMode: "pretty",
    siteName: "Example",
    scopeKey: "VERIFIED_DOMAIN:example.com:",
    seoPlugin: "YOAST",
    seoFields: {
      plugin: "YOAST",
      titleVia: "META",
      descriptionVia: "META",
      verifiable: true,
    },
    capabilities: {
      draftPosts: true,
      publishPosts: true,
      editPublishedPosts: true,
      editPages: true,
      editPublishedPages: true,
      editOthers: true,
      deletePosts: true,
    },
    health: "OK",
    healthReason: null,
    lastCheckedAt: NOW,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export const viewFixtures = {
  change(overrides: Partial<SeoChangeView> = {}): SeoChangeView {
    return {
      id: "chg_1",
      kind: "TITLE_META",
      title: "Change a page title and description on WordPress",
      status: "PROPOSED",
      statusLabel: "Waiting for approval",
      source: "ACTION",
      createdAt: NOW.toISOString(),
      resolvedAt: null,
      expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
      approvalId: "apr_1",
      canDecide: true,
      canUndo: false,
      canMakeLive: false,
      undoWarning: null,
      noop: false,
      preview: [{ label: "Where", value: "example.com" }],
      link: null,
      draft: false,
      indexNow: null,
      error: null,
      ...overrides,
    };
  },
};

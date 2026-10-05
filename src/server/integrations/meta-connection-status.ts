import "server-only";

import { cache } from "react";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  instagramLoginExpired,
  resolveInstagramTarget,
} from "@/server/integrations/instagram-target";
import {
  META_PROVIDER,
  type MetaFacebookMetadata,
  type MetaInstagramMetadata,
} from "@/server/integrations/meta-client";

// Which of a project's accounts with a real OAuth connection can actually
// be published to — the SINGLE source of data that the "Share on Social
// Accounts" section on the creative card (see creative-card.tsx) lists
// (for Instagram, resolveInstagramTarget is the same check canExecute() in
// meta-api-provider.ts makes). Instagram needs either an account connected
// through Instagram Login or a selected Page with a linked account (Facebook
// Login); TikTok/LinkedIn/X have no extra selection step
// — a single ACTIVE IntegrationCredential is enough (see
// getSimpleCredentialTarget).
export type PublishTarget =
  | {
      platform: "instagram";
      // Unique key of the account on the creative card. The Facebook Page's id
      // on the Facebook route; the Instagram account's own id on Instagram Login.
      pageId: string;
      // The card's title: the Page's name, or "Instagram" on Instagram Login.
      pageName: string;
      igUsername?: string;
    }
  // The Page selected in the Facebook integration; accountLabel is its name.
  | { platform: "facebook"; pageId: string; accountLabel: string }
  | { platform: "tiktok"; accountLabel: string }
  | { platform: "linkedin"; accountLabel: string }
  | { platform: "x"; accountLabel: string };

// What a target is built from: never the secret itself.
type CredentialRow = {
  status: string;
  metadata: Prisma.JsonValue | null;
  accountLabel: string | null;
};

function instagramTargetsOf(
  credential: CredentialRow | undefined,
): PublishTarget[] {
  if (!credential || credential.status !== "ACTIVE") return [];

  const metadata = (credential.metadata ?? {}) as MetaInstagramMetadata;
  // The Connectors tile already calls an Instagram Login connection past its 60
  // days "Needs reconnection"; every other view (creative card, plan card, Works
  // Post now, autopublish) reads this list, so it must agree rather than offer a
  // publish that Meta will refuse.
  if (instagramLoginExpired(metadata)) return [];
  const target = resolveInstagramTarget(metadata);
  if (!target) return [];

  return [
    {
      platform: "instagram",
      pageId: target.pageId ?? target.igUserId,
      // The creative card prints igUsername as the subtitle, so on the Page-less
      // route the title is just "Instagram" (the handle would otherwise show twice).
      pageName: target.pageName ?? "Instagram",
      igUsername: target.username,
    },
  ];
}

// Facebook needs a Page selected in its own integration (the Page the posts go
// to); a Page picked in the Instagram or Meta Ads connection does not count.
function facebookTargetOf(
  credential: CredentialRow | null | undefined,
): Extract<PublishTarget, { platform: "facebook" }> | null {
  if (!credential || credential.status !== "ACTIVE") return null;
  const metadata = (credential.metadata ?? {}) as Partial<MetaFacebookMetadata>;
  const page = metadata.pages?.find(
    (p) => p.pageId === metadata.selectedPageId,
  );
  if (!page) return null;
  return {
    platform: "facebook",
    pageId: page.pageId,
    accountLabel: page.pageName,
  };
}

export async function getFacebookPublishTarget(
  projectId: string,
): Promise<Extract<PublishTarget, { platform: "facebook" }> | null> {
  const credential = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId, provider: META_PROVIDER.facebook },
    },
  });
  return facebookTargetOf(credential);
}

// For each of TikTok/LinkedIn/X, simply being ACTIVE on the
// IntegrationCredential is considered a sufficient target — unlike
// Instagram, there's no extra "which Page/account is selected" step, since
// the OAuth connection already links to a single user account.
function simpleTargetOf(
  credential: CredentialRow | undefined,
  provider: "tiktok" | "linkedin" | "x",
): PublishTarget | null {
  if (!credential || credential.status !== "ACTIVE") return null;
  return {
    platform: provider,
    accountLabel: credential.accountLabel ?? provider,
  } as PublishTarget;
}

const TARGET_PROVIDERS = [
  META_PROVIDER.instagram,
  "tiktok",
  "linkedin",
  "x",
  META_PROVIDER.facebook,
];

// One read for every provider (it used to be one per provider, each with the
// encrypted secret), and request-scoped: the chat page asks for the targets
// from several places (the page, the pending decisions, the channel
// connections the journey and the overlays read) and they share this result.
// Outside a server render cache() is a pass-through.
export const getPublishTargets = cache(
  async (projectId: string): Promise<PublishTarget[]> => {
    const rows = await prisma.integrationCredential.findMany({
      where: { projectId, provider: { in: TARGET_PROVIDERS } },
      select: {
        provider: true,
        status: true,
        metadata: true,
        accountLabel: true,
      },
    });
    const byProvider = new Map(rows.map((row) => [row.provider, row] as const));
    // Facebook last: the first entry is a project's primary platform for image
    // sizing (work-plan-builder.ts), and connecting Facebook must not change it
    // for a project that already publishes elsewhere.
    return [
      ...instagramTargetsOf(byProvider.get(META_PROVIDER.instagram)),
      simpleTargetOf(byProvider.get("tiktok"), "tiktok"),
      simpleTargetOf(byProvider.get("linkedin"), "linkedin"),
      simpleTargetOf(byProvider.get("x"), "x"),
      facebookTargetOf(byProvider.get(META_PROVIDER.facebook)),
    ].filter((t): t is PublishTarget => t !== null);
  },
);

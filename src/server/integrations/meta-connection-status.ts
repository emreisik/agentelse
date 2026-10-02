import "server-only";

import { prisma } from "@/lib/prisma";
import { resolveInstagramTarget } from "@/server/integrations/instagram-target";
import {
  META_PROVIDER,
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
  | { platform: "tiktok"; accountLabel: string }
  | { platform: "linkedin"; accountLabel: string }
  | { platform: "x"; accountLabel: string };

async function getInstagramTargets(
  projectId: string,
): Promise<PublishTarget[]> {
  const credential = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId, provider: META_PROVIDER.instagram },
    },
  });
  if (!credential || credential.status !== "ACTIVE") return [];

  const target = resolveInstagramTarget(
    (credential.metadata ?? {}) as MetaInstagramMetadata,
  );
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

// For each of TikTok/LinkedIn/X, simply being ACTIVE on the
// IntegrationCredential is considered a sufficient target — unlike
// Instagram, there's no extra "which Page/account is selected" step, since
// the OAuth connection already links to a single user account.
async function getSimpleCredentialTarget(
  projectId: string,
  provider: "tiktok" | "linkedin" | "x",
): Promise<PublishTarget | null> {
  const credential = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider } },
  });
  if (!credential || credential.status !== "ACTIVE") return null;
  return {
    platform: provider,
    accountLabel: credential.accountLabel ?? provider,
  } as PublishTarget;
}

export async function getPublishTargets(
  projectId: string,
): Promise<PublishTarget[]> {
  const [instagram, tiktok, linkedin, x] = await Promise.all([
    getInstagramTargets(projectId),
    getSimpleCredentialTarget(projectId, "tiktok"),
    getSimpleCredentialTarget(projectId, "linkedin"),
    getSimpleCredentialTarget(projectId, "x"),
  ]);
  return [...instagram, tiktok, linkedin, x].filter(
    (t): t is PublishTarget => t !== null,
  );
}

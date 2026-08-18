import "server-only";

import { prisma } from "@/lib/prisma";
import type { MetaCredentialMetadata } from "@/server/integrations/meta-client";

// Which of a project's accounts with a real OAuth connection can actually
// be published to — the SINGLE source of data that the "Share on Social
// Accounts" section on the creative card (see creative-card.tsx) lists
// (for Instagram, the metadata.pages matching logic is the same as
// canExecute() in meta-api-provider.ts). Instagram requires being linked
// to a selected Meta Page; TikTok/LinkedIn/X have no extra selection step
// — a single ACTIVE IntegrationCredential is enough (see
// getSimpleCredentialTarget).
export type PublishTarget =
  | {
      platform: "instagram";
      pageId: string;
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
    where: { projectId_provider: { projectId, provider: "meta" } },
  });
  if (!credential || credential.status !== "ACTIVE") return [];

  const metadata = (credential.metadata ?? {}) as MetaCredentialMetadata;
  const page = metadata.pages?.find(
    (p) => p.pageId === metadata.selectedPageId,
  );
  if (!page?.instagramBusinessAccountId) return [];

  return [
    {
      platform: "instagram",
      pageId: page.pageId,
      pageName: page.pageName,
      igUsername: page.instagramUsername,
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

export async function hasPublishableInstagramConnection(
  projectId: string,
): Promise<boolean> {
  return (await getPublishTargets(projectId)).length > 0;
}

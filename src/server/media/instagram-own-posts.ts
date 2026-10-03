import "server-only";

import { prisma } from "@/lib/prisma";
import {
  instagramAccessFor,
  instagramLoginExpired,
  resolveInstagramTarget,
} from "@/server/integrations/instagram-target";
import {
  META_PROVIDER,
  fetchInstagramRecentMedia,
  type InstagramMediaItem,
  type MetaInstagramMetadata,
} from "@/server/integrations/meta-client";
import { decryptSecret } from "@/server/security/crypto";

// The project's own recent Instagram posts, read through the official API with
// the project's Instagram connection (either route). Replaces reading
// instagram.com pages, which Meta's terms do not allow: only the connected
// account's posts can be read this way, so inspiration from other accounts goes
// through an uploaded style reference instead.

// More than are analysed, so a video without a thumbnail does not leave the
// analysis short.
const FETCH_LIMIT = 12;

export type OwnInstagramPosts =
  | {
      ok: true;
      username?: string;
      posts: Array<InstagramMediaItem & { imageUrl: string }>;
    }
  | { ok: false; reason: string };

export async function loadOwnInstagramPosts(
  projectId: string,
  count: number,
): Promise<OwnInstagramPosts> {
  const credential = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId, provider: META_PROVIDER.instagram },
    },
  });
  const metadata = (credential?.metadata ??
    null) as Partial<MetaInstagramMetadata> | null;
  const target = resolveInstagramTarget(metadata);
  if (
    !credential ||
    credential.status !== "ACTIVE" ||
    instagramLoginExpired(metadata) ||
    !target
  ) {
    return {
      ok: false,
      reason: "Connect your Instagram account in Connectors first.",
    };
  }

  const access = await instagramAccessFor(
    target,
    decryptSecret(credential.encryptedSecret),
  );
  const media = await fetchInstagramRecentMedia({
    igUserId: target.igUserId,
    accessToken: access.accessToken,
    api: access.api,
    limit: FETCH_LIMIT,
  });
  const posts = media
    .filter((item): item is InstagramMediaItem & { imageUrl: string } =>
      Boolean(item.imageUrl),
    )
    .slice(0, count);
  if (posts.length === 0) {
    return {
      ok: false,
      reason: "Your Instagram account has no posts with an image yet.",
    };
  }
  return { ok: true, username: target.username, posts };
}

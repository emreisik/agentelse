import "server-only";

import type { Prisma } from "@prisma/client";

import { isChannelKey } from "@/lib/content-channels";
import { prisma } from "@/lib/prisma";
import {
  ADS_LIMITS,
  adTextFrom,
  clipWords,
  type AdsSource,
  type AdsSourcePost,
} from "@/lib/module-flows/ads/state";

// The posts an ad can be made from: the project's approved or published pieces
// that have a picture (the ad uses it as is, nothing new is drawn), newest
// first, one per post (its feed picture before its Story).

export const MAX_SOURCE_POSTS = 12;
const CANDIDATES = 48;
const BOOSTABLE = ["APPROVED", "PUBLISHED"] as const;

const SELECT = {
  id: true,
  title: true,
  status: true,
  channel: true,
  formatKey: true,
  postId: true,
  versions: {
    orderBy: { version: "desc" },
    take: 1,
    select: {
      caption: true,
      copy: true,
      contentFormat: true,
      asset: { select: { id: true, mimeType: true, storageKey: true } },
    },
  },
} satisfies Prisma.CreativeSelect;

type Row = Prisma.CreativeGetPayload<{ select: typeof SELECT }>;

type Candidate = {
  post: AdsSourcePost;
  source: AdsSource;
  group: string;
  story: boolean;
};

function candidateOf(row: Row): Candidate | null {
  if (row.status !== "APPROVED" && row.status !== "PUBLISHED") return null;
  const version = row.versions[0];
  const asset = version?.asset;
  if (
    !version ||
    !asset ||
    !asset.mimeType.startsWith("image/") ||
    asset.storageKey.startsWith("mock://")
  ) {
    return null;
  }
  const caption = (version.caption ?? version.copy ?? "").trim();
  const title =
    clipWords(row.title ?? "", 80) ||
    clipWords(adTextFrom(caption), 60, true) ||
    "Untitled post";
  return {
    post: {
      creativeId: row.id,
      assetId: asset.id,
      title,
      status: row.status,
      ...(isChannelKey(row.channel) ? { channel: row.channel } : {}),
    },
    source: {
      creativeId: row.id,
      assetId: asset.id,
      title: clipWords(title, ADS_LIMITS.title),
      ...(caption ? { caption: caption.slice(0, ADS_LIMITS.caption) } : {}),
    },
    group: row.postId ?? row.id,
    story:
      version.contentFormat === "STORY" ||
      Boolean(row.formatKey?.endsWith(".story")),
  };
}

// One per post: the newest delivery, a feed one replacing a Story.
function onePerPost(rows: readonly Row[]): Candidate[] {
  const order: string[] = [];
  const chosen = new Map<string, Candidate>();
  for (const row of rows) {
    const candidate = candidateOf(row);
    if (!candidate) continue;
    const current = chosen.get(candidate.group);
    if (!current) {
      order.push(candidate.group);
      chosen.set(candidate.group, candidate);
    } else if (current.story && !candidate.story) {
      chosen.set(candidate.group, candidate);
    }
  }
  return order.map((group) => chosen.get(group)!);
}

async function findCandidate(
  projectId: string,
  creativeId: string,
): Promise<Candidate | null> {
  const row = await prisma.creative.findFirst({
    where: {
      id: creativeId,
      projectId,
      status: { in: [...BOOSTABLE] },
      excludedAt: null,
    },
    select: SELECT,
  });
  return row ? candidateOf(row) : null;
}

// The Brief's picker. `include`: a post that must be offered even when it is
// older than the newest ones (the hinted or already chosen post).
export async function listSourcePosts(
  projectId: string,
  options: { include?: string } = {},
): Promise<AdsSourcePost[]> {
  const rows = await prisma.creative.findMany({
    where: {
      projectId,
      status: { in: [...BOOSTABLE] },
      excludedAt: null,
    },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES,
    select: SELECT,
  });
  const posts = onePerPost(rows)
    .slice(0, MAX_SOURCE_POSTS)
    .map((candidate) => candidate.post);
  const include = options.include;
  if (include && !posts.some((post) => post.creativeId === include)) {
    const extra = await findCandidate(projectId, include);
    if (extra) return [extra.post, ...posts].slice(0, MAX_SOURCE_POSTS);
  }
  return posts;
}

// The post an ad is made from, checked again when the Brief is saved.
export async function findSourcePost(
  projectId: string,
  creativeId: string,
): Promise<AdsSource | null> {
  return (await findCandidate(projectId, creativeId))?.source ?? null;
}

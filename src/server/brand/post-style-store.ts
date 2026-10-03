import "server-only";

import { prisma } from "@/lib/prisma";
import {
  DIRECTIVES_KEY,
  EXAMPLE_KEY_PREFIX,
  POST_STYLE_CATEGORY,
  buildPostStyleContext,
  exampleKey,
  parseDirectives,
  parseExample,
  type PostStyleContext,
  type PostStyleDirectives,
  type PostStyleExample,
} from "@/lib/post-style";

// The Post Style Kit lives in BrandFact rows of one category (no schema change;
// see lib/post-style.ts). Readers of BrandFact that list a brand's knowledge
// filter this category out.

export type PostStyleScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type PostStyleKit = {
  directives: PostStyleDirectives;
  examples: PostStyleExample[];
};

export async function loadPostStyle(brandId: string): Promise<PostStyleKit> {
  const rows = await prisma.brandFact.findMany({
    where: { brandId, category: POST_STYLE_CATEGORY },
    orderBy: { createdAt: "asc" },
    select: { key: true, value: true },
  });
  let directives = parseDirectives(null);
  const examples: PostStyleExample[] = [];
  for (const row of rows) {
    if (row.key === DIRECTIVES_KEY) {
      directives = parseDirectives(row.value);
    } else if (row.key.startsWith(EXAMPLE_KEY_PREFIX)) {
      const example = parseExample(row.value);
      if (example) examples.push(example);
    }
  }
  return { directives, examples };
}

// What a generation reads; null when the kit holds nothing a render could use.
export async function loadPostStyleContext(
  brandId: string,
): Promise<PostStyleContext | null> {
  const kit = await loadPostStyle(brandId);
  return buildPostStyleContext(kit);
}

async function writeRow(
  scope: PostStyleScope,
  key: string,
  value: unknown,
): Promise<void> {
  const existing = await prisma.brandFact.findFirst({
    where: { brandId: scope.brandId, category: POST_STYLE_CATEGORY, key },
    select: { id: true },
  });
  if (existing) {
    await prisma.brandFact.update({
      where: { id: existing.id },
      data: { value: value as never },
    });
    return;
  }
  await prisma.brandFact.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
      category: POST_STYLE_CATEGORY,
      key,
      value: value as never,
      source: "post-style",
    },
  });
}

export async function saveExample(
  scope: PostStyleScope,
  example: PostStyleExample,
): Promise<void> {
  await writeRow(scope, exampleKey(example.assetId), example);
}

export async function saveDirectives(
  scope: PostStyleScope,
  directives: PostStyleDirectives,
): Promise<void> {
  await writeRow(scope, DIRECTIVES_KEY, directives);
}

export async function getExample(
  brandId: string,
  assetId: string,
): Promise<PostStyleExample | null> {
  const row = await prisma.brandFact.findFirst({
    where: {
      brandId,
      category: POST_STYLE_CATEGORY,
      key: exampleKey(assetId),
    },
    select: { value: true },
  });
  return row ? parseExample(row.value) : null;
}

export async function removeExample(
  brandId: string,
  assetId: string,
): Promise<boolean> {
  const removed = await prisma.brandFact.deleteMany({
    where: {
      brandId,
      category: POST_STYLE_CATEGORY,
      key: exampleKey(assetId),
    },
  });
  return removed.count > 0;
}

export async function countExamples(brandId: string): Promise<number> {
  return prisma.brandFact.count({
    where: {
      brandId,
      category: POST_STYLE_CATEGORY,
      key: { startsWith: EXAMPLE_KEY_PREFIX },
    },
  });
}

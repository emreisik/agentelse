import "server-only";

import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";

// The reusable store for "what a web page said". Every system that reads a
// brand's pages (the first brand scan, a later research turn, deep discovery)
// goes through Evidence instead of fetching again on its own: the same page is
// not downloaded and paid for twice, and the text an answer was based on stays
// on record with where and when it was read. Freshness is decided by the
// caller: a page read within `maxAgeMs` is reused; older or missing is fetched
// again; a user asking for fresh research simply passes 0.

export type PageScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type PageEvidence = {
  id: string;
  url: string;
  title: string | null;
  text: string;
};

// Long enough for any single page a scan reads, short enough that a huge page
// cannot bloat the table.
const MAX_STORED_CHARS = 20_000;

export function contentHashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// The newest evidence for this exact URL read within `maxAgeMs`, or null.
export async function findFreshPageEvidence(
  projectId: string,
  url: string,
  maxAgeMs: number,
): Promise<PageEvidence | null> {
  if (maxAgeMs <= 0) return null;
  const row = await prisma.evidence.findFirst({
    where: {
      projectId,
      sourceType: "WEB_PAGE",
      sourceUrl: url,
      accessedAt: { gte: new Date(Date.now() - maxAgeMs) },
      extractedText: { not: null },
    },
    orderBy: { accessedAt: "desc" },
    select: { id: true, sourceUrl: true, pageTitle: true, extractedText: true },
  });
  if (!row || !row.extractedText) return null;
  return {
    id: row.id,
    url: row.sourceUrl ?? url,
    title: row.pageTitle,
    text: row.extractedText,
  };
}

// Stores what a page said. The same content read again refreshes the existing
// row's access time instead of adding a copy, so re-reading an unchanged page
// costs nothing but a timestamp.
export async function recordPageEvidence(
  scope: PageScope,
  page: { url: string; title?: string; text: string },
): Promise<string> {
  const text = page.text.slice(0, MAX_STORED_CHARS);
  const contentHash = contentHashOf(text);

  const existing = await prisma.evidence.findFirst({
    where: {
      projectId: scope.projectId,
      sourceType: "WEB_PAGE",
      sourceUrl: page.url,
      contentHash,
    },
    select: { id: true },
  });
  if (existing) {
    await prisma.evidence.update({
      where: { id: existing.id },
      data: { accessedAt: new Date() },
    });
    return existing.id;
  }

  const created = await prisma.evidence.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
      sourceType: "WEB_PAGE",
      sourceUrl: page.url,
      pageTitle: page.title,
      extractedText: text,
      contentHash,
      accessedAt: new Date(),
    },
    select: { id: true },
  });
  return created.id;
}

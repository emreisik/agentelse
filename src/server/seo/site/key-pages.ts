import "server-only";

import type { SeoSite } from "@prisma/client";

import { KEY_PAGE_COUNT } from "@/lib/seo/audit-constants";
import {
  crawlUrlHash,
  inScope,
  normalizeCrawlUrl,
  pathOf,
  startUrlFor,
} from "@/lib/seo/crawl-url";
import { addWeeks, lastCompleteWeekStart } from "@/lib/seo/dates";
import { GscFlags } from "@/lib/seo/flags";
import { prisma } from "@/lib/prisma";
import {
  gscDataThrough,
  primaryGscLink,
  readTopPages,
} from "@/server/seo/store";

import { parseStoredScope } from "./scope";

// Kilit sayfalar (docs/search-health.md "Gerileme bekçisi"): ana sayfa + son
// 4 tam PT haftasında en çok tıklanan 20 sayfa (GSC yalnız sıralama için;
// maskeli "[" içeren ve kapsam dışı adresler atlanır). GSC yoksa en çok iç
// link alan 20 indekslenebilir 200 sayfa. En çok 21, urlHash'e göre tekil.
// Yalnız köken alan adının adresleri: bekçi başka alan adını getirmez.

export type KeyPage = {
  url: string;
  urlHash: string;
  path: string;
  isHomepage: boolean;
  source: "HOME" | "GSC_CLICKS" | "INLINKS";
};

const LOST_LINK_HEALTH = new Set(["GONE", "ACCESS_LOST"]);
const GSC_CANDIDATES = 60;
const INLINK_CANDIDATES = 60;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function gscClickUrls(projectId: string): Promise<string[] | null> {
  if (!GscFlags.sync()) return null;
  const link = await primaryGscLink(projectId);
  if (!link || LOST_LINK_HEALTH.has(link.health)) return null;
  const { finalThrough } = await gscDataThrough(link.id);
  if (!finalThrough) return null;
  const to = lastCompleteWeekStart(finalThrough);
  const rows = await readTopPages(
    link.id,
    { from: addWeeks(to, -3), to },
    { limit: GSC_CANDIDATES },
  );
  const urls = rows
    .filter((row) => row.clicks > 0)
    .map((row) => row.url)
    .filter((url): url is string => typeof url === "string");
  return urls.length > 0 ? urls : null;
}

export async function keyPagesFor(
  site: Pick<SeoSite, "id" | "projectId" | "origin" | "scope">,
  now: Date = new Date(),
): Promise<KeyPage[]> {
  void now;
  const scope = parseStoredScope(site.scope);
  if (!scope) return [];
  // URL önekli mülkte başlangıç her zaman önektir (kökün "/"si kapsam dışı).
  let start =
    scope.kind === "GSC_PREFIX"
      ? scope.prefix
      : site.origin
        ? `${site.origin}/`
        : null;
  if (!start) {
    const project = await prisma.project.findUnique({
      where: { id: site.projectId },
      select: { domain: true },
    });
    start = startUrlFor(scope, project?.domain ?? null);
  }
  const home = normalizeCrawlUrl(start);
  if (!home) return [];
  const originHost = hostOf(home);
  const pages: KeyPage[] = [];
  const seen = new Set<string>();
  const push = (url: string, source: KeyPage["source"]) => {
    if (pages.length > KEY_PAGE_COUNT) return;
    const normalized = normalizeCrawlUrl(url);
    if (!normalized || !inScope(normalized, scope)) return;
    if (hostOf(normalized) !== originHost) return;
    const urlHash = crawlUrlHash(normalized);
    if (seen.has(urlHash)) return;
    seen.add(urlHash);
    pages.push({
      url: normalized,
      urlHash,
      path: pathOf(normalized),
      isHomepage: source === "HOME",
      source,
    });
  };
  push(home, "HOME");

  const gscUrls = await gscClickUrls(site.projectId).catch(() => null);
  if (gscUrls) {
    for (const url of gscUrls) {
      if (url.includes("[")) continue;
      push(url, "GSC_CLICKS");
    }
    return pages;
  }

  const rows = await prisma.seoPage.findMany({
    where: { siteId: site.id, status: 200, indexable: true, goneAt: null },
    orderBy: [{ inlinks: "desc" }, { url: "asc" }],
    take: INLINK_CANDIDATES,
    select: { url: true },
  });
  for (const row of rows) push(row.url, "INLINKS");
  return pages;
}

import "server-only";

import { metaFetch } from "./graph";

// Sayfalı okuma (docs/meta-ads-plan.md §3.1 Sayfalama). `paging.next` hazır
// bir URL'dir (token dahil). Sınır aşılırsa kırpma loglanır: sessiz eksik veri
// yok.
export async function requestPages<T>(
  url: string,
  options: { maxPages?: number; label?: string } = {},
): Promise<{ items: T[]; truncated: boolean }> {
  const maxPages = options.maxPages ?? 10;
  const items: T[] = [];
  let next: string | undefined = url;
  let pages = 0;
  while (next && pages < maxPages) {
    const body: { data?: T[]; paging?: { next?: string } } =
      await metaFetch(next);
    items.push(...(body.data ?? []));
    next = body.paging?.next;
    pages += 1;
  }
  const truncated = Boolean(next);
  if (truncated) {
    console.warn(
      `[meta-paging] ${options.label ?? "listing"} truncated after ${maxPages} pages`,
    );
  }
  return { items, truncated };
}

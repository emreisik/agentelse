// CMS yolunun öğe kaydı (GscSplitTest.cmsChanges) için saf yardımcılar.
// Veritabanına ve SC-F8 koduna dokunmaz; doğrulayıcı ve değerlendirici bunu
// ağır içe aktarmalar olmadan kullanır.

type RawItem = { pageId?: unknown; changeId?: unknown; skipped?: unknown };

function itemsOf(raw: unknown): RawItem[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is RawItem =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

export function changeIdsOf(raw: unknown): string[] {
  const ids: string[] = [];
  for (const item of itemsOf(raw)) {
    if (typeof item.changeId === "string" && item.changeId) {
      ids.push(item.changeId);
    }
  }
  return ids;
}

// Değişikliği hiç yapılmamış (atlanmış ya da başarısız) TEST sayfaları.
// Değerlendirme bunları kolun dışında tutar; yoksa etkiyi seyreltirler.
export function cmsUntreatedPageIds(raw: unknown): Set<string> {
  const out = new Set<string>();
  for (const item of itemsOf(raw)) {
    if (typeof item.pageId !== "string") continue;
    if (item.skipped !== null && item.skipped !== undefined) {
      out.add(item.pageId);
    }
  }
  return out;
}

// Başarısız olan değişikliklerin öğelerini "FAILED" olarak işaretler; sonraki
// değerlendirme o sayfaları da kolun dışında bırakır.
export function markCmsFailed(
  raw: unknown,
  failedChangeIds: readonly string[],
): { v: 1; items: unknown[] } {
  const failed = new Set(failedChangeIds);
  return {
    v: 1,
    items: itemsOf(raw).map((item) =>
      typeof item.changeId === "string" && failed.has(item.changeId)
        ? { ...item, changeId: null, skipped: "FAILED" }
        : item,
    ),
  };
}

// The "Meta said: ..." line under a failed connection. The text comes from the URL
// (the OAuth callback puts Meta's own error there), and the URL is not signed, so a
// crafted link could make the app's error banner say anything. It is therefore shown
// only for the one error the callback attaches it to, and capped.
export const MAX_META_DETAIL_LENGTH = 200;

export function visibleMetaDetail(
  metaError: string | null,
  detail: unknown,
): string | null {
  if (metaError !== "exchange_failed") return null;
  if (typeof detail !== "string" || !detail.trim()) return null;
  return detail.slice(0, MAX_META_DETAIL_LENGTH);
}

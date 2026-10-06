// Platform kotasının (kod 4, kullanıcı token'lı Graph çağrıları) asıl
// tüketicisini bulmak için X-App-Usage çağrı noktası etiketiyle loglanır
// (docs/meta-ads-plan.md F1). Çağrı noktası başına dakikada en fazla bir
// satır; Railway logunda `[meta-usage]` ile aranır.

const lastLoggedAt = new Map<string, number>();
const LOG_EVERY_MS = 60_000;

export function logAppUsage(
  callSite: string,
  headers: { get(name: string): string | null },
  now: number = Date.now(),
): void {
  const raw = headers.get("x-app-usage");
  if (!raw) return;
  const last = lastLoggedAt.get(callSite) ?? 0;
  if (now - last < LOG_EVERY_MS) return;
  lastLoggedAt.set(callSite, now);
  console.log(`[meta-usage] site=${callSite} app=${raw}`);
}

// URL'den kaba bir çağrı noktası etiketi: kimlikler atılır.
// "/v26.0/act_123/insights" -> "act/insights", "/v26.0/me/accounts" -> "me/accounts".
export function callSiteFromUrl(url: string): string {
  try {
    const { pathname } = new URL(url);
    return (
      pathname
        .split("/")
        .filter(Boolean)
        .slice(1)
        .map((part) =>
          part.startsWith("act_") ? "act" : /^\d+$/.test(part) ? "id" : part,
        )
        .join("/") || "root"
    );
  } catch {
    return "unknown";
  }
}

// Meta Ads bağlantısının uzun ömürlü token'ı ~60 günde sessizce düşer; kutucuk
// kalan süreyi söyler (docs/meta-ads-plan.md F0b). Callback'in zaten yazdığı
// `longLivedTokenExpiresAt` değerinden okunur.

const DAY_MS = 24 * 60 * 60_000;

export type TokenExpiry = {
  text: string;
  // 7 günden az kaldıysa ya da geçtiyse dikkat çekilir.
  urgent: boolean;
};

export function tokenExpiry(
  expiresAt: string | null | undefined,
  now: Date,
): TokenExpiry | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  const days = Math.floor((at - now.getTime()) / DAY_MS);
  if (at <= now.getTime()) {
    return { text: "Access expired. Reconnect to keep managing ads.", urgent: true };
  }
  if (days < 1) return { text: "Access expires today. Reconnect now.", urgent: true };
  return {
    text: `Access expires in ${days} day${days === 1 ? "" : "s"}.`,
    urgent: days < 7,
  };
}

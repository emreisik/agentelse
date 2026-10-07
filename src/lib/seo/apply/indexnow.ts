// SC-F8: IndexNow (Bing, Yandex ve katılımcı arama motorları; Google değil)
// için saf yardımcılar. Anahtar dosyası kullanıcı tarafından siteye konur;
// bildirim yalnız herkese açık adresler içindir.

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow" as const;
export const INDEXNOW_MAX_URLS_PER_CHANGE = 5 as const;
// Proje başına en çok 10 dakikada bir bildirim.
export const INDEXNOW_MIN_GAP_MS = 10 * 60_000;

// 16 rastgele bayt -> 32 küçük harfli onaltılık hane. Rastgelelik dışarıdan
// verilir (testler belirleyici kalır).
export function generateIndexNowKey(
  randomBytes: (n: number) => Uint8Array,
): string {
  return Array.from(randomBytes(16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function isValidIndexNowKey(key: unknown): key is string {
  return typeof key === "string" && /^[A-Za-z0-9-]{8,128}$/.test(key);
}

export function indexNowKeyUrl(host: string, key: string): string {
  return `https://${host}/${key}.txt`;
}

// Yalnız https ve aynı alan adı; tekrarlar atılır, en çok 5 adres. Geçerli
// adres kalmazsa null.
export function buildIndexNowBody(input: {
  host: string;
  key: string;
  urls: readonly string[];
}): { host: string; key: string; keyLocation: string; urlList: string[] } | null {
  if (!isValidIndexNowKey(input.key)) return null;
  const host = input.host.trim().toLowerCase();
  if (!host) return null;
  const urlList: string[] = [];
  for (const raw of input.urls) {
    if (urlList.length >= INDEXNOW_MAX_URLS_PER_CHANGE) break;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" || parsed.host.toLowerCase() !== host) {
      continue;
    }
    parsed.hash = "";
    const url = parsed.href;
    if (!urlList.includes(url)) urlList.push(url);
  }
  if (urlList.length === 0) return null;
  return {
    host,
    key: input.key,
    keyLocation: indexNowKeyUrl(host, input.key),
    urlList,
  };
}

export function indexNowOutcome(
  status: number,
): "SENT" | "KEY_INVALID" | "URL_MISMATCH" | "RATE_LIMITED" | "FAILED" {
  if (status === 200 || status === 202) return "SENT";
  if (status === 403) return "KEY_INVALID";
  if (status === 422) return "URL_MISMATCH";
  if (status === 429) return "RATE_LIMITED";
  return "FAILED";
}

// Anahtar dosyasının gövdesi anahtara eşit olmalı (baştaki/sondaki boşluk yok sayılır).
export function keyFileMatches(body: string, key: string): boolean {
  return key.length > 0 && body.trim() === key;
}

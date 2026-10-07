// Agentelse UTM standardı (GA-F6, GA_UTM; docs/website-attribution.md).
// Saf ve izomorfik: Agentelse'in dış linklere (Meta reklamı, Instagram bio
// linki) koyduğu etiketlerin tek tanımı. Kampanya adı `agx-<slug>`, içerik
// `agx_<6 karakter kod>`; GA4'te sessionManualAdContent olarak geri gelir.
//
// Kurallar: yalnız projenin kendi alan adlarına giden http(s) linkler
// etiketlenir; var olan utm_* değeri hiç ezilmez; iç linkler etiketlenmez.
// Sorgu metni URLSearchParams ile yeniden kurulmaz (Meta'nın
// `{{site_source_name}}` makrosu bozulurdu); ham metne `&anahtar=değer`
// eklenir.

import { isValidDomain, normalizeDomain } from "@/lib/domain";
import { foldForMatch } from "@/lib/text-fold";

export const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type UtmParams = Partial<Record<UtmKey, string>>;

export const UTM_CHANNELS = [
  "meta_ads",
  "facebook",
  "instagram",
  "linkedin",
  "x",
  "tiktok",
] as const;
export type UtmChannel = (typeof UTM_CHANNELS)[number];

export const AGX_CAMPAIGN_PREFIX = "agx-";
export const AGX_CONTENT_PREFIX = "agx_";
export const AGX_BIO_CAMPAIGN = "agx-bio";
// Meta dinamik URL parametresi: reklamın gösterildiği yerleşim (facebook, instagram...).
export const META_SITE_SOURCE_MACRO = "{{site_source_name}}";

const CAMPAIGN_SLUG_MAX = 40;
const CODE_PATTERN = /^agx_([a-z0-9]{6})$/i;
const MACRO_PATTERN = /^\{\{[^{}]+\}\}$/;

// Kampanya adı: katlanmış, [^a-z0-9] öbekleri "-", baştaki "agx-" atılır
// (fonksiyon kendi çıktısı üzerinde de aynı sonucu verir).
export function agxCampaignName(name: string): string {
  let slug = foldForMatch(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  while (slug.startsWith(AGX_CAMPAIGN_PREFIX)) {
    slug = slug.slice(AGX_CAMPAIGN_PREFIX.length).replace(/^-+/, "");
  }
  if (slug.length > CAMPAIGN_SLUG_MAX) {
    const head = slug.slice(0, CAMPAIGN_SLUG_MAX);
    if (slug[CAMPAIGN_SLUG_MAX] === "-") {
      slug = head;
    } else {
      const cut = head.lastIndexOf("-");
      slug = cut > 0 ? head.slice(0, cut) : head;
    }
    slug = slug.replace(/-+$/, "");
  }
  return `${AGX_CAMPAIGN_PREFIX}${slug || "campaign"}`;
}

export function agxContent(code: string): string {
  return `${AGX_CONTENT_PREFIX}${code}`;
}

export function parseAgxCode(
  content: string | null | undefined,
): string | null {
  const match = CODE_PATTERN.exec(content ?? "");
  return match?.[1] ? match[1].toLowerCase() : null;
}

export function isAgxCampaign(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase().startsWith(AGX_CAMPAIGN_PREFIX);
}

export function utmFor(input: {
  channel: UtmChannel;
  campaign: string;
  code: string;
}): UtmParams {
  const base = {
    utm_campaign: input.campaign,
    utm_content: agxContent(input.code),
  };
  switch (input.channel) {
    case "meta_ads":
      return {
        utm_source: "facebook",
        utm_medium: "paid_social",
        ...base,
        utm_term: META_SITE_SOURCE_MACRO,
      };
    case "facebook":
      return { utm_source: "facebook", utm_medium: "social", ...base };
    case "instagram":
      return { utm_source: "instagram", utm_medium: "social", ...base };
    case "linkedin":
      return { utm_source: "linkedin", utm_medium: "social", ...base };
    case "x":
      return { utm_source: "x", utm_medium: "social", ...base };
    case "tiktok":
      return { utm_source: "tiktok", utm_medium: "social", ...base };
  }
}

// ---------------------------------------------------------------------------
// Ham metin yardımcıları
// ---------------------------------------------------------------------------

type SplitUrl = { head: string; query: string | null; hash: string };

// URL'yi ham metin olarak böler: `head` (sorgusuz), `query` (? sonrası, yoksa
// null) ve `hash` (# dahil). Hiçbir parça yeniden kodlanmaz.
function splitUrl(url: string): SplitUrl {
  const hashAt = url.indexOf("#");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const rest = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = rest.indexOf("?");
  if (queryAt < 0) return { head: rest, query: null, hash };
  return { head: rest.slice(0, queryAt), query: rest.slice(queryAt + 1), hash };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function pairKey(pair: string): string {
  const eq = pair.indexOf("=");
  return safeDecode(eq >= 0 ? pair.slice(0, eq) : pair).toLowerCase();
}

function isUtmKey(key: string): key is UtmKey {
  return (UTM_KEYS as readonly string[]).includes(key);
}

// Bir sorgudaki (ham metin) var olan utm anahtarları, küçük harfle.
function existingUtmKeys(query: string | null): Set<UtmKey> {
  const keys = new Set<UtmKey>();
  if (!query) return keys;
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const key = pairKey(pair);
    if (isUtmKey(key)) keys.add(key);
  }
  return keys;
}

function encodeValue(value: string): string {
  return MACRO_PATTERN.test(value) ? value : encodeURIComponent(value);
}

// Eklenecek anahtarlar, UTM_KEYS sırasında; boş değerler eklenmez.
function additionsOf(
  params: UtmParams,
  present: ReadonlySet<UtmKey>,
): { pairs: string[]; added: UtmKey[]; kept: UtmKey[] } {
  const pairs: string[] = [];
  const added: UtmKey[] = [];
  const kept: UtmKey[] = [];
  for (const key of UTM_KEYS) {
    const value = params[key];
    if (value === undefined || value === "") continue;
    if (present.has(key)) {
      kept.push(key);
      continue;
    }
    pairs.push(`${key}=${encodeValue(value)}`);
    added.push(key);
  }
  return { pairs, added, kept };
}

function parseHttp(url: string): URL | null {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Okuma ve temizleme
// ---------------------------------------------------------------------------

// Mutlak http(s) URL değil → null. Anahtarlar büyük/küçük harf duyarsız,
// değerler çözülmüş; aynı anahtar tekrarlanırsa ilki geçerli.
export function parseUtm(url: string): UtmParams | null {
  const parsed = parseHttp(url);
  if (!parsed) return null;
  const out: UtmParams = {};
  for (const [name, value] of parsed.searchParams) {
    const key = name.toLowerCase();
    if (isUtmKey(key) && out[key] === undefined) out[key] = value;
  }
  return out;
}

// Her utm_* parametresini (büyük/küçük harf duyarsız) siler; diğer
// parametrelerin ham metnini ve parçayı (#) korur. Geriye parametre kalmazsa
// "?" da düşer. http(s) dışındaki girdi olduğu gibi döner.
export function stripUtm(url: string): string {
  if (!parseHttp(url)) return url;
  const { head, query, hash } = splitUrl(url);
  if (query === null) return url;
  const kept = query
    .split("&")
    .filter((pair) => pair !== "" && !pairKey(pair).startsWith("utm_"));
  return `${head}${kept.length > 0 ? `?${kept.join("&")}` : ""}${hash}`;
}

// ---------------------------------------------------------------------------
// Alan adları
// ---------------------------------------------------------------------------

// Projenin kendi siteleri: Project.domain ile GA akışının sunucusu; geçerli
// olanlar, tekrarsız, sabit sırada (önce proje alan adı).
export function siteDomainsOf(input: {
  projectDomain: string | null;
  streamUri: string | null;
}): string[] {
  const candidates: string[] = [];
  if (input.projectDomain)
    candidates.push(normalizeDomain(input.projectDomain));
  if (input.streamUri) {
    let host: string;
    try {
      host = new URL(input.streamUri).hostname;
    } catch {
      host = input.streamUri;
    }
    candidates.push(normalizeDomain(host));
  }
  const out: string[] = [];
  for (const candidate of candidates) {
    if (candidate && isValidDomain(candidate) && !out.includes(candidate)) {
      out.push(candidate);
    }
  }
  return out;
}

function hostOf(parsed: URL): string {
  return parsed.hostname.toLowerCase().replace(/^www\./, "");
}

// Sunucu adı (baştaki "www." atılmış) alan adının kendisi ya da alt alan adı.
export function isOwnSiteUrl(url: string, domains: readonly string[]): boolean {
  const parsed = parseHttp(url);
  if (!parsed) return false;
  const host = hostOf(parsed);
  return domains.some((raw) => {
    const domain = normalizeDomain(raw);
    return domain !== "" && (host === domain || host.endsWith(`.${domain}`));
  });
}

// ---------------------------------------------------------------------------
// Etiketleme
// ---------------------------------------------------------------------------

// Var olan utm_* anahtarlarına dokunmaz; eksikleri ham sorgunun sonuna, parça
// (#) öncesine, UTM_KEYS sırasında ekler. Çözülemeyen URL olduğu gibi döner.
export function mergeUtm(
  url: string,
  params: UtmParams,
): { url: string; added: UtmKey[]; kept: UtmKey[] } {
  if (!parseHttp(url)) return { url, added: [], kept: [] };
  const { head, query, hash } = splitUrl(url);
  const { pairs, added, kept } = additionsOf(params, existingUtmKeys(query));
  if (pairs.length === 0) return { url, added, kept };
  const addition = pairs.join("&");
  let nextQuery: string;
  if (query === null || query === "") nextQuery = addition;
  else
    nextQuery = query.endsWith("&")
      ? `${query}${addition}`
      : `${query}&${addition}`;
  return { url: `${head}?${nextQuery}${hash}`, added, kept };
}

export type TagSkipReason =
  | "internal"
  | "not_http"
  | "invalid"
  | "no_domain"
  | "not_own_site"
  | "all_present";
export type TagDecision =
  | { tagged: true; url: string; added: UtmKey[]; kept: UtmKey[] }
  | { tagged: false; url: string; reason: TagSkipReason };

// Linkin etiketlenip etiketlenmeyeceği. Sıra: iç link, http(s) değil, çözülemez,
// bilinen alan adı yok, yabancı site, eklenecek bir şey yok. Etiketlenmeyen
// karar girdi URL'sini aynen döndürür.
export function tagOutboundUrl(input: {
  url: string;
  domains: readonly string[];
  params: UtmParams;
  context: "outbound" | "internal";
}): TagDecision {
  const skip = (reason: TagSkipReason): TagDecision => ({
    tagged: false,
    url: input.url,
    reason,
  });
  if (input.context === "internal") return skip("internal");
  const trimmed = input.url.trim();
  if (/^https?:/i.test(trimmed)) {
    if (!parseHttp(trimmed))
      return skip(/^https?:\/\//i.test(trimmed) ? "invalid" : "not_http");
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || /^[/#?]/.test(trimmed)) {
    return skip("not_http");
  } else {
    return skip("invalid");
  }
  if (input.domains.length === 0) return skip("no_domain");
  if (!isOwnSiteUrl(trimmed, input.domains)) return skip("not_own_site");
  const merged = mergeUtm(trimmed, input.params);
  if (merged.added.length === 0) return skip("all_present");
  return {
    tagged: true,
    url: merged.url,
    added: merged.added,
    kept: merged.kept,
  };
}

// Meta `url_tags` sorgusu (başında "?" yok): linkte olmayan anahtarlar, UTM_KEYS
// sırasında, mergeUtm ile aynı kodlamayla. Hepsi varsa "".
export function urlTagsFor(input: { link: string; params: UtmParams }): string {
  const { query } = splitUrl(input.link);
  return additionsOf(input.params, existingUtmKeys(query)).pairs.join("&");
}

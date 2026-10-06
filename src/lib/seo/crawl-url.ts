import { createHash } from "node:crypto";

import { isValidDomain, normalizeDomain } from "@/lib/domain";
import { normalizePageUrl } from "@/lib/seo/normalize";

// Tarayıcının adres kuralları (docs/google-search-console-plan.md SC-F3):
// kanonik biçim, adres anahtarı, tarama kapsamı ve kapsamın başlangıç adresi.
// Saf modül; ağ yok.

export const CRAWL_URL_MAX_LENGTH = 2_048;

// Reklam ve analitik izleme parametreleri; aynı sayfanın kopyalarını üretir.
const TRACKING_PARAMS = new Set([
  "gclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_ga",
]);

function isTrackingParam(name: string): boolean {
  let key = name;
  try {
    key = decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    // Bozuk kodlamada ham ad kullanılır.
  }
  key = key.toLowerCase();
  return key.startsWith("utm_") || TRACKING_PARAMS.has(key);
}

// Sorgu dizesi elle süzülür: URLSearchParams değerleri yeniden kodlar ve
// sayfanın kendi biçimini bozardı. Kalan parametrelerin sırası korunur.
function stripTrackingParams(search: string): string {
  if (!search || search === "?") return "";
  const kept = search
    .slice(1)
    .split("&")
    .filter(
      (part) => part !== "" && !isTrackingParam(part.split("=")[0] ?? ""),
    );
  return kept.length ? `?${kept.join("&")}` : "";
}

// Şema ve alan adı küçük harfe iner, varsayılan port, parça ve izleme
// parametreleri atılır; yol çözülmez ve harf düzeni korunur. Çıktı tekrar
// verildiğinde aynı kalır.
export function normalizeCrawlUrl(input: string, base?: string): string | null {
  let parsed: URL;
  try {
    parsed =
      base === undefined ? new URL(input.trim()) : new URL(input.trim(), base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  const search = stripTrackingParams(parsed.search);
  const path = parsed.pathname || "/";
  const url = `${parsed.protocol}//${parsed.host}${path}${search}`;
  return url.length > CRAWL_URL_MAX_LENGTH ? null : url;
}

// SeoPage.urlHash: normalleştirilmiş adresin sha256'sı (ilk 32 hane).
export function crawlUrlHash(normalizedUrl: string): string {
  return createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 32);
}

// GscPage.url ile aynı anahtar (köken + maskelenmiş yol, sorgu yok). W1 aynı
// fonksiyonla üretir; tarayıcının sayfasını GSC satırıyla eşlemek için.
export function gscPageKey(url: string): string | null {
  return normalizePageUrl(url)?.url ?? null;
}

export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname || "/"}${parsed.search}`;
  } catch {
    return "/";
  }
}

export function isHomepageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.pathname === "/" || parsed.pathname === "") &&
      parsed.search === ""
    );
  } catch {
    return false;
  }
}

// "www.x.com" ↔ "x.com" eşi.
export function hostTwin(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : `www.${lower}`;
}

export type CrawlScope = {
  kind: "GSC_DOMAIN" | "GSC_PREFIX" | "VERIFIED_DOMAIN";
  root: string;
  prefix: string | null;
  key: string;
};

function scopeOf(
  kind: CrawlScope["kind"],
  root: string,
  prefix: string | null,
): CrawlScope {
  return { kind, root, prefix, key: `${kind}:${root}:${prefix ?? ""}` };
}

// GSC mülkü: "sc-domain:x.com" kök + bütün alt alan adları (iki şema);
// "https://www.x.com/blog/" yalnız o önek.
export function scopeFromGscSite(siteUrl: string): CrawlScope | null {
  const value = siteUrl.trim();
  if (value.toLowerCase().startsWith("sc-domain:")) {
    const root = value
      .slice("sc-domain:".length)
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");
    if (!root || !isValidDomain(root) || /[/?#:@]/.test(root)) return null;
    return scopeOf("GSC_DOMAIN", root, null);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  const path = parsed.pathname.endsWith("/")
    ? parsed.pathname
    : `${parsed.pathname}/`;
  const prefix = `${parsed.protocol}//${parsed.host}${path}`;
  return scopeOf("GSC_PREFIX", parsed.hostname, prefix);
}

// Agentelse doğrulaması: Project.domain kökü ve "www." eşi.
export function scopeFromVerifiedDomain(domain: string): CrawlScope | null {
  const root = normalizeDomain(domain);
  if (!root || !isValidDomain(root)) return null;
  return scopeOf("VERIFIED_DOMAIN", root, null);
}

function parseHttp(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export function inScope(url: string, scope: CrawlScope): boolean {
  const parsed = parseHttp(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  if (scope.kind === "GSC_DOMAIN") {
    if (parsed.port) return false;
    return host === scope.root || host.endsWith(`.${scope.root}`);
  }
  if (scope.kind === "VERIFIED_DOMAIN") {
    if (parsed.port) return false;
    return host === scope.root || host === `www.${scope.root}`;
  }
  const prefix = scope.prefix;
  if (!prefix) return false;
  const marker = prefix.indexOf("//");
  const prefixScheme = prefix.slice(0, marker);
  const prefixRest = prefix.slice(marker + 2);
  // Önek https iken http adresi de kapsamda sayılır: siteler http'yi
  // https'e yönlendirir ve tarayıcının o yönlendirme adımını izleyebilmesi
  // gerekir. Tersi (önek http, adres https) ayrı bir mülktür, kapsam dışıdır.
  const schemeOk =
    parsed.protocol === prefixScheme ||
    (parsed.protocol === "http:" && prefixScheme === "https:");
  if (!schemeOk) return false;
  const rest = `${parsed.host}${parsed.pathname}${parsed.search}`;
  return rest.startsWith(prefixRest);
}

export function startUrlFor(
  scope: CrawlScope,
  projectDomain: string | null,
): string {
  if (scope.kind === "GSC_PREFIX" && scope.prefix) return scope.prefix;
  if (scope.kind === "GSC_DOMAIN" && projectDomain) {
    const domain = normalizeDomain(projectDomain);
    if (domain === scope.root || domain.endsWith(`.${scope.root}`)) {
      return `https://${domain}/`;
    }
  }
  return `https://${scope.root}/`;
}

// Yalnız yönlendirme adımları için: köken alan adı ya da www/apex eşi. Kuyruğa
// (frontier) yalnız köken alan adının adresleri girer.
export function crawlHostAllowed(url: string, originHost: string): boolean {
  const parsed = parseHttp(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  const origin = originHost.toLowerCase();
  return host === origin || host === hostTwin(origin);
}

// FNV-1a 64 bit; BigInt yerine iki 32 bit yarımla hesaplanır (2 MB metinde
// hızlı). Asal 2^40 + 0x1b3: hi += lo << 8 (2^40 / 2^32), artı 0x1b3 çarpımı.
export function fnv1a64Parts(bytes: Uint8Array): { hi: number; lo: number } {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (let index = 0; index < bytes.length; index += 1) {
    lo = (lo ^ (bytes[index] ?? 0)) >>> 0;
    const loProduct = lo * 0x1b3;
    const carry = Math.floor(loProduct / 0x1_0000_0000);
    const nextHi = (hi * 0x1b3 + carry + ((lo << 8) >>> 0)) >>> 0;
    lo = loProduct >>> 0;
    hi = nextHi;
  }
  return { hi, lo };
}

const encoder = new TextEncoder();

export function fnv1a64Hex(text: string): string {
  const { hi, lo } = fnv1a64Parts(encoder.encode(text));
  return `${hi.toString(16).padStart(8, "0")}${lo.toString(16).padStart(8, "0")}`;
}

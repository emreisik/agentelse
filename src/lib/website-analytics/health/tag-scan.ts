import { extractHtmlParts } from "./html-parts";
import type { GaSiteHints, GaSiteTagResult } from "./types";

// GA-F3 MH3 (docs/measurement-health.md "Site taraması"): bir sayfanın
// HTML'inde Google etiketlerinin tespiti. Yalnız kimlikler, sayılar ve
// boolean'lar döner; adres, metin ya da sayfa içeriği sonuca girmez.
//  - gtag/js?id=G-… yüklemeleri (src ya da satır içi metinde) ve
//    gtag('config','G-…') çağrıları
//  - gtag/js ile yüklenen birleşik Google etiketi (GT-/AW-): G- kimliği
//    görünmez, MH3 bunu UNKNOWN sayar
//  - GTM kapsayıcıları, izin varsayılanı (Consent Mode), CMP işaretleri
//  - anahtar olay ipuçları (tel:, WhatsApp, mailto:, harita, sepet, form)

export type GaPageTagScan = {
  measurementIds: string[];
  loads: Record<string, number>;
  configs: Record<string, number>;
  gtmContainers: string[];
  googleTagIds: string[] /* GT-/AW- */;
  gtagJs: boolean;
  consentDefault: boolean;
  cmp: string | null;
  hints: GaSiteHints;
};

// Sorgu parametreleri sınırlı: her parametre "&" ile biter ve en çok 300
// karakter, en çok 10 parametre (saldırgan HTML'de geri izleme patlamasın).
const GTAG_G_LOAD =
  /googletagmanager\.com\/gtag\/js\?(?:[^"'\s&]{0,300}&){0,10}id=(G-[A-Z0-9]{4,14})/gi;
const GTAG_COMBINED_LOAD =
  /googletagmanager\.com\/gtag\/js\?(?:[^"'\s&]{0,300}&){0,10}id=((?:GT|AW)-[A-Z0-9]{4,14})/gi;
const GTAG_CONFIG =
  /gtag\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]{4,14})['"]/gi;
const GTM_LOAD = /gtm\.js\?(?:[^"'\s&]{0,300}&){0,10}id=(GTM-[A-Z0-9]{4,12})/gi;
const GTM_QUOTED_ID = /['"](GTM-[A-Z0-9]{4,12})['"]/gi;
// gtag('consent','default', …) ya da dataLayer.push(['consent','default', …]).
const CONSENT_DEFAULT = /['"]consent['"]\s*,\s*['"]default['"]/i;

// İlk eşleşen işaret kazanır; görünen ad arayüzde kullanılır.
const CMP_MARKERS: readonly { marker: RegExp; name: string }[] = [
  { marker: /cookiebot/i, name: "Cookiebot" },
  { marker: /onetrust|cookielaw/i, name: "OneTrust" },
  { marker: /cookieyes/i, name: "CookieYes" },
  { marker: /iubenda/i, name: "iubenda" },
  { marker: /complianz/i, name: "Complianz" },
  { marker: /usercentrics/i, name: "Usercentrics" },
  { marker: /didomi/i, name: "Didomi" },
  { marker: /cookiefirst/i, name: "CookieFirst" },
  { marker: /termly/i, name: "Termly" },
  { marker: /consentmanager/i, name: "consentmanager" },
  { marker: /quantcast/i, name: "Quantcast Choice" },
  { marker: /osano/i, name: "Osano" },
  { marker: /klaro/i, name: "Klaro" },
  { marker: /borlabs/i, name: "Borlabs Cookie" },
  { marker: /cookie-script/i, name: "Cookie-Script" },
  { marker: /trustarc/i, name: "TrustArc" },
];

const WHATSAPP = /wa\.me\/|api\.whatsapp\.com|whatsapp:\/\//i;
const MAPS =
  /maps\.google\.|google\.com\/maps|goo\.gl\/maps|maps\.app\.goo\.gl/i;
const CHECKOUT = /\/(?:checkout|cart|sepet|odeme)(?=[/?#.]|$)/i;

// Sayfa başına taranan betik metni sınırı (tek betik ve toplam).
const MAX_SCRIPT_CHARS = 256_000;

function count(target: Record<string, number>, id: string): void {
  target[id] = (target[id] ?? 0) + 1;
}

function idsOf(text: string, pattern: RegExp): string[] {
  return Array.from(text.matchAll(pattern), (match) =>
    (match[1] ?? "").toUpperCase(),
  ).filter((id) => id.length > 0);
}

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function noHints(): GaSiteHints {
  return {
    tel: false,
    whatsapp: false,
    mailto: false,
    form: false,
    maps: false,
    checkout: false,
  };
}

export function scanPageTags(html: string): GaPageTagScan {
  const parts = extractHtmlParts(html);
  const loads: Record<string, number> = {};
  const configs: Record<string, number> = {};
  const gtm = new Set<string>();
  const googleTag = new Set<string>();
  let gtagJs = false;
  let consentDefault = false;

  let budget = MAX_SCRIPT_CHARS;
  const scripts = parts.scripts.map((script) => {
    const text = script.text.slice(0, Math.max(0, budget));
    budget -= text.length;
    return { src: (script.src ?? "").slice(0, 2_048), text };
  });

  for (const script of scripts) {
    for (const source of [script.src, script.text]) {
      if (!source) continue;
      for (const id of idsOf(source, GTAG_G_LOAD)) {
        count(loads, id);
        gtagJs = true;
      }
      for (const id of idsOf(source, GTAG_COMBINED_LOAD)) {
        googleTag.add(id);
        gtagJs = true;
      }
      for (const id of idsOf(source, GTM_LOAD)) gtm.add(id);
    }
    const text = script.text;
    if (!text) continue;
    for (const id of idsOf(text, GTAG_CONFIG)) count(configs, id);
    // Standart GTM parçacığı adresi parçalardan kurar ('gtm.js?id='+i).
    if (/gtm\.js/i.test(text)) {
      for (const id of idsOf(text, GTM_QUOTED_ID)) gtm.add(id);
    }
    if (CONSENT_DEFAULT.test(text)) consentDefault = true;
  }

  const haystack = scripts.map((script) => `${script.src}\n${script.text}`);
  const cmp =
    CMP_MARKERS.find(({ marker }) =>
      haystack.some((value) => marker.test(value)),
    )?.name ?? null;

  const hints = noHints();
  hints.form = parts.forms > 0;
  for (const raw of parts.hrefs) {
    const href = raw.trim().toLowerCase();
    if (href.startsWith("tel:")) hints.tel = true;
    if (href.startsWith("mailto:")) hints.mailto = true;
    if (WHATSAPP.test(href)) hints.whatsapp = true;
    if (MAPS.test(href)) hints.maps = true;
    if (CHECKOUT.test(href)) hints.checkout = true;
  }

  return {
    measurementIds: sortedUnique([
      ...Object.keys(loads),
      ...Object.keys(configs),
    ]),
    loads,
    configs,
    gtmContainers: sortedUnique(gtm),
    googleTagIds: sortedUnique(googleTag),
    gtagJs,
    consentDefault,
    cmp,
    hints,
  };
}

const MAX_OTHER_IDS = 5;

function loadedTwice(scan: GaPageTagScan, id: string | null): boolean {
  if (id) return (scan.loads[id] ?? 0) >= 2 || (scan.configs[id] ?? 0) >= 2;
  return [...Object.values(scan.loads), ...Object.values(scan.configs)].some(
    (times) => times >= 2,
  );
}

// Sayfa taramalarının birleşimi. null sayfa = getirilemedi (ağ hatası,
// 2xx dışı yanıt, başka alan adına yönlendirme).
export function combinePageScans(input: {
  at: string;
  host: string;
  expectedId: string | null;
  pages: (GaPageTagScan | null)[];
}): GaSiteTagResult {
  const expectedId = input.expectedId ? input.expectedId.toUpperCase() : null;
  const scans = input.pages.filter(
    (page): page is GaPageTagScan => page !== null,
  );
  const hints = noHints();
  for (const scan of scans) {
    for (const key of Object.keys(hints) as (keyof GaSiteHints)[]) {
      if (scan.hints[key]) hints[key] = true;
    }
  }
  const otherIds = sortedUnique(scans.flatMap((scan) => scan.measurementIds))
    .filter((id) => id !== expectedId)
    .slice(0, MAX_OTHER_IDS);

  return {
    v: 1,
    at: input.at,
    host: input.host,
    outcome: scans.length === 0 ? "fetch_failed" : "ok",
    pagesChecked: scans.length,
    pagesFailed: input.pages.length - scans.length,
    pagesWithExpected: expectedId
      ? scans.filter((scan) => scan.measurementIds.includes(expectedId)).length
      : 0,
    expectedId,
    otherIds,
    gtm: scans.some((scan) => scan.gtmContainers.length > 0),
    googleTag: scans.some((scan) => scan.googleTagIds.length > 0),
    gtagJs: scans.some((scan) => scan.gtagJs),
    doubleLoad: scans.some((scan) => loadedTwice(scan, expectedId)),
    consentDefault: scans.some((scan) => scan.consentDefault),
    cmp: scans.find((scan) => scan.cmp !== null)?.cmp ?? null,
    hints,
  };
}

// Mock mod (AGENTELSE_PROVIDER_MODE=mock): siteye gidilmez; etiketi kurulu,
// izin varsayılanı olan, formlu tek sayfa. Alan adı yoksa "no_site".
export function mockSiteTagResult(input: {
  at: string;
  host: string | null;
  expectedId: string | null;
}): GaSiteTagResult {
  const expectedId = input.expectedId ? input.expectedId.toUpperCase() : null;
  const hasSite = input.host !== null;
  return {
    v: 1,
    at: input.at,
    host: input.host,
    outcome: hasSite ? "ok" : "no_site",
    pagesChecked: hasSite ? 1 : 0,
    pagesFailed: 0,
    pagesWithExpected: hasSite && expectedId ? 1 : 0,
    expectedId,
    otherIds: [],
    gtm: false,
    googleTag: false,
    gtagJs: hasSite,
    doubleLoad: false,
    consentDefault: hasSite,
    cmp: null,
    hints: { ...noHints(), form: hasSite },
  };
}

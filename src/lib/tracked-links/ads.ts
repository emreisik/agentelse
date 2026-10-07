import { isOwnSiteUrl, parseUtm, urlTagsFor, utmFor } from "@/lib/utm";

// Review kartında, reklam linklerine Agentelse etiketi eklendiğini gösteren not.
export const TRACKING_ADDED_NOTE = "Tracking: UTM added";

// Meta reklamının url_tags değeri: facebook / paid_social / agx-<kampanya> /
// agx_<kod> + {{site_source_name}}. Linkte zaten olan anahtarlar dışarıda kalır.
export function metaAdUrlTags(input: {
  link: string;
  campaign: string;
  code: string;
}): string {
  return urlTagsFor({
    link: input.link,
    params: utmFor({
      channel: "meta_ads",
      campaign: input.campaign,
      code: input.code,
    }),
  });
}

// Spec'teki herhangi bir reklam Agentelse kodunu taşıyor mu?
export function hasAgentelseTracking(spec: {
  ads: readonly { urlTags: string }[];
}): boolean {
  return spec.ads.some((ad) => ad.urlTags.includes("utm_content=agx_"));
}

// Etiket yoksa AYNI nesne döner (bayrak kapalıyken Review kartı değişmez).
export function withTrackingNote<T extends { notes: string[] }>(
  check: T,
  spec: { ads: readonly { urlTags: string }[] },
): T {
  if (!hasAgentelseTracking(spec)) return check;
  if (check.notes.includes(TRACKING_ADDED_NOTE)) return check;
  return { ...check, notes: [...check.notes, TRACKING_ADDED_NOTE] };
}

// Etiketlenebilir reklam: mesaj reklamı değil, link dolu, projenin kendi
// sitesinde ve utm_content taşımıyor. utm_content varsa bizim kodumuz GA'ya
// hiç ulaşamaz; o reklam bugünkü DEFAULT_URL_TAGS ile kalır (url_tags asla "" olmaz).
export function metaAdTaggable(input: {
  link: string | null | undefined;
  messages?: unknown;
  domains: readonly string[];
}): boolean {
  if (input.messages) return false;
  const link = input.link?.trim();
  if (!link) return false;
  if (!isOwnSiteUrl(link, input.domains)) return false;
  return parseUtm(link)?.utm_content === undefined;
}

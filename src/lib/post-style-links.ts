// Reading example posts from links: what a person pastes, and where a page keeps
// its picture. Pure.

export const MAX_LINKS_PER_REQUEST = 6;

const URL_LIKE = /^https?:\/\/[^\s]+$/i;

// Links from free text: one per line or separated by spaces or commas, http(s)
// only, without duplicates, at most MAX_LINKS_PER_REQUEST.
export function parseLinkLines(input: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const raw of input.split(/[\s,]+/)) {
    const candidate = raw
      .trim()
      .replace(/^[(<"'[]+/, "")
      .replace(/[)>"'\].,;]+$/, "");
    if (!URL_LIKE.test(candidate) || candidate.length > 500) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    links.push(candidate);
    if (links.length === MAX_LINKS_PER_REQUEST) break;
  }
  return links;
}

const META_IMAGE_KEYS = [
  "og:image:secure_url",
  "og:image",
  "twitter:image",
  "twitter:image:src",
];

function attributeOf(tag: string, name: string): string | null {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

// The picture a page names for itself (Open Graph, Twitter card, image_src),
// as an absolute URL; null when it names none.
export function imageUrlFromHtml(html: string, baseUrl: string): string | null {
  const found = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (
      attributeOf(tag, "property") ??
      attributeOf(tag, "name") ??
      ""
    ).toLowerCase();
    const content = attributeOf(tag, "content");
    if (content && META_IMAGE_KEYS.includes(key) && !found.has(key)) {
      found.set(key, content);
    }
  }
  let candidate: string | undefined;
  for (const key of META_IMAGE_KEYS) {
    const value = found.get(key);
    if (value) {
      candidate = value;
      break;
    }
  }
  if (!candidate) {
    for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
      if ((attributeOf(tag, "rel") ?? "").toLowerCase() === "image_src") {
        candidate = attributeOf(tag, "href") ?? undefined;
        if (candidate) break;
      }
    }
  }
  if (!candidate) return null;
  try {
    const url = new URL(decodeEntities(candidate.trim()), baseUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

const SOCIAL_HOSTS = [
  "instagram.com",
  "facebook.com",
  "fb.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "pinterest.com",
];

// A link to a social network's own page: they rarely hand a picture to an app.
export function isSocialLink(link: string): boolean {
  try {
    const host = new URL(link).hostname.toLowerCase();
    return SOCIAL_HOSTS.some(
      (social) => host === social || host.endsWith(`.${social}`),
    );
  } catch {
    return false;
  }
}

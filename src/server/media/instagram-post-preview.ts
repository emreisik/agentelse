import "server-only";

const INSTAGRAM_POST_URL =
  /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels)\/[A-Za-z0-9_-]+\/?/i;

// The UA Instagram's own link-unfurling optimizes for (WhatsApp/Slack/
// iMessage previews) — serves a static HTML response with real Open Graph
// tags instead of the client-hydrated app shell a normal browser UA gets.
const PREVIEW_USER_AGENT = "facebookexternalhit/1.1";
const FETCH_TIMEOUT_MS = 8000;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    );
}

function extractMetaContent(html: string, property: string): string | null {
  const match = html.match(
    new RegExp(`<meta property="${property}" content="([^"]*)"`),
  );
  return match?.[1] !== undefined ? decodeHtmlEntities(match[1]) : null;
}

export type InstagramPostPreview =
  | { ok: true; imageUrl: string; caption: string | null }
  | { ok: false; reason: string };

// Instagram's current oEmbed API no longer returns an image URL or caption
// — it only returns an embed HTML blob meant to be hydrated client-side by
// their own JS widget (confirmed against the live Graph API reference).
// This instead reads the same Open Graph meta tags Instagram serves to
// link-preview bots — unofficial, but it's the same publicly-intended
// preview data every chat app reads when a link is shared, fetched once per
// user-pasted link rather than any kind of bulk crawl. Best-effort by
// design: never throws, so one broken/deleted post never takes the rest of
// an import down with it.
export async function fetchInstagramPostPreview(
  url: string,
): Promise<InstagramPostPreview> {
  const trimmed = url.trim();
  if (!INSTAGRAM_POST_URL.test(trimmed)) {
    return { ok: false, reason: "Not an instagram.com post/reel link" };
  }

  let html: string;
  try {
    const response = await fetch(trimmed, {
      headers: { "User-Agent": PREVIEW_USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    html = await response.text();
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Fetch failed",
    };
  }

  const imageUrl = extractMetaContent(html, "og:image");
  if (!imageUrl) {
    return { ok: false, reason: "No og:image tag found on the page" };
  }

  const caption = extractMetaContent(html, "og:description");
  return { ok: true, imageUrl, caption };
}

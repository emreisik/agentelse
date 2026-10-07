import { inScope, normalizeCrawlUrl, type CrawlScope } from "@/lib/seo/crawl-url";

import { APPLY_LIMITS, cleanLine } from "./validate";

// SC-F8: iç bağlantı önerisinin doğrulanması. crawl-url (node:crypto) içe
// aktarır: yalnız sunucu tarafında kullanılır, istemci bileşenleri almaz.

export function validateLinks(
  raw: unknown,
  ctx: { pageUrl: string; scope: CrawlScope },
):
  | { ok: true; links: { toUrl: string; anchor: string }[] }
  | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: "Add at least one link." };
  }
  if (raw.length > APPLY_LIMITS.linksMax) {
    return {
      ok: false,
      message: `At most ${APPLY_LIMITS.linksMax} links per change.`,
    };
  }
  const page = normalizeCrawlUrl(ctx.pageUrl);
  const links: { toUrl: string; anchor: string }[] = [];
  const seen = new Set<string>();
  const anchors = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, message: "A link is not valid." };
    }
    const { toUrl, anchor } = item as { toUrl?: unknown; anchor?: unknown };
    if (typeof toUrl !== "string" || typeof anchor !== "string") {
      return { ok: false, message: "A link is not valid." };
    }
    // Satır sonu ve işaret içeren bağlantı metni temizlenmez, reddedilir.
    if (/[<>\u0000-\u001f\u007f\u2028\u2029]/.test(anchor)) {
      return { ok: false, message: "A link text has characters that are not allowed." };
    }
    const text = cleanLine(anchor);
    const size = Array.from(text).length;
    if (size < APPLY_LIMITS.anchorMin || size > APPLY_LIMITS.anchorMax) {
      return {
        ok: false,
        message: `A link text must be ${APPLY_LIMITS.anchorMin} to ${APPLY_LIMITS.anchorMax} characters.`,
      };
    }
    const target = normalizeCrawlUrl(toUrl);
    if (!target || !inScope(target, ctx.scope)) {
      return { ok: false, message: "A link points outside your site." };
    }
    if (page && target === page) {
      return { ok: false, message: "A page cannot link to itself." };
    }
    const pair = `${target}\n${text.toLowerCase()}`;
    const textKey = text.toLowerCase();
    if (seen.has(pair) || anchors.has(textKey)) {
      return { ok: false, message: "Two links are the same." };
    }
    seen.add(pair);
    anchors.add(textKey);
    links.push({ toUrl: target, anchor: text });
  }
  return { ok: true, links };
}

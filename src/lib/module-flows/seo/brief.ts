import { SUPPORTED_LANGUAGES } from "@/lib/locales";

import { SEO_LIMITS, type SeoBrief } from "./state";

// The SEO Manager's Brief (docs/modules.md): topic (required), the site, the
// article's language and, optionally, who it is for. One validator for the
// card (why the primary is blocked) and the research action (the authority).
// Pure and isomorphic.

export const SEO_LANGUAGES = SUPPORTED_LANGUAGES;

export function isSeoLanguage(code: unknown): code is string {
  return SEO_LANGUAGES.some((language) => language.code === code);
}

export function seoLanguageName(code: string): string {
  return (
    SEO_LANGUAGES.find((language) => language.code === code)?.label ?? code
  );
}

// One line of the person's own text: control characters and line breaks out,
// whitespace collapsed, clipped by code point (an emoji is never cut in half).
export function cleanLine(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const flat = raw
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(flat);
  return points.length <= max ? flat : points.slice(0, max).join("").trimEnd();
}

// "example.com", "https://www.example.com/blog/" or a Search Console domain
// property ("sc-domain:example.com") as one canonical address: http(s), a real
// host, no credentials, no query, no trailing slash. Null when it is not a
// website address.
export function normalizeSiteUrl(raw: string): string | null {
  let text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  if (/^sc-domain:/i.test(text)) text = text.slice("sc-domain:".length);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (!/^[a-z0-9.-]+$/i.test(url.hostname)) return null;
  if (!url.hostname.includes(".") || url.hostname.endsWith(".")) return null;
  const path = url.pathname.replace(/\/+$/, "");
  const normalized = `${url.protocol}//${url.host}${path}`;
  return normalized.length <= SEO_LIMITS.siteUrl ? normalized : null;
}

// "example.com/blog" for the search preview.
export function siteLabel(siteUrl: string): string {
  return siteUrl.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
}

export type SeoBriefField = "topic" | "siteUrl" | "language";

export type SeoBriefCheck =
  | { ok: true; brief: SeoBrief }
  | { ok: false; field: SeoBriefField; message: string };

export const SEO_BRIEF_MESSAGES = {
  topic: "Add a topic of at least 3 characters.",
  siteUrl: "Enter a website address, like example.com.",
  language: "Pick the article's language.",
} as const;

export function validateSeoBrief(input: unknown): SeoBriefCheck {
  const raw =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const topic = cleanLine(raw.topic, SEO_LIMITS.topic);
  if (Array.from(topic).length < SEO_LIMITS.topicMin) {
    return { ok: false, field: "topic", message: SEO_BRIEF_MESSAGES.topic };
  }
  const siteRaw = cleanLine(raw.siteUrl, SEO_LIMITS.siteUrl * 2);
  const siteUrl = siteRaw ? normalizeSiteUrl(siteRaw) : "";
  if (siteUrl === null) {
    return { ok: false, field: "siteUrl", message: SEO_BRIEF_MESSAGES.siteUrl };
  }
  if (!isSeoLanguage(raw.language)) {
    return {
      ok: false,
      field: "language",
      message: SEO_BRIEF_MESSAGES.language,
    };
  }
  return {
    ok: true,
    brief: {
      topic,
      siteUrl,
      language: raw.language,
      audience: cleanLine(raw.audience, SEO_LIMITS.audience),
    },
  };
}

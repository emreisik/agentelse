// llms.txt ayrıştırma ve deterministik taslak (SC-F8 GEO1). llms.txt gelişen,
// isteğe bağlı bir kuraldır: ilk satırı "# Başlık" olan, isteğe bağlı "> özet"
// ve "## Bölüm" altında "- [ad](adres): not" bağlantıları olan düz metin.
// Taslakta model yoktur; siteye hiçbir şey yazılmaz. Saf modül.

export const LLMS_MAX_BYTES = 200_000;
export const LLMS_MAX_LINKS = 40;

const TITLE_MAX = 80;
const SUMMARY_MAX = 200;
const LINK_TEXT_MAX = 100;
const LINK_NOTE_MAX = 160;
const URL_MAX = 500;

const encoder = new TextEncoder();

export type LlmsParse = {
  valid: boolean;
  hasTitle: boolean;
  links: number;
  sections: number;
  bytes: number;
};

// [ad](https://adres) biçimi; sınırlı sınıflar sayesinde doğrusaldır.
const LINK_PATTERN = /\[[^\]\n]{1,200}\]\((https?:\/\/[^)\s]{1,500})\)/g;

function looksLikeHtml(text: string): boolean {
  const head = text.trimStart().slice(0, 200).toLowerCase();
  return (
    head.startsWith("<") || head.startsWith("&lt;") || head.includes("<html")
  );
}

export function parseLlmsTxt(text: string): LlmsParse {
  const bytes = encoder.encode(text).length;
  // Çok büyük dosyada yalnız ilk LLMS_MAX_BYTES karakter incelenir.
  const body = text.length > LLMS_MAX_BYTES ? text.slice(0, LLMS_MAX_BYTES) : text;
  const trimmed = body.replace(/^﻿/, "").trim();
  if (!trimmed) {
    return { valid: false, hasTitle: false, links: 0, sections: 0, bytes };
  }
  if (looksLikeHtml(trimmed)) {
    return { valid: false, hasTitle: false, links: 0, sections: 0, bytes };
  }
  const lines = trimmed.split(/\r\n|\r|\n/);
  const first = lines.find((line) => line.trim() !== "") ?? "";
  const hasTitle = /^#\s+\S/.test(first.trim());
  let sections = 0;
  for (const line of lines) {
    if (/^##\s+\S/.test(line.trim())) sections += 1;
  }
  const links = (trimmed.match(LINK_PATTERN) ?? []).length;
  return { valid: true, hasTitle, links, sections, bytes };
}

// Tek satıra iner: kontrol karakterleri, satır sonları ve fazla boşluk gider.
function oneLine(value: string, max: number): string {
  const flat = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// Markdown bağlantı metnini bozan karakterler değişir.
function linkText(value: string): string {
  return oneLine(value, LINK_TEXT_MAX).replace(/\[/g, "(").replace(/\]/g, ")");
}

function safeUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    if (parsed.href.length > URL_MAX) return null;
    parsed.hash = "";
    return parsed;
  } catch {
    return null;
  }
}

export type LlmsDraftInput = {
  siteName: string;
  description: string | null;
  // Ana sayfa önce gelir; sıra korunur.
  pages: { url: string; title: string | null; description: string | null }[];
  // Verilmezse ilk geçerli https sayfanın alan adı.
  host?: string | null;
};

// Aynı girdi her zaman aynı metni verir: en çok 40 bağlantı, yalnız aynı
// siteden https adresleri, her alan tek satır.
export function buildLlmsTxt(input: LlmsDraftInput): string {
  const name = oneLine(input.siteName.replace(/^#+\s*/, ""), TITLE_MAX);
  const lines: string[] = [`# ${name || "Site"}`];
  const summary = input.description ? oneLine(input.description, SUMMARY_MAX) : "";
  if (summary) lines.push("", `> ${summary}`);

  let host = input.host ? input.host.trim().toLowerCase() : null;
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const page of input.pages) {
    const parsed = safeUrl(page.url);
    if (!parsed) continue;
    if (host === null) host = parsed.hostname.toLowerCase();
    if (parsed.hostname.toLowerCase() !== host) continue;
    // Parantezler adresi bozmasın.
    const href = parsed.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
    if (seen.has(href)) continue;
    seen.add(href);
    const title = linkText(page.title ?? "") || linkText(parsed.pathname);
    const note = page.description ? oneLine(page.description, LINK_NOTE_MAX) : "";
    entries.push(note ? `- [${title}](${href}): ${note}` : `- [${title}](${href})`);
    if (entries.length >= LLMS_MAX_LINKS) break;
  }
  if (entries.length > 0) lines.push("", "## Key pages", "", ...entries);
  return `${lines.join("\n")}\n`;
}

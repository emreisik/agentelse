// The SEO article's markdown (docs/modules.md "SEO Manager"): one small parser
// whose blocks feed the card's reader view (article-view.tsx), the HTML export
// ("Copy as HTML") and the on-page checks, so the three never read the same
// article differently. Only what the writing prompt asks for is understood:
// headings, paragraphs, lists, quotes, bold, italic, inline code and links.
// Everything else stays plain text. Pure and isomorphic.

export type MdInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: MdInline[] }
  | { type: "em"; children: MdInline[] }
  | { type: "code"; text: string }
  // href is null when the target is not a safe link: the label stays as text.
  | { type: "link"; href: string | null; children: MdInline[] };

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type MdBlock =
  | { type: "heading"; level: HeadingLevel; children: MdInline[]; text: string }
  | { type: "paragraph"; children: MdInline[]; text: string }
  | {
      type: "list";
      ordered: boolean;
      items: { children: MdInline[]; text: string }[];
    }
  | { type: "quote"; children: MdInline[]; text: string };

const MAX_INLINE_DEPTH = 4;

const HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const BULLET = /^[-*+]\s+(.+)$/;
const NUMBERED = /^\d{1,3}[.)]\s+(.+)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const FENCE = /^(?:```|~~~)/;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const ESCAPABLE = /[\\`*_[\]()#+\-.!>]/;

// A link the reader may follow: the web, mail, or a path on the same site.
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (!href || /\s/.test(href)) return null;
  if (/^https?:\/\/[^/]/i.test(href)) return href;
  if (/^mailto:[^/]/i.test(href)) return href;
  if (href.startsWith("#")) return href;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  return null;
}

function pushText(out: MdInline[], text: string): void {
  if (!text) return;
  const last = out.at(-1);
  if (last?.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

// The index of the `closer` that closes the `opener` at `open` (nested pairs
// counted, escapes skipped), or -1. "]" for a link's label, ")" for its target
// (a Wikipedia-style "/wiki/Foo_(bar)" keeps its own parentheses).
function closingOf(
  src: string,
  open: number,
  opener: "[" | "(",
  closer: "]" | ")",
): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === opener) depth++;
    if (ch === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// The closing single marker of an emphasis opened at `from`: not doubled, not
// after a space, and for "_" not inside a word (snake_case stays text).
function closingSingle(src: string, from: number, marker: string): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] !== marker) continue;
    if (src[i + 1] === marker) {
      i++;
      continue;
    }
    if (/\s/.test(src[i - 1] ?? "")) continue;
    if (marker === "_" && WORD_CHAR.test(src[i + 1] ?? "")) continue;
    return i;
  }
  return -1;
}

export function parseInline(src: string, depth = 0): MdInline[] {
  const out: MdInline[] = [];
  if (depth > MAX_INLINE_DEPTH) {
    pushText(out, src);
    return out;
  }
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1] ?? "";

    if (ch === "\\" && ESCAPABLE.test(next)) {
      pushText(out, next);
      i += 2;
      continue;
    }

    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        out.push({ type: "code", text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (ch === "[") {
      const close = closingOf(src, i, "[", "]");
      if (close > i && src[close + 1] === "(") {
        const end = closingOf(src, close + 1, "(", ")");
        if (end > close + 1) {
          // `[label](url "title")`: the title is dropped.
          const target =
            src
              .slice(close + 2, end)
              .trim()
              .split(/\s+/)[0] ?? "";
          out.push({
            type: "link",
            href: safeHref(target),
            children: parseInline(src.slice(i + 1, close), depth + 1),
          });
          i = end + 1;
          continue;
        }
      }
    }

    if ((ch === "*" || ch === "_") && next === ch) {
      const inner = src[i + 2] ?? "";
      const leftOk = ch === "*" || !WORD_CHAR.test(src[i - 1] ?? "");
      if (inner && !/\s/.test(inner) && leftOk) {
        const end = src.indexOf(ch + ch, i + 2);
        if (end > i + 2 && !/\s/.test(src[end - 1] ?? "")) {
          out.push({
            type: "strong",
            children: parseInline(src.slice(i + 2, end), depth + 1),
          });
          i = end + 2;
          continue;
        }
      }
    }

    if (ch === "*" || ch === "_") {
      const leftOk = ch === "*" || !WORD_CHAR.test(src[i - 1] ?? "");
      if (next && !/\s/.test(next) && next !== ch && leftOk) {
        const end = closingSingle(src, i + 1, ch);
        if (end > i + 1) {
          out.push({
            type: "em",
            children: parseInline(src.slice(i + 1, end), depth + 1),
          });
          i = end + 1;
          continue;
        }
      }
    }

    pushText(out, ch);
    i++;
  }
  return out;
}

export function inlineText(nodes: readonly MdInline[]): string {
  return nodes
    .map((node) =>
      node.type === "text" || node.type === "code"
        ? node.text
        : inlineText(node.children),
    )
    .join("");
}

function inlineBlock(source: string): { children: MdInline[]; text: string } {
  const children = parseInline(source);
  return { children, text: inlineText(children) };
}

export function parseMarkdown(markdown: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", ...inlineBlock(paragraph.join(" ")) });
    }
    paragraph = [];
  };
  const flushQuote = () => {
    if (quote.length) {
      blocks.push({ type: "quote", ...inlineBlock(quote.join(" ")) });
    }
    quote = [];
  };
  const flushList = () => {
    if (list && list.items.length) {
      blocks.push({
        type: "list",
        ordered: list.ordered,
        items: list.items.map(inlineBlock),
      });
    }
    list = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushQuote();
    flushList();
  };

  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || RULE.test(trimmed)) {
      flushAll();
      continue;
    }
    // Fence markers are dropped; what they wrap reads as plain text.
    if (FENCE.test(trimmed)) continue;

    const heading = HEADING.exec(trimmed);
    if (heading) {
      flushAll();
      blocks.push({
        type: "heading",
        level: heading[1]!.length as HeadingLevel,
        ...inlineBlock(heading[2]!),
      });
      continue;
    }

    const bullet = BULLET.exec(trimmed);
    const numbered = bullet ? null : NUMBERED.exec(trimmed);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      flushParagraph();
      flushQuote();
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]!);
      continue;
    }

    const quoted = QUOTE.exec(trimmed);
    if (quoted) {
      flushParagraph();
      flushList();
      if (quoted[1]) quote.push(quoted[1]);
      continue;
    }

    // An indented line right under a list item continues that item.
    const openList: { ordered: boolean; items: string[] } | null = list;
    if (openList && /^\s/.test(line) && openList.items.length) {
      const lastIndex = openList.items.length - 1;
      openList.items[lastIndex] = `${openList.items[lastIndex]} ${trimmed}`;
      continue;
    }
    flushQuote();
    flushList();
    paragraph.push(trimmed);
  }
  flushAll();
  return blocks;
}

// ---- HTML export -------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineHtml(nodes: readonly MdInline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return escapeHtml(node.text);
        case "code":
          return `<code>${escapeHtml(node.text)}</code>`;
        case "strong":
          return `<strong>${inlineHtml(node.children)}</strong>`;
        case "em":
          return `<em>${inlineHtml(node.children)}</em>`;
        case "link":
          return node.href
            ? `<a href="${escapeHtml(node.href)}">${inlineHtml(node.children)}</a>`
            : inlineHtml(node.children);
      }
    })
    .join("");
}

// Clean HTML for a CMS's code view: every character of the source is escaped,
// only the tags below are ever written.
export function markdownToHtml(markdown: string): string {
  return parseMarkdown(markdown)
    .map((block) => {
      switch (block.type) {
        case "heading":
          return `<h${block.level}>${inlineHtml(block.children)}</h${block.level}>`;
        case "paragraph":
          return `<p>${inlineHtml(block.children)}</p>`;
        case "quote":
          return `<blockquote><p>${inlineHtml(block.children)}</p></blockquote>`;
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          const items = block.items
            .map((item) => `  <li>${inlineHtml(item.children)}</li>`)
            .join("\n");
          return `<${tag}>\n${items}\n</${tag}>`;
        }
      }
    })
    .join("\n");
}

// ---- Reading the article -------------------------------------------------------

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

export type ArticleStats = {
  words: number;
  // The text of each H2, in order.
  h2: string[];
  h1Count: number;
  // The words of each paragraph (list items and quotes are not paragraphs).
  paragraphWords: number[];
  // The first paragraph before or after the first heading, "" when none.
  firstParagraph: string;
};

export function articleStats(markdown: string): ArticleStats {
  const blocks = parseMarkdown(markdown);
  let words = 0;
  const h2: string[] = [];
  let h1Count = 0;
  const paragraphWords: number[] = [];
  let firstParagraph = "";
  for (const block of blocks) {
    if (block.type === "list") {
      for (const item of block.items) words += countWords(item.text);
      continue;
    }
    words += countWords(block.text);
    if (block.type === "heading") {
      if (block.level === 1) h1Count++;
      if (block.level === 2) h2.push(block.text);
      continue;
    }
    if (block.type === "paragraph") {
      paragraphWords.push(countWords(block.text));
      if (!firstParagraph) firstParagraph = block.text;
    }
  }
  return { words, h2, h1Count, paragraphWords, firstParagraph };
}

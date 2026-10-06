// GA-F3 site etiketi taraması (docs/measurement-health.md "Site taraması"):
// bağımlılıksız, hataya dayanıklı ileri yönlü HTML ayrıştırıcı. Yalnız
// etiket tespiti için gereken parçaları toplar: script'ler (src + satır içi
// metin), bağlantı adresleri (a[href]) ve form sayısı. Bozuk sayfa istisna
// atmaz, yalnız daha az veri verir. Sınırlar büyük ya da kötü niyetli
// sayfalarda süreyi ve belleği sınırlar.

export type HtmlParts = {
  scripts: { src: string | null; text: string }[];
  hrefs: string[];
  forms: number;
};

const MAX_HTML_CHARS = 1_500_000;
const MAX_TAGS = 20_000;
const MAX_SCRIPT_CHARS = 200_000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  "#39": "'",
  lt: "<",
  gt: ">",
};

function decodeEntities(value: string): string {
  return value.replace(
    /&(amp|quot|#39|lt|gt);/g,
    (_match, name: string) => ENTITIES[name] ?? "",
  );
}

function isSpace(char: string | undefined): boolean {
  return (
    char === " " ||
    char === "\n" ||
    char === "\t" ||
    char === "\r" ||
    char === "\f"
  );
}

function isLetter(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z]/.test(char);
}

type OpenTag = {
  name: string;
  attrs: Map<string, string>;
  // Etiketin bittiği ">" sonrası konum.
  end: number;
};

// `at` "<" sonrası harfin konumu. Ad küçük harfe çevrilir; nitelikler çift
// tırnaklı, tek tırnaklı, tırnaksız ya da değersiz olabilir. Aynı nitelik
// iki kez yazılmışsa ilki geçerlidir (tarayıcılar gibi).
function readOpenTag(html: string, at: number): OpenTag {
  let i = at;
  while (i < html.length && /[A-Za-z0-9:_-]/.test(html[i]!)) i += 1;
  const name = html.slice(at, i).toLowerCase();
  const attrs = new Map<string, string>();

  while (i < html.length) {
    while (i < html.length && (isSpace(html[i]) || html[i] === "/")) i += 1;
    if (i >= html.length) break;
    if (html[i] === ">") return { name, attrs, end: i + 1 };

    const nameStart = i;
    while (
      i < html.length &&
      !isSpace(html[i]) &&
      html[i] !== "=" &&
      html[i] !== ">" &&
      html[i] !== "/"
    ) {
      i += 1;
    }
    // "=" ile başlayan bozuk nitelik: karakteri atla.
    if (i === nameStart) {
      i += 1;
      continue;
    }
    const attrName = html.slice(nameStart, i).toLowerCase();

    let j = i;
    while (j < html.length && isSpace(html[j])) j += 1;
    let value = "";
    if (html[j] === "=") {
      j += 1;
      while (j < html.length && isSpace(html[j])) j += 1;
      const quote = html[j];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, j + 1);
        const stop = close === -1 ? html.length : close;
        value = html.slice(j + 1, stop);
        i = close === -1 ? html.length : close + 1;
      } else {
        const valueStart = j;
        while (j < html.length && !isSpace(html[j]) && html[j] !== ">") {
          j += 1;
        }
        value = html.slice(valueStart, j);
        i = j;
      }
    }
    if (!attrs.has(attrName)) attrs.set(attrName, decodeEntities(value));
  }
  return { name, attrs, end: html.length };
}

// Ham metin içeriği (script/style): büyük-küçük harf duyarsız kapanış
// etiketine kadar. Kapanış yoksa sayfanın sonuna kadar.
function rawTextEnd(
  html: string,
  from: number,
  tag: "script" | "style",
): { textEnd: number; next: number } {
  const close = new RegExp(`</${tag}(?=[\\s/>]|$)`, "gi");
  close.lastIndex = from;
  const match = close.exec(html);
  if (!match) return { textEnd: html.length, next: html.length };
  const gt = html.indexOf(">", match.index);
  return {
    textEnd: match.index,
    next: gt === -1 ? html.length : gt + 1,
  };
}

// Atlanacak yapının (yorum, DOCTYPE, CDATA, işleme talimatı) bittiği konum.
function skipSpecial(html: string, at: number, open: string, close: string) {
  const end = html.indexOf(close, at + open.length);
  return end === -1 ? html.length : end + close.length;
}

export function extractHtmlParts(html: string): HtmlParts {
  const parts: HtmlParts = { scripts: [], hrefs: [], forms: 0 };
  if (typeof html !== "string" || html.length === 0) return parts;
  const input = html.slice(0, MAX_HTML_CHARS);

  let i = 0;
  let tags = 0;
  while (i < input.length && tags < MAX_TAGS) {
    const lt = input.indexOf("<", i);
    if (lt === -1) break;
    const next = input[lt + 1];

    if (input.startsWith("<!--", lt)) {
      i = skipSpecial(input, lt, "<!--", "-->");
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      i = skipSpecial(input, lt, "<![CDATA[", "]]>");
      continue;
    }
    // DOCTYPE ve işleme talimatları (<?xml ...?>).
    if (next === "!" || next === "?") {
      i = skipSpecial(input, lt, "<", ">");
      continue;
    }
    // Kapanış etiketi: bilgi taşımaz.
    if (next === "/") {
      i = skipSpecial(input, lt, "</", ">");
      continue;
    }
    // "<" ardından harf yoksa düz metindir ("a < b").
    if (!isLetter(next)) {
      i = lt + 1;
      continue;
    }

    const tag = readOpenTag(input, lt + 1);
    tags += 1;
    i = tag.end;

    if (tag.name === "script" || tag.name === "style") {
      const raw = rawTextEnd(input, tag.end, tag.name);
      if (tag.name === "script") {
        parts.scripts.push({
          src: tag.attrs.get("src") ?? null,
          text: input.slice(tag.end, raw.textEnd).slice(0, MAX_SCRIPT_CHARS),
        });
      }
      i = raw.next;
      continue;
    }
    if (tag.name === "a") {
      const href = tag.attrs.get("href");
      if (href !== undefined) parts.hrefs.push(href);
      continue;
    }
    if (tag.name === "form") parts.forms += 1;
  }
  return parts;
}

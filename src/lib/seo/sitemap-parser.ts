// Sitemap ayrıştırıcısı (docs/google-search-console-plan.md SC-F3): urlset,
// sitemapindex ve düz metin sitemap. Doğrusal, indexOf tabanlı tarayıcıdır;
// tam bir XML ayrıştırıcısı değildir (ad alanı önekleri, CDATA ve varlıklar
// tanınır). Hiçbir zaman hata fırlatmaz: bozuk dosya "invalid" ve hata metniyle
// döner.

export type SitemapEntry = { loc: string; lastmod: string | null };
export type ParsedSitemap = {
  kind: "urlset" | "sitemapindex" | "text" | "invalid";
  urls: SitemapEntry[];
  sitemaps: SitemapEntry[];
  errors: string[];
  truncated: boolean;
};

const DEFAULT_MAX_URLS = 50_000;
const MAX_FIELD_LENGTH = 4_096;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function codePointText(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return "�";
  if (value >= 0xd800 && value <= 0xdfff) return "�";
  return String.fromCodePoint(value);
}

// XML'in beş adlandırılmış varlığı ve sayısal varlıklar; tanınmayan olduğu
// gibi kalır.
export function decodeXmlEntities(value: string): string {
  if (!value.includes("&")) return value;
  let out = "";
  let position = 0;
  while (position < value.length) {
    const amp = value.indexOf("&", position);
    if (amp < 0) {
      out += value.slice(position);
      break;
    }
    out += value.slice(position, amp);
    const semi = value.indexOf(";", amp + 1);
    if (semi < 0 || semi - amp > 12) {
      out += "&";
      position = amp + 1;
      continue;
    }
    const name = value.slice(amp + 1, semi);
    if (name.startsWith("#x") || name.startsWith("#X")) {
      out += /^[0-9a-f]+$/i.test(name.slice(2))
        ? codePointText(parseInt(name.slice(2), 16))
        : value.slice(amp, semi + 1);
    } else if (name.startsWith("#")) {
      out += /^[0-9]+$/.test(name.slice(1))
        ? codePointText(parseInt(name.slice(1), 10))
        : value.slice(amp, semi + 1);
    } else if (Object.hasOwn(NAMED_ENTITIES, name)) {
      out += NAMED_ENTITIES[name];
    } else {
      out += value.slice(amp, semi + 1);
    }
    position = semi + 1;
  }
  return out;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_ONLY = /^(\d{4})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// W3C tarih biçimleri → ISO; geçersiz → null.
export function parseLastmod(value: string | null): string | null {
  if (!value) return null;
  const text = value.trim();
  if (!text || text.length > 40) return null;
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const [year, month, day] = [
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
    ];
    return validDate(year, month, day)
      ? new Date(Date.UTC(year, month - 1, day)).toISOString()
      : null;
  }
  const monthOnly = MONTH_ONLY.exec(text);
  if (monthOnly) {
    const [year, month] = [Number(monthOnly[1]), Number(monthOnly[2])];
    return month >= 1 && month <= 12
      ? new Date(Date.UTC(year, month - 1, 1)).toISOString()
      : null;
  }
  const dateTime = DATE_TIME.exec(text);
  if (dateTime) {
    const [year, month, day] = [
      Number(dateTime[1]),
      Number(dateTime[2]),
      Number(dateTime[3]),
    ];
    const hour = Number(dateTime[4]);
    const minute = Number(dateTime[5]);
    const second = Number(dateTime[6] ?? "0");
    if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 60)
      return null;
    const time = Date.parse(text);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }
  return null;
}

function isAbsoluteHttp(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase();
}

function isNameChar(code: number): boolean {
  return !(
    code === 32 ||
    code === 9 ||
    code === 10 ||
    code === 13 ||
    code === 47 ||
    code === 62
  );
}

function empty(kind: ParsedSitemap["kind"], error?: string): ParsedSitemap {
  return {
    kind,
    urls: [],
    sitemaps: [],
    errors: error ? [error] : [],
    truncated: false,
  };
}

// Düz metin sitemap: boş olmayan her satır mutlak http(s) adresi.
function parseText(body: string, maxUrls: number): ParsedSitemap {
  const lines = body
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return empty("invalid", "The sitemap is empty");
  if (!lines.every(isAbsoluteHttp)) {
    return empty("invalid", "The sitemap is not valid XML or a list of URLs");
  }
  const result = empty("text");
  for (const line of lines) {
    if (result.urls.length >= maxUrls) {
      result.truncated = true;
      break;
    }
    result.urls.push({ loc: line, lastmod: null });
  }
  return result;
}

type Field = "loc" | "lastmod";
type OpenBlock = { loc: string | null; lastmod: string | null };

function parseXml(body: string, maxUrls: number): ParsedSitemap {
  let kind: "urlset" | "sitemapindex" | null = null;
  let rootClosed = false;
  const result = empty("invalid");
  let block: OpenBlock | null = null;
  let field: Field | null = null;
  let buffer = "";
  let missingLoc = 0;
  let invalidLoc = 0;
  let position = 0;

  const append = (text: string, decode: boolean) => {
    if (buffer.length >= MAX_FIELD_LENGTH) return;
    buffer += (decode ? decodeXmlEntities(text) : text).slice(0, MAX_FIELD_LENGTH);
  };

  // Biten <url>/<sitemap> bloğu listeye eklenir (ya da sayılır).
  const finish = (done: OpenBlock, entries: SitemapEntry[]) => {
    const loc = done.loc?.trim() ?? "";
    if (!loc) {
      missingLoc += 1;
      return;
    }
    if (!isAbsoluteHttp(loc)) {
      invalidLoc += 1;
      return;
    }
    if (entries.length >= maxUrls) {
      result.truncated = true;
      return;
    }
    entries.push({ loc, lastmod: parseLastmod(done.lastmod) });
  };

  while (position < body.length && !result.truncated) {
    const lt = body.indexOf("<", position);
    if (lt < 0) break;
    if (field) append(body.slice(position, lt), true);
    if (body.startsWith("<!--", lt)) {
      const end = body.indexOf("-->", lt + 4);
      position = end < 0 ? body.length : end + 3;
      continue;
    }
    if (body.startsWith("<![CDATA[", lt)) {
      const end = body.indexOf("]]>", lt + 9);
      if (field) append(body.slice(lt + 9, end < 0 ? body.length : end), false);
      position = end < 0 ? body.length : end + 3;
      continue;
    }
    const gt = body.indexOf(">", lt + 1);
    if (gt < 0) {
      if (!kind) return empty("invalid", "The sitemap is not valid XML");
      break;
    }
    position = gt + 1;
    const next = body[lt + 1];
    if (next === "?" || next === "!") continue;
    const closing = next === "/";
    const nameStart = lt + (closing ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < gt && isNameChar(body.charCodeAt(nameEnd))) nameEnd += 1;
    const name = localName(body.slice(nameStart, nameEnd));
    if (!name) continue;
    const selfClosing = !closing && body[gt - 1] === "/";

    if (!kind) {
      if (closing) continue;
      if (name !== "urlset" && name !== "sitemapindex") {
        return empty(
          "invalid",
          `The root element is <${name.slice(0, 40)}>, expected <urlset> or <sitemapindex>`,
        );
      }
      kind = name;
      result.kind = name;
      if (selfClosing) {
        rootClosed = true;
        break;
      }
      continue;
    }

    const entries = kind === "urlset" ? result.urls : result.sitemaps;
    const entryName = kind === "urlset" ? "url" : "sitemap";
    if (name === entryName) {
      // Kapanmamış önceki blok, yenisi açılınca biter.
      if (block) finish(block, entries);
      block = null;
      field = null;
      if (closing) continue;
      if (selfClosing) finish({ loc: null, lastmod: null }, entries);
      else block = { loc: null, lastmod: null };
      continue;
    }
    if (name === kind && closing) {
      if (block) finish(block, entries);
      block = null;
      rootClosed = true;
      break;
    }
    if (block && (name === "loc" || name === "lastmod")) {
      if (closing) {
        if (field === name) {
          const value = buffer.trim();
          if (name === "loc") block.loc = block.loc ?? value;
          else block.lastmod = block.lastmod ?? value;
        }
        field = null;
        buffer = "";
        continue;
      }
      if (!selfClosing) {
        field = name;
        buffer = "";
      }
    }
  }

  if (!kind) return empty("invalid", "The sitemap is not valid XML");
  if (block) finish(block, kind === "urlset" ? result.urls : result.sitemaps);
  if (missingLoc === 1) result.errors.push("An entry has no <loc>");
  else if (missingLoc > 1)
    result.errors.push(`${missingLoc} entries have no <loc>`);
  if (invalidLoc === 1) result.errors.push("An entry has an invalid <loc> URL");
  else if (invalidLoc > 1)
    result.errors.push(`${invalidLoc} entries have an invalid <loc> URL`);
  if (!rootClosed && !result.truncated) {
    result.errors.push(`The sitemap ends before </${kind}>`);
  }
  return result;
}

export function parseSitemap(
  body: string,
  options?: { maxUrls?: number },
): ParsedSitemap {
  const maxUrls = Math.max(0, options?.maxUrls ?? DEFAULT_MAX_URLS);
  try {
    const text = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
    const trimmed = text.trimStart();
    if (!trimmed) return empty("invalid", "The sitemap is empty");
    if (!trimmed.startsWith("<")) return parseText(trimmed, maxUrls);
    return parseXml(trimmed, maxUrls);
  } catch {
    return empty("invalid", "The sitemap could not be read");
  }
}

export function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

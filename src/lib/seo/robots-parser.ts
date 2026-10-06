import {
  CRAWL_MAX_CRAWL_DELAY_MS,
  ROBOTS_MAX_BYTES,
} from "@/lib/seo/audit-constants";
import { fnv1a64Hex } from "@/lib/seo/crawl-url";

// robots.txt ayrıştırıcısı ve eşleştiricisi (RFC 9309 + Google'ın belgelenmiş
// davranışı; docs/google-search-console-plan.md SC-F3). Elle yazılmıştır:
// dosya içeriğinden hiçbir zaman RegExp kurulmaz (ReDoS yok); eşleştirme
// desen × yol üzerinde konum kümesiyle yürür, geri izleme yapmaz.

export type RobotsRule = { allow: boolean; pattern: string };
export type RobotsGroup = {
  agents: string[];
  rules: RobotsRule[];
  crawlDelayMs: number | null;
};
export type ParsedRobots = {
  groups: RobotsGroup[];
  sitemaps: string[];
  invalidLines: number;
};

// Google'ın kabul ettiği yazım hataları dahil anahtarlar.
const USER_AGENT_KEYS = new Set(["user-agent", "useragent", "user agent"]);
const DISALLOW_KEYS = new Set([
  "disallow",
  "dissallow",
  "dissalow",
  "disalow",
  "diasllow",
  "disallaw",
]);
const SITEMAP_KEYS = new Set(["sitemap", "site-map"]);
const CRAWL_DELAY_KEYS = new Set(["crawl-delay", "crawldelay"]);

const MAX_PATH_LENGTH = 2_048;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

// Dosyanın yalnız ilk ROBOTS_MAX_BYTES baytı okunur (Google: 500 KiB).
function capBytes(text: string): string {
  if (text.length * 3 <= ROBOTS_MAX_BYTES) return text;
  const bytes = encoder.encode(text);
  if (bytes.length <= ROBOTS_MAX_BYTES) return text;
  return decoder.decode(bytes.subarray(0, ROBOTS_MAX_BYTES));
}

function splitLines(text: string): string[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return clean.split(/\r\n|\r|\n/);
}

// Ürün belirteci: "Googlebot/2.1 (...)" → "googlebot". "*" olduğu gibi kalır.
function productToken(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("*")) return "*";
  let end = 0;
  while (end < trimmed.length) {
    const code = trimmed.charCodeAt(end);
    const ok =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 45 ||
      code === 95;
    if (!ok) break;
    end += 1;
  }
  return trimmed.slice(0, end).toLowerCase();
}

type Directive = { key: string; value: string } | null;

// "# yorum" atılır; ":" olmayan satır geçersizdir.
function directiveOf(line: string): Directive | "invalid" {
  const hash = line.indexOf("#");
  const body = (hash >= 0 ? line.slice(0, hash) : line).trim();
  if (!body) return null;
  const colon = body.indexOf(":");
  if (colon <= 0) return "invalid";
  return {
    key: body.slice(0, colon).trim().toLowerCase(),
    value: body.slice(colon + 1).trim(),
  };
}

export function parseRobotsTxt(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let invalidLines = 0;
  let current: RobotsGroup | null = null;
  let previousWasAgent = false;
  for (const line of splitLines(capBytes(text))) {
    const directive = directiveOf(line);
    if (directive === null) continue;
    if (directive === "invalid") {
      invalidLines += 1;
      continue;
    }
    const { key, value } = directive;
    if (USER_AGENT_KEYS.has(key)) {
      const agent = productToken(value);
      // Art arda gelen user-agent satırları tek bir grup açar.
      if (!current || !previousWasAgent) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
      }
      if (agent && !current.agents.includes(agent)) current.agents.push(agent);
      previousWasAgent = true;
      continue;
    }
    if (SITEMAP_KEYS.has(key)) {
      // Sitemap satırları gruplardan bağımsızdır (genel).
      if (value) sitemaps.push(value);
      continue;
    }
    const isAllow = key === "allow";
    const isDisallow = DISALLOW_KEYS.has(key);
    const isDelay = CRAWL_DELAY_KEYS.has(key);
    if (!isAllow && !isDisallow && !isDelay) continue;
    previousWasAgent = false;
    // İlk user-agent satırından önceki kurallar yok sayılır.
    if (!current) continue;
    if (isDelay) {
      const seconds = Number(value);
      if (
        Number.isFinite(seconds) &&
        seconds >= 0 &&
        current.crawlDelayMs === null
      ) {
        current.crawlDelayMs = Math.min(
          Math.round(seconds * 1000),
          CRAWL_MAX_CRAWL_DELAY_MS,
        );
      }
      continue;
    }
    // Boş "disallow:" (ya da "allow:") kural değildir.
    if (!value) continue;
    current.rules.push({ allow: isAllow, pattern: value });
  }
  return { groups, sitemaps, invalidLines };
}

function mergeGroups(list: RobotsGroup[]): RobotsGroup | null {
  if (!list.length) return null;
  const agents: string[] = [];
  const rules: RobotsRule[] = [];
  let crawlDelayMs: number | null = null;
  for (const group of list) {
    for (const agent of group.agents)
      if (!agents.includes(agent)) agents.push(agent);
    rules.push(...group.rules);
    if (crawlDelayMs === null) crawlDelayMs = group.crawlDelayMs;
  }
  return { agents, rules, crawlDelayMs };
}

// Belirteci adlandıran bütün gruplar birleşir; yoksa "*" grupları; yoksa null.
// Eşleşme yalnız ürün belirteci üzerindedir: "Googlebot-Image" bir
// "Googlebot" grubuna, adı geçmedikçe girmez.
export function groupFor(
  robots: ParsedRobots,
  token: string,
): RobotsGroup | null {
  const wanted = productToken(token);
  if (wanted && wanted !== "*") {
    const named = robots.groups.filter((group) =>
      group.agents.includes(wanted),
    );
    if (named.length) return mergeGroups(named);
  }
  return starGroup(robots);
}

export function starGroup(robots: ParsedRobots): RobotsGroup | null {
  return mergeGroups(
    robots.groups.filter((group) => group.agents.includes("*")),
  );
}

function isHex(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

function isUnreserved(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 45 ||
    code === 46 ||
    code === 95 ||
    code === 126
  );
}

// %-kodlama tek biçime iner: onaltılık büyük harf, ayrılmamış karakterler
// çözülür, ASCII dışı karakterler UTF-8 olarak kodlanır. Desen ve yol aynı
// fonksiyondan geçer ("*" ve "$" ASCII olduğundan dokunulmaz).
function normalizePercent(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 37 &&
      index + 2 < value.length &&
      isHex(value.charCodeAt(index + 1)) &&
      isHex(value.charCodeAt(index + 2))
    ) {
      const hex = value.slice(index + 1, index + 3).toUpperCase();
      const decoded = parseInt(hex, 16);
      out += isUnreserved(decoded) ? String.fromCharCode(decoded) : `%${hex}`;
      index += 2;
      continue;
    }
    if (code > 127) {
      const point = value.codePointAt(index) ?? code;
      const char = String.fromCodePoint(point);
      try {
        out += encodeURIComponent(char);
      } catch {
        out += "%EF%BF%BD";
      }
      if (point > 0xffff) index += 1;
      continue;
    }
    out += value[index];
  }
  return out;
}

// Yol + sorgu; mutlak adres verilirse ayrıştırılır, parça atılır.
function pathForMatch(urlOrPath: string): string {
  let raw = urlOrPath.trim();
  if (!raw.startsWith("/")) {
    try {
      const parsed = new URL(raw);
      raw = `${parsed.pathname || "/"}${parsed.search}`;
    } catch {
      raw = `/${raw}`;
    }
  }
  const hash = raw.indexOf("#");
  if (hash >= 0) raw = raw.slice(0, hash);
  return normalizePercent(raw || "/").slice(0, MAX_PATH_LENGTH * 3);
}

// Google'ın konum kümesi algoritması: "*" herhangi bir diziyle, sondaki "$"
// yolun sonuyla eşleşir; aksi hâlde desen yolun önekidir. En kötü durum
// O(desen × yol); desendeki sabit karakter sayısı yolu aşarsa hemen biter.
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const pathLength = path.length;
  let literals = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char !== "*" && !(char === "$" && index === pattern.length - 1))
      literals += 1;
  }
  if (literals > pathLength) return false;
  let positions: number[] = [0];
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "$" && index === pattern.length - 1) {
      return positions[positions.length - 1] === pathLength;
    }
    if (char === "*") {
      // Art arda yıldızlar tek yıldızdır.
      while (index + 1 < pattern.length && pattern[index + 1] === "*")
        index += 1;
      const start = positions[0] ?? pathLength;
      const next: number[] = [];
      for (let position = start; position <= pathLength; position += 1)
        next.push(position);
      positions = next;
      continue;
    }
    const next: number[] = [];
    for (const position of positions) {
      if (position < pathLength && path[position] === char)
        next.push(position + 1);
    }
    if (!next.length) return false;
    positions = next;
  }
  return true;
}

export function isAllowedInGroup(
  group: RobotsGroup | null,
  urlOrPath: string,
): { allowed: boolean; rule: RobotsRule | null } {
  const path = pathForMatch(urlOrPath);
  if (path === "/robots.txt" || !group) return { allowed: true, rule: null };
  let best: RobotsRule | null = null;
  for (const rule of group.rules) {
    const pattern = normalizePercent(rule.pattern);
    if (!robotsPatternMatches(pattern, path)) continue;
    // En uzun desen kazanır; eşitlikte allow.
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return { allowed: best ? best.allow : true, rule: best };
}

export function isAllowed(
  robots: ParsedRobots | null,
  productTokenValue: string,
  urlOrPath: string,
): { allowed: boolean; rule: RobotsRule | null } {
  if (!robots) return { allowed: true, rule: null };
  return isAllowedInGroup(groupFor(robots, productTokenValue), urlOrPath);
}

export type RobotsFetchVerdict =
  "OK" | "MISSING" | "SERVER_ERROR" | "UNREACHABLE";

// Google: 4xx (429 hariç) dosya yok sayılır = her şey serbest; 429 ve 5xx
// taramayı durdurur; yanıt yoksa ulaşılamadı. 3xx buraya yalnız yönlendirme
// sınırı aşıldığında düşer; Google bunu da 404 gibi sayar.
export function robotsVerdictForStatus(
  status: number | null,
): RobotsFetchVerdict {
  if (status === null) return "UNREACHABLE";
  if (status >= 200 && status < 300) return "OK";
  if (status === 429) return "SERVER_ERROR";
  if (status >= 300 && status < 500) return "MISSING";
  if (status >= 500 && status < 600) return "SERVER_ERROR";
  return "UNREACHABLE";
}

export const AI_CRAWLERS: readonly {
  token: string;
  owner: string;
  purpose: "search" | "training";
}[] = [
  { token: "OAI-SearchBot", owner: "OpenAI", purpose: "search" },
  { token: "ChatGPT-User", owner: "OpenAI", purpose: "search" },
  { token: "GPTBot", owner: "OpenAI", purpose: "training" },
  { token: "Claude-SearchBot", owner: "Anthropic", purpose: "search" },
  { token: "Claude-User", owner: "Anthropic", purpose: "search" },
  { token: "ClaudeBot", owner: "Anthropic", purpose: "training" },
  { token: "PerplexityBot", owner: "Perplexity", purpose: "search" },
  { token: "Google-Extended", owner: "Google", purpose: "training" },
  { token: "Applebot-Extended", owner: "Apple", purpose: "training" },
  { token: "CCBot", owner: "Common Crawl", purpose: "training" },
  { token: "Bytespider", owner: "ByteDance", purpose: "training" },
];

// Ana sayfa ("/") için her AI tarayıcısının izni.
export function aiCrawlerAccess(robots: ParsedRobots | null): {
  token: string;
  owner: string;
  purpose: "search" | "training";
  allowed: boolean;
}[] {
  return AI_CRAWLERS.map((crawler) => ({
    ...crawler,
    allowed: isAllowed(robots, crawler.token, "/").allowed,
  }));
}

function normalizedText(text: string): string {
  return splitLines(text)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function robotsTextHash(text: string): string {
  return fnv1a64Hex(normalizedText(text));
}

// Yönerge satırları "anahtar: değer" biçimine iner (yorum, boşluk, büyük-küçük
// harf farkı değişiklik sayılmaz).
function directiveLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of splitLines(capBytes(text))) {
    const directive = directiveOf(line);
    if (!directive || directive === "invalid") continue;
    lines.push(`${directive.key}: ${directive.value}`);
  }
  return lines;
}

const DIFF_MAX = 50;

// Çoklu küme farkı: satır sırası değişikliği fark sayılmaz, tekrar sayısı sayılır.
export function robotsDiff(
  previous: string,
  current: string,
): { added: string[]; removed: string[] } {
  const before = directiveLines(previous);
  const after = directiveLines(current);
  const extra = (from: string[], against: string[]): string[] => {
    const counts = new Map<string, number>();
    for (const line of against) counts.set(line, (counts.get(line) ?? 0) + 1);
    const out: string[] = [];
    for (const line of from) {
      const left = counts.get(line) ?? 0;
      if (left > 0) {
        counts.set(line, left - 1);
        continue;
      }
      if (out.length < DIFF_MAX) out.push(line);
    }
    return out;
  };
  return { added: extra(after, before), removed: extra(before, after) };
}

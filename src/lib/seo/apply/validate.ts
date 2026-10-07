import { articleStats } from "@/lib/module-flows/seo/markdown";

// SC-F8: siteye gidecek metinlerin doğrulanması ve temizlenmesi. Saf dosya.
// Temizleyiciler denetim karakterlerini ve < > işaretlerini atar, boşlukları
// tek boşluğa indirir; sınırlar APPLY_LIMITS'te tek yerde durur.

export const APPLY_LIMITS = {
  titleMax: 70,
  metaMax: 170,
  excerptMax: 300,
  articleMinWords: 150,
  markdownMax: 60_000,
  anchorMin: 2,
  anchorMax: 60,
  linksMax: 3,
  dailyMin: 1,
  dailyMax: 25,
  dailyDefault: 10,
  contentRawMax: 200_000,
  titleMetaMinChange: 1,
} as const;

// WordPress yazı başlığı SEO başlığından geniş olabilir; en çok 120.
const POST_TITLE_MAX = 120;

// Denetim karakterleri (satır sonu dahil) boşluğa, < ve > hiçbir şeye döner.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function cleanLine(raw: string): string {
  return raw.replace(CONTROL, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}

function length(text: string): number {
  return Array.from(text).length;
}

function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("").trim();
}

// Yazı başlığı: temizlenir, 120 karakterde kesilir.
export function titleForPost(title: string): string {
  return cut(cleanLine(title), POST_TITLE_MAX);
}

type Optional =
  | { present: false }
  | { present: true; value: string }
  | { present: false; invalid: true };

// undefined / null / boş = "değiştirme"; metin dışı bir değer geçersizdir.
function optionalLine(raw: unknown): Optional {
  if (raw === undefined || raw === null) return { present: false };
  if (typeof raw !== "string") return { present: false, invalid: true };
  const value = cleanLine(raw);
  return value ? { present: true, value } : { present: false };
}

export function validateTitleMeta(raw: {
  title?: unknown;
  metaDescription?: unknown;
}):
  | { ok: true; title: string | null; metaDescription: string | null }
  | { ok: false; message: string } {
  const title = optionalLine(raw.title);
  const meta = optionalLine(raw.metaDescription);
  if ("invalid" in title || "invalid" in meta) {
    return { ok: false, message: "Enter the title and description as text." };
  }
  const titleValue = title.present ? title.value : null;
  const metaValue = meta.present ? meta.value : null;
  if (titleValue === null && metaValue === null) {
    return { ok: false, message: "Enter a title or a description." };
  }
  if (titleValue !== null && length(titleValue) > APPLY_LIMITS.titleMax) {
    return {
      ok: false,
      message: `The title can be at most ${APPLY_LIMITS.titleMax} characters.`,
    };
  }
  if (metaValue !== null && length(metaValue) > APPLY_LIMITS.metaMax) {
    return {
      ok: false,
      message: `The description can be at most ${APPLY_LIMITS.metaMax} characters.`,
    };
  }
  return { ok: true, title: titleValue, metaDescription: metaValue };
}

// Markdown satır sonlarını korur; yalnız NUL ve diğer denetim karakterleri
// (satır sonu ve sekme hariç) atılır.
function cleanMarkdown(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

export function validateArticle(raw: {
  title: unknown;
  metaDescription: unknown;
  markdown: unknown;
}):
  | {
      ok: true;
      title: string;
      metaDescription: string;
      markdown: string;
      words: number;
    }
  | { ok: false; message: string } {
  if (typeof raw.title !== "string" || typeof raw.markdown !== "string") {
    return { ok: false, message: "The article needs a title and text." };
  }
  if (raw.metaDescription !== undefined && raw.metaDescription !== null && typeof raw.metaDescription !== "string") {
    return { ok: false, message: "Enter the description as text." };
  }
  const title = cleanLine(raw.title);
  if (!title) return { ok: false, message: "The article needs a title." };
  if (length(title) > APPLY_LIMITS.titleMax) {
    return {
      ok: false,
      message: `The title can be at most ${APPLY_LIMITS.titleMax} characters.`,
    };
  }
  const metaDescription = cleanLine(
    typeof raw.metaDescription === "string" ? raw.metaDescription : "",
  );
  if (length(metaDescription) > APPLY_LIMITS.metaMax) {
    return {
      ok: false,
      message: `The description can be at most ${APPLY_LIMITS.metaMax} characters.`,
    };
  }
  const markdown = cleanMarkdown(raw.markdown);
  if (markdown.length > APPLY_LIMITS.markdownMax) {
    return { ok: false, message: "The article is too long to send." };
  }
  const words = articleStats(markdown).words;
  if (words < APPLY_LIMITS.articleMinWords) {
    return {
      ok: false,
      message: `The article needs at least ${APPLY_LIMITS.articleMinWords} words.`,
    };
  }
  return { ok: true, title, metaDescription, markdown, words };
}

// Günlük sınır: 1..25 tam sayı, geçersizse varsayılan.
export function clampDailyLimit(value: unknown): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(num)) return APPLY_LIMITS.dailyDefault;
  return Math.min(
    APPLY_LIMITS.dailyMax,
    Math.max(APPLY_LIMITS.dailyMin, Math.trunc(num)),
  );
}

// WordPress Application Password'ü boşluklu (4'lü gruplar) gösterir; boşluklar
// atılır, 24 harf-rakam kalmalıdır.
export function normalizeAppPassword(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.replace(/\s+/g, "");
  return /^[A-Za-z0-9]{24}$/.test(value) ? value : null;
}

export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length < 1 || value.length > 60) return null;
  if (/[\u0000-\u001f\u007f:]/.test(value)) return null;
  return value;
}

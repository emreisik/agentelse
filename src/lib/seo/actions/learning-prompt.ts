// SEO öğrenmelerinin istem satırı (docs/google-search-console-plan.md SC-F6).
// Bağlam nesnesi context.seoLearnings'te (sunucu tarafında okunan, rakamsız
// öğrenme metinleri) en çok beş satır taşır; yoksa istem aynen kalır.

const LINES_MAX = 5;
const LINE_MAX_CHARS = 240;
const HEADER = "PAST RESULTS on this site (prefer what worked):";

export function seoLearningsPromptLine(
  context: Record<string, unknown>,
): string | null {
  const raw = context.seoLearnings;
  if (!Array.isArray(raw)) return null;
  const lines: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push(`- ${text.length > LINE_MAX_CHARS ? text.slice(0, LINE_MAX_CHARS).trimEnd() : text}`);
    if (lines.length >= LINES_MAX) break;
  }
  return lines.length > 0 ? `${HEADER}\n${lines.join("\n")}` : null;
}

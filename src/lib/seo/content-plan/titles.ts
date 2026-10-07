import { meaningfulTokens } from "@/lib/seo/tokens";
import { foldForMatch } from "@/lib/text-fold";
import { cleanWorksTextOrNull } from "@/lib/works/clean-text";

import type { PlanCandidate } from "./types";

// Başlık, açı ve açıklama (SC-F7): model sözcükleri doğrulanır, düşerse temel
// (kural tabanlı) metin kullanılır. Saf ve izomorfik.

export const TITLE_MAX = 90;
export const ANGLE_MAX = 300;
export const DESCRIPTION_MAX = 200;

function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  if (chars.length <= max) return chars.join("");
  const cut = chars.slice(0, max).join("");
  // Sözcük sınırında kes (kesilen sözcük yarım kalmasın) ama çok geriye gitme.
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

function upperFirst(text: string, language: string | null | undefined): string {
  const chars = Array.from(text);
  if (chars.length === 0) return text;
  let first: string;
  try {
    first = chars[0]!.toLocaleUpperCase(language ?? undefined);
  } catch {
    // Geçersiz yerel ayar etiketi: dil bağımsız büyütme.
    first = chars[0]!.toUpperCase();
  }
  return first + chars.slice(1).join("");
}

function isEnglish(language: string | null | undefined): boolean {
  return language == null || language.toLowerCase().startsWith("en");
}

// Anahtar kelimenin ilk harfi (projenin dilinin yerel ayarıyla: tr için
// "istanbul" -> "İstanbul") büyütülmüş hâli; en çok 90 karakter.
export function basicTitle(
  keyword: string,
  language?: string | null,
): string {
  return clip(upperFirst(keyword.replace(/\s+/g, " ").trim(), language), TITLE_MAX);
}

// Sabit İngilizce cümleler YALNIZ dil bilinmiyorsa ya da İngilizceyse; başka
// dilde boş döner (planlayıcı idea kavramı boş metin kabul etmiyorsa başlığı
// koyar).
export function basicAngle(
  candidate: Pick<PlanCandidate, "kind">,
  language?: string | null,
): string {
  if (!isEnglish(language)) return "";
  return candidate.kind === "PILLAR"
    ? "The main guide on this topic: cover it end to end and link out to the details."
    : "Answer this one question fully, then link to the main page on the topic.";
}

export function basicDescription(
  keyword: string,
  language?: string | null,
): string {
  if (!isEnglish(language)) return "";
  return clip(`Everything to know about ${keyword.trim()}.`, DESCRIPTION_MAX);
}

function digitRuns(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

// Metindeki her rakam öbeği kaynaklarda da geçiyor mu ("2026" anahtar
// kelimedeyse serbest); geçmeyen rakam uydurulmuş sayılır.
export function hasInventedDigits(
  text: string,
  allowedSources: readonly string[],
): boolean {
  const allowed = new Set(allowedSources.flatMap(digitRuns));
  return digitRuns(text).some((run) => !allowed.has(run));
}

export type CleanWording = { title: string; angle: string; description: string };

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Modelin ham cevabı ({ items: [{ id, title, angle?, description? }] } ya da
// doğrudan dizi), id aday kimliğidir. Geçersiz öğe düşer, aynı kimliğin ikincisi
// atılır, bilinmeyen kimlik atılır; asla fırlatmaz. Başlık: en az bir anahtar
// kelime sözcüğü, uydurma rakam yok, <= 90. Açı/açıklama geçersizse "" olur.
export function cleanWording(
  raw: unknown,
  candidates: readonly PlanCandidate[],
): Map<string, CleanWording> {
  const out = new Map<string, CleanWording>();
  try {
    const list = Array.isArray(raw) ? raw : recordOf(raw)?.items;
    if (!Array.isArray(list)) return out;
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    for (const item of list) {
      const record = recordOf(item);
      if (!record) continue;
      const id = typeof record.id === "string" ? record.id : null;
      if (id === null || out.has(id)) continue;
      const candidate = byId.get(id);
      if (!candidate) continue;
      const title = cleanWorksTextOrNull(record.title, TITLE_MAX);
      if (title === null) continue;
      const sources = [candidate.keyword, ...candidate.queries];
      const foldedTitle = foldForMatch(title);
      const tokens = meaningfulTokens(candidate.keyword);
      if (tokens.length > 0 && !tokens.some((token) => foldedTitle.includes(foldForMatch(token)))) {
        continue;
      }
      if (hasInventedDigits(title, sources)) continue;
      const angleRaw = cleanWorksTextOrNull(record.angle, ANGLE_MAX);
      const descriptionRaw = cleanWorksTextOrNull(record.description, DESCRIPTION_MAX);
      out.set(id, {
        title,
        angle: angleRaw && !hasInventedDigits(angleRaw, sources) ? angleRaw : "",
        description:
          descriptionRaw && !hasInventedDigits(descriptionRaw, sources)
            ? descriptionRaw
            : "",
      });
    }
  } catch {
    // Beklenmeyen biçim: o ana dek toplananlarla devam edilir.
  }
  return out;
}

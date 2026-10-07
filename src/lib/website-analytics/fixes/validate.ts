import { GA_FIX_KINDS, type GaFixKind, type GaFixParams } from "./types";

// GA-F7 kullanıcı girdisinin doğrulanması: yalnız Agentelse'in kendi
// önerdiği, güvenli biçimli değerler Google'a gider.

export const ANNOTATION_PREFIX = "Agentelse: ";
export const ANNOTATION_MAX_LENGTH = 60;

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const RESERVED_PREFIXES = ["google_", "ga_", "firebase_"] as const;
// Google'ın kendi ürettiği olay adları anahtar olay yapılmaz.
const RESERVED_EVENTS: ReadonlySet<string> = new Set([
  "page_view",
  "session_start",
  "first_visit",
  "user_engagement",
]);

export type ValidateResult =
  | { ok: true; params: GaFixParams }
  | { ok: false; code: "invalid"; message: string };

function invalid(message: string): ValidateResult {
  return { ok: false, code: "invalid", message };
}

export function isValidEventName(value: unknown): value is string {
  if (typeof value !== "string" || !EVENT_NAME.test(value)) return false;
  const lower = value.toLowerCase();
  if (RESERVED_EVENTS.has(lower)) return false;
  return !RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// Kontrol karakterleri, < >, URL biçimli parçalar atılır; boşluklar tek
// boşluğa iner.
export function sanitizeAnnotationSubject(value: string): string {
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[<>]/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ")
    .replace(/\bwww\.\S*/gi, " ")
    .replace(/\b[\w-]+(?:\.[\w-]+)+\/\S*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.replace(/^agentelse:\s*/i, "").trim();
}

// Başlık 'Agentelse: ' ile başlar ve toplam 60 karakteri (kod noktası)
// geçmez; kesilen konunun sonundaki boşluk atılır.
export function buildAnnotationTitle(rawTitle: string): string | null {
  const subject = sanitizeAnnotationSubject(rawTitle);
  const room = ANNOTATION_MAX_LENGTH - ANNOTATION_PREFIX.length;
  const cut = Array.from(subject).slice(0, room).join("").trim();
  if (!cut) return null;
  return `${ANNOTATION_PREFIX}${cut}`;
}

function parseDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const at = Date.UTC(year, month - 1, day);
  const date = new Date(at);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return at;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isKind(value: unknown): value is GaFixKind {
  return (
    typeof value === "string" && (GA_FIX_KINDS as readonly string[]).includes(value)
  );
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

export function validateFixParams(
  kind: GaFixKind,
  raw: unknown,
  ctx: { today: string },
): ValidateResult {
  if (!isKind(kind)) return invalid("Unknown kind of change.");
  switch (kind) {
    case "RETENTION_14M":
    case "ENHANCED_MEASUREMENT":
    case "CHANNEL_GROUP_AI":
      return { ok: true, params: { kind } };
    case "KEY_EVENT_CREATE": {
      const record = asRecord(raw);
      const name = record?.eventName;
      if (typeof name !== "string") return invalid("Choose an event name.");
      const eventName = name.trim();
      if (!isValidEventName(eventName)) {
        return invalid(
          "Use letters, digits and underscores only, start with a letter, and avoid reserved names.",
        );
      }
      return { ok: true, params: { kind, eventName } };
    }
    case "ANNOTATION_CREATE": {
      const record = asRecord(raw);
      if (!record) return invalid("Write a short note.");
      const title =
        typeof record.title === "string"
          ? buildAnnotationTitle(record.title)
          : null;
      if (!title) return invalid("Write a short note.");
      const day = typeof record.day === "string" ? record.day.trim() : "";
      const dayAt = parseDay(day);
      const todayAt = parseDay(ctx.today);
      if (dayAt === null || todayAt === null) {
        return invalid("Choose a valid date.");
      }
      if (dayAt < todayAt - 30 * DAY_MS || dayAt > todayAt + DAY_MS) {
        return invalid("Choose a date within the last 30 days.");
      }
      return { ok: true, params: { kind, title, day } };
    }
  }
}

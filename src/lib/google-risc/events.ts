// Google RISC (Cross-Account Protection) güvenlik olayları: saf ayrıştırma.
// Bu dosya hiçbir proje modülünü içe aktarmaz: prisma/google-risc-register.ts
// betiği onu düz `npx tsx` ile göreli yoldan yükler. Alan adları ve URI'ler
// Google'ın RISC belgesinden alınmıştır (doğrulanmalı: gerçek bir olayla);
// bilinmeyen olaylar sessizce düşer, hiçbir yol fırlatmaz.

export type RiscEventKey =
  | "tokens-revoked"
  | "token-revoked"
  | "account-disabled"
  | "account-enabled"
  | "account-purged"
  | "sessions-revoked"
  | "credential-change-required"
  | "verification";

const RISC_BASE = "https://schemas.openid.net/secevent/risc/event-type/";
const OAUTH_BASE = "https://schemas.openid.net/secevent/oauth/event-type/";

export const RISC_EVENT_URIS: Readonly<Record<RiscEventKey, string>> = {
  "tokens-revoked": `${OAUTH_BASE}tokens-revoked`,
  "token-revoked": `${OAUTH_BASE}token-revoked`,
  "account-disabled": `${RISC_BASE}account-disabled`,
  "account-enabled": `${RISC_BASE}account-enabled`,
  "account-purged": `${RISC_BASE}account-purged`,
  "sessions-revoked": `${RISC_BASE}sessions-revoked`,
  "credential-change-required": `${RISC_BASE}account-credential-change-required`,
  verification: `${RISC_BASE}verification`,
};

export type RiscAction = "REVOKE" | "RECHECK" | "NOOP";

// REVOKE: bağlantı hemen EXPIRED olur. RECHECK: tek token iptali; hangi
// bağlantıya ait olduğu apply() içinde token kimliğiyle eşleştirilir.
export function riscActionFor(key: RiscEventKey): RiscAction {
  switch (key) {
    case "tokens-revoked":
    case "account-disabled":
    case "account-purged":
      return "REVOKE";
    case "token-revoked":
      return "RECHECK";
    default:
      return "NOOP";
  }
}

export const RISC_ACCEPTED_ISSUERS: readonly string[] = [
  "https://accounts.google.com/",
  "https://accounts.google.com",
  "accounts.google.com",
];

export type RiscTokenIdentifier = {
  type: string | null;
  alg: string;
  value: string;
};

export type RiscEvent = {
  key: RiscEventKey;
  sub: string | null;
  reason: string | null;
  token: RiscTokenIdentifier | null;
  state: string | null;
};

export type RiscClaims = {
  jti: string;
  iss: string;
  aud: string[];
  iat: number;
  // Ayrıştırılır ama asla zorlanmaz: olaylar tarihseldir, yeniden denemeler eski olabilir.
  exp: number | null;
  events: RiscEvent[];
};

const KEY_BY_URI = new Map<string, RiscEventKey>(
  (Object.entries(RISC_EVENT_URIS) as [RiscEventKey, string][]).map(
    ([key, uri]) => [uri, key],
  ),
);

const MAX_FIELD = 2048;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD
    ? value
    : null;
}

function subjectOf(subject: Record<string, unknown> | null): string | null {
  if (!subject) return null;
  const type = subject.subject_type;
  if (type === "iss-sub") {
    const iss = text(subject.iss);
    if (iss && !RISC_ACCEPTED_ISSUERS.includes(iss)) return null;
    return text(subject.sub);
  }
  if (type === "id_token_claims") return text(subject.sub);
  return null;
}

function tokenOf(
  event: Record<string, unknown>,
  subject: Record<string, unknown> | null,
): RiscTokenIdentifier | null {
  for (const source of [subject, event]) {
    if (!source) continue;
    const alg = text(source.token_identifier_alg);
    const value = text(source.token);
    if (alg && value) {
      return { type: text(source.token_type), alg, value };
    }
  }
  return null;
}

export function parseRiscClaims(payload: unknown): RiscClaims | null {
  try {
    const claims = record(payload);
    if (!claims) return null;
    const jti = text(claims.jti);
    const iss = text(claims.iss);
    const iat = typeof claims.iat === "number" && Number.isFinite(claims.iat) ? claims.iat : null;
    if (!jti || !iss || iat === null) return null;
    const rawAud = claims.aud;
    const aud = (Array.isArray(rawAud) ? rawAud : [rawAud]).flatMap((entry) => {
      const value = text(entry);
      return value ? [value] : [];
    });
    const rawEvents = record(claims.events);
    if (!rawEvents) return null;
    const events: RiscEvent[] = [];
    for (const [uri, body] of Object.entries(rawEvents)) {
      const key = KEY_BY_URI.get(uri);
      if (!key) continue;
      const event = record(body) ?? {};
      const subject = record(event.subject);
      events.push({
        key,
        sub: subjectOf(subject),
        reason: text(event.reason),
        token: tokenOf(event, subject),
        state: text(event.state),
      });
    }
    if (events.length === 0) return null;
    return {
      jti,
      iss,
      aud,
      iat,
      exp: typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : null,
      events,
    };
  } catch {
    return null;
  }
}

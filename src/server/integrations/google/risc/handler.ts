import "server-only";

import { RISC_ACCEPTED_ISSUERS, parseRiscClaims } from "@/lib/google-risc/events";
import { decodeJwt, verifyRs256, type Jwk } from "@/lib/google-risc/jwt";
import { prisma } from "@/lib/prisma";

import { applyRiscEvents, type RiscApplyResult } from "./apply";
import { getGoogleRiscKey } from "./jwks";

// RISC jetonunun işlenmesi (docs/website-agency.md "RISC"): imza, iss, aud,
// iat denetimi, jti ile tekrar koruması ve olayların uygulanması. Bilinçli
// olarak exp ve azami yaş denetimi YOKTUR: olaylar tarihseldir ve yeniden
// denemeler meşru biçimde eskidir; tekrar güvenliği jti kaydından ve uygulamanın
// idempotent olmasından gelir. Yalnız depo hatasında (ve uygulama yarıda
// kalınca) fırlatır; böylece uç 500 döner ve Google yeniden dener.

const IAT_SKEW_SECONDS = 5 * 60;

export type RiscDeps = {
  getKey: (kid: string) => Promise<Jwk | null>;
  now: () => Date;
  audiences: () => string[];
};

export type RiscOutcome = {
  status: "applied" | "duplicate" | "ignored" | "invalid";
  reason?: string;
  events: number;
  matched: number;
};

// GOOGLE_OAUTH_CLIENT_ID her zaman kabul edilir; GOOGLE_RISC_AUDIENCES ek
// (virgülle ayrılmış) hedef kitle değerleri ekler.
function defaultAudiences(): string[] {
  return [
    process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    ...(process.env.GOOGLE_RISC_AUDIENCES ?? "").split(","),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
}

const defaults: RiscDeps = {
  getKey: (kid) => getGoogleRiscKey(kid),
  now: () => new Date(),
  audiences: defaultAudiences,
};

function invalid(reason: string): RiscOutcome {
  return { status: "invalid", reason, events: 0, matched: 0 };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function statusOf(result: RiscApplyResult): RiscOutcome["status"] {
  return result.outcome === "APPLIED" ? "applied" : "ignored";
}

export async function processRiscToken(
  token: string,
  overrides: Partial<RiscDeps> = {},
): Promise<RiscOutcome> {
  const deps: RiscDeps = { ...defaults, ...overrides };
  const decoded = decodeJwt(token);
  if (!decoded) return invalid("malformed");
  const kid = decoded.header.kid;
  if (typeof kid !== "string" || kid.length === 0) return invalid("no_kid");
  const key = await deps.getKey(kid);
  if (!key) return invalid("unknown_key");
  if (!verifyRs256(decoded, key)) return invalid("bad_signature");

  const claims = parseRiscClaims(decoded.payload);
  if (!claims) return invalid("bad_claims");
  if (!RISC_ACCEPTED_ISSUERS.includes(claims.iss)) return invalid("bad_issuer");
  const audiences = deps.audiences();
  if (!claims.aud.some((aud) => audiences.includes(aud))) {
    return invalid("bad_audience");
  }
  const now = deps.now();
  if (claims.iat > now.getTime() / 1000 + IAT_SKEW_SECONDS) {
    return invalid("iat_in_future");
  }

  const eventKeys = claims.events.map((event) => event.key);
  // Önce PENDING satırı: uygulama yarıda kalırsa Google'ın yeniden denemesi
  // satırı PENDING bulur ve olayı tekrar uygular (idempotent).
  try {
    await prisma.googleRiscEvent.create({
      data: { jti: claims.jti, eventKeys, outcome: "PENDING" },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await prisma.googleRiscEvent.findUnique({
      where: { jti: claims.jti },
      select: { outcome: true, matched: true },
    });
    if (!existing || existing.outcome !== "PENDING") {
      return {
        status: "duplicate",
        events: claims.events.length,
        matched: existing?.matched ?? 0,
      };
    }
  }

  const result = await applyRiscEvents(claims.events, now);
  await prisma.googleRiscEvent.update({
    where: { jti: claims.jti },
    data: { outcome: result.outcome, matched: result.matched },
  });
  return {
    status: statusOf(result),
    events: claims.events.length,
    matched: result.matched,
  };
}

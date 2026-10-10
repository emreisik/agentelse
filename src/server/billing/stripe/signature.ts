import { createHmac, timingSafeEqual } from "node:crypto";

// Stripe webhook imzası (Stripe-Signature: "t=<unix>,v1=<hex>[,v1=<hex>][,v0=<hex>]").
// İmzalanan metin "<t>.<HAM gövde>" (JSON'u yeniden serileştirmek imzayı bozar: baytlar
// aynen gelmeli), anahtar webhook sırrının kendisidir (whsec_… dizgesi olduğu gibi).
// Sır döndürülürken birden çok v1 ve birden çok sır olabilir: biri tutarsa geçer.
// Saf (yalnız node:crypto), tek başına birim testlidir.

export const STRIPE_SIGNATURE_TOLERANCE_SEC = 300;

export type SignatureCheck =
  | { ok: true; timestamp: number }
  | {
      ok: false;
      reason:
        | "missing-header"
        | "malformed"
        | "no-secret"
        | "mismatch"
        | "timestamp-out-of-tolerance";
    };

type ParsedHeader = { timestamp: number; signatures: Buffer[] } | null;

function parseHeader(header: string): ParsedHeader {
  let timestamp: number | null = null;
  const signatures: Buffer[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && timestamp === null && /^\d{1,12}$/.test(value)) {
      timestamp = Number(value);
    } else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) {
      signatures.push(Buffer.from(value, "hex"));
    }
  }
  return timestamp === null || signatures.length === 0
    ? null
    : { timestamp, signatures };
}

// Gövdeyi OKUMADAN önceki ucuz denetim: başlık biçimli mi (t=<sayı>, en az bir 64 onaltılık
// v1) ve zaman damgası toleransta mı? Kimliksiz bir istek rastgele bir başlıkla (ör. "x")
// 512 KB'lık gövde tamponlatamaz; imzanın gerçekten tutup tutmadığı gövde okunduktan sonra
// verifyStripeSignature ile belirlenir.
export function isPlausibleSignatureHeader(
  header: string | null,
  options: { now?: Date; toleranceSec?: number } = {},
): boolean {
  if (!header) return false;
  const parsed = parseHeader(header);
  if (!parsed) return false;
  const nowSec = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const tolerance = options.toleranceSec ?? STRIPE_SIGNATURE_TOLERANCE_SEC;
  return Math.abs(nowSec - parsed.timestamp) <= tolerance;
}

export function verifyStripeSignature(input: {
  rawBody: Buffer | string;
  header: string | null;
  secrets: readonly string[];
  now?: Date;
  toleranceSec?: number;
}): SignatureCheck {
  if (!input.header) return { ok: false, reason: "missing-header" };
  const secrets = input.secrets.filter((secret) => secret.length > 0);
  if (secrets.length === 0) return { ok: false, reason: "no-secret" };
  const parsed = parseHeader(input.header);
  if (!parsed) return { ok: false, reason: "malformed" };

  const body =
    typeof input.rawBody === "string"
      ? Buffer.from(input.rawBody, "utf8")
      : input.rawBody;
  const signedPayload = Buffer.concat([
    Buffer.from(`${parsed.timestamp}.`, "utf8"),
    body,
  ]);

  // Hiçbir karşılaştırmada erken çıkış yok: süre, hangi sırrın/imzanın tuttuğunu
  // sızdırmasın.
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret)
      .update(signedPayload)
      .digest();
    for (const given of parsed.signatures) {
      if (
        given.length === expected.length &&
        timingSafeEqual(given, expected)
      ) {
        matched = true;
      }
    }
  }
  if (!matched) return { ok: false, reason: "mismatch" };

  const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const tolerance = input.toleranceSec ?? STRIPE_SIGNATURE_TOLERANCE_SEC;
  if (Math.abs(nowSec - parsed.timestamp) > tolerance) {
    return { ok: false, reason: "timestamp-out-of-tolerance" };
  }
  return { ok: true, timestamp: parsed.timestamp };
}

// Test ve belge yardımcısı: geçerli bir başlık üretir.
export function signStripePayload(
  rawBody: string,
  secret: string,
  timestamp: number,
): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

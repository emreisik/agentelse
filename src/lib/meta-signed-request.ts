import { createHmac, timingSafeEqual } from "node:crypto";

// Meta calls an app's "Deauthorize callback URL" and "Data deletion request
// URL" with a form POST whose `signed_request` is `<signature>.<payload>`, both
// base64url: the signature is HMAC-SHA256 of the payload text with the app
// secret, the payload a JSON object with the app-scoped `user_id`. The request
// carries no session, so this signature is the only proof it came from Meta.
//
// Everything before the signature check runs on input from an unauthenticated
// caller, so it is kept cheap and bounded: a hard length cap, no regular
// expression, and nothing is decoded or parsed until the signature has matched.

export type SignedRequest = { userId: string };

// A real signed_request is a few hundred characters (a 43-character signature
// and a small JSON payload). Anything much longer is not from Meta.
export const MAX_SIGNED_REQUEST_LENGTH = 4096;
// A SHA-256 signature is 43 base64url characters (44 with padding).
const MAX_SIGNATURE_LENGTH = 64;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Linear on purpose. The obvious `replace(/=+$/, "")` backtracks quadratically on
// a long run of "=" followed by any other character (about 5 seconds of a blocked
// server for 100,000 characters), and this runs on input anyone can send.
function trimTrailingEquals(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 61) end--;
  return value.slice(0, end);
}

// `user_id` can arrive as a JSON number, and an Instagram id (17 digits) is larger
// than 2^53, so JSON.parse has already rounded it. The payload is signed, so the
// digits as sent are safe to read straight from its text.
function exactUserId(payloadJson: string, parsed: string | number): string {
  if (typeof parsed === "string") return parsed;
  return (
    /"user_id"\s*:\s*(-?\d+)\s*[,}]/.exec(payloadJson)?.[1] ?? String(parsed)
  );
}

// `secrets` are tried in turn: Instagram Login requests are signed with the
// Instagram app secret, Facebook Login ones with the Meta app secret.
export function parseSignedRequest(
  signedRequest: string,
  secrets: string[],
): SignedRequest | null {
  if (signedRequest.length > MAX_SIGNED_REQUEST_LENGTH) return null;
  const parts = signedRequest.split(".");
  if (parts.length !== 2) return null;
  const signature = trimTrailingEquals(parts[0]!);
  const payloadText = parts[1]!;
  if (!signature || signature.length > MAX_SIGNATURE_LENGTH || !payloadText) {
    return null;
  }

  const signedBy = secrets
    .filter(Boolean)
    .some((secret) =>
      safeEqual(
        createHmac("sha256", secret).update(payloadText).digest("base64url"),
        signature,
      ),
    );
  if (!signedBy) return null;

  let payloadJson: string;
  let payload: unknown;
  try {
    payloadJson = Buffer.from(payloadText, "base64url").toString("utf8");
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  // A correctly signed `null`, number or array must be refused, not crash.
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const { algorithm, user_id: rawUserId } = payload as {
    algorithm?: unknown;
    user_id?: unknown;
  };
  if (
    typeof algorithm !== "string" ||
    algorithm.toUpperCase() !== "HMAC-SHA256"
  ) {
    return null;
  }
  if (typeof rawUserId !== "string" && typeof rawUserId !== "number") {
    return null;
  }
  const userId = exactUserId(payloadJson, rawUserId);
  return userId ? { userId } : null;
}

// The confirmation code Meta shows a person after a deletion request, and that
// the status page reads back. Stateless on purpose (no table to migrate): it
// carries when the request was handled and how many connections were erased,
// signed with the app's own secret so it can't be made up. 35 lowercase
// alphanumerics: 9 (time, base36) + 2 (count, base36) + 24 (signature).
const CODE_PATTERN = /^[0-9a-z]{35}$/;

function codeSignature(body: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`data-deletion:${body}`)
    .digest("hex")
    .slice(0, 24);
}

export function createDeletionCode(
  removed: number,
  secret: string,
  now: number = Date.now(),
): string {
  const body =
    now.toString(36).padStart(9, "0") +
    Math.min(Math.max(removed, 0), 1295).toString(36).padStart(2, "0");
  return body + codeSignature(body, secret);
}

export function readDeletionCode(
  code: string,
  secret: string,
): { requestedAt: Date; removed: number } | null {
  if (!CODE_PATTERN.test(code)) return null;
  const body = code.slice(0, 11);
  if (!safeEqual(code.slice(11), codeSignature(body, secret))) return null;
  const requestedAt = new Date(parseInt(body.slice(0, 9), 36));
  if (Number.isNaN(requestedAt.getTime())) return null;
  return { requestedAt, removed: parseInt(body.slice(9), 36) };
}

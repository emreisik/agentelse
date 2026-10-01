import { createHmac, timingSafeEqual } from "node:crypto";

// Meta calls an app's "Deauthorize callback URL" and "Data deletion request
// URL" with a form POST whose `signed_request` is `<signature>.<payload>`, both
// base64url: the signature is HMAC-SHA256 of the payload text with the app
// secret, the payload a JSON object with the app-scoped `user_id`. The request
// carries no session, so this signature is the only proof it came from Meta.

export type SignedRequest = { userId: string };

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// `secrets` are tried in turn: Instagram Login requests are signed with the
// Instagram app secret, Facebook Login ones with the Meta app secret.
export function parseSignedRequest(
  signedRequest: string,
  secrets: string[],
): SignedRequest | null {
  const parts = signedRequest.split(".");
  if (parts.length !== 2) return null;
  const signature = parts[0]!.replace(/=+$/, "");
  const payloadText = parts[1]!;
  if (!signature || !payloadText) return null;

  const signedBy = secrets
    .filter(Boolean)
    .some((secret) =>
      safeEqual(
        createHmac("sha256", secret).update(payloadText).digest("base64url"),
        signature,
      ),
    );
  if (!signedBy) return null;

  let payload: { algorithm?: unknown; user_id?: unknown };
  try {
    payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof payload.algorithm !== "string" ||
    payload.algorithm.toUpperCase() !== "HMAC-SHA256"
  ) {
    return null;
  }
  if (typeof payload.user_id !== "string" && typeof payload.user_id !== "number") {
    return null;
  }
  const userId = String(payload.user_id);
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

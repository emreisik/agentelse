import "server-only";

import { createHash, randomBytes } from "node:crypto";

// RFC 7636 PKCE (Proof Key for Code Exchange) — required by TikTok's and
// X's OAuth 2.0 authorization-code flows (Google/Meta don't require it,
// which is why the single signed-state pattern in oauth-state.ts has been
// sufficient until now). code_verifier is never stored anywhere — it's
// embedded in the signed OAuth state payload (see oauth-state.ts) and read
// back from that same state at the callback.
export function generateCodeVerifier(): string {
  // 32 bytes -> 43-char base64url, at the lower bound of the RFC's 43-128
  // character range and compatible with all providers.
  return randomBytes(32).toString("base64url");
}

export function deriveCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

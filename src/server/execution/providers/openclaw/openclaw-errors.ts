import type { ErrorCode } from "@/server/security/errors";

// The real `openclaw agent --json` envelope has no structured "waiting for
// human input" status (see openclaw-types.ts) — success is just
// {ok:true, status:"ok", final: "..."}. Whether the agent got stuck on an
// OTP/2FA/CAPTCHA screen only shows up as natural-language text in `final`
// (this is what the browser-control skill is expected to say when it hits
// one of these). This heuristic is the best available signal without a
// structured TaskFlow-based integration — false negatives (missed human
// step) and false positives (a reply that merely mentions "code") are both
// possible. Treat this as a stopgap, not a guarantee.
const HUMAN_INPUT_PATTERNS: { pattern: RegExp; code: ErrorCode }[] = [
  {
    pattern: /\b(otp|one[- ]?time (code|password)|doğrulama kodu|sms kodu)\b/i,
    code: "OTP_REQUIRED",
  },
  {
    pattern: /\b(2fa|two[- ]?factor|mfa|authenticator)\b/i,
    code: "MFA_REQUIRED",
  },
  { pattern: /\bcaptcha\b/i, code: "CAPTCHA_REQUIRED" },
  {
    pattern: /\b(log ?in required|please (log|sign) in|oturum aç)\b/i,
    code: "LOGIN_REQUIRED",
  },
];

export function detectHumanInputRequest(
  finalText: string,
): ErrorCode | undefined {
  for (const { pattern, code } of HUMAN_INPUT_PATTERNS) {
    if (pattern.test(finalText)) return code;
  }
  return undefined;
}

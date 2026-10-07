// Etiketli link kodu (GA-F6): utm_content=agx_<kod>. Alfabe, Meta nesne
// etiketiyle (src/lib/ads/operation-tag.ts) aynıdır. Saf.

export const TRACKED_LINK_CODE_LENGTH = 6;

const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const CODE_PATTERN = /^[a-z0-9]{6}$/;

// `random` test için enjekte edilebilir (varsayılan Math.random).
export function newTrackedLinkCode(random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < TRACKED_LINK_CODE_LENGTH; i++) {
    const at = Math.floor(random() * CODE_ALPHABET.length);
    code += CODE_ALPHABET[Math.min(at, CODE_ALPHABET.length - 1)];
  }
  return code;
}

export function isTrackedLinkCode(value: unknown): value is string {
  return typeof value === "string" && CODE_PATTERN.test(value);
}

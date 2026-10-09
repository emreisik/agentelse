// Stripe gizli anahtarının modu (anahtar önekinden). Saf: `server-only` içermez, böylece
// komut satırı betikleri (prisma/stripe-smoke.ts) de kullanabilir.

export type StripeMode = "test" | "live";

const KEY_PATTERN = /^(?:sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/;

export function stripeModeOfKey(secretKey: string): StripeMode | null {
  const match = KEY_PATTERN.exec(secretKey.trim());
  if (!match) return null;
  return match[1] === "live" ? "live" : "test";
}

// Agentelse nesne etiketi (docs/meta-ads-plan.md §3.1 Idempotency, K16):
// Meta istemci tarafı idempotency anahtarı sunmadığı için oluşturulan her
// kampanya / ad set / reklamın adının sonuna `[agx:xxxxxx]` eklenir. Yanıt
// kaybolursa nesne bu etiketle aranır. Nesne yine de adıyla değil
// externalId ve launchId ile tanınır; etiket yalnız belirsiz pencerede
// kullanılır (Ads Manager'daki "Duplicate" etiketi de kopyalar).

const TAG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newOperationTag(random: () => number = Math.random): string {
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += TAG_ALPHABET[Math.floor(random() * TAG_ALPHABET.length)];
  }
  return `agx:${suffix}`;
}

// Meta ad sınırı 400 karakter; etiket her zaman sığar.
const NAME_MAX = 400;

export function taggedName(name: string, tag: string): string {
  const suffix = ` [${tag}]`;
  const base = name.trim().slice(0, NAME_MAX - suffix.length);
  return `${base}${suffix}`;
}

export function tagOfName(name: string | null | undefined): string | null {
  const match = /\[(agx:[a-z0-9]{6})\]\s*$/.exec(name ?? "");
  return match?.[1] ?? null;
}

// Etiket olmadan, kullanıcıya gösterilecek ad.
export function nameWithoutTag(name: string): string {
  return name.replace(/\s*\[agx:[a-z0-9]{6}\]\s*$/, "");
}

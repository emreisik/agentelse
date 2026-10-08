import { z } from "zod";

import { foldForMatch } from "@/lib/text-fold";

// Fikirden reklama soy bağı (docs/meta-ads-autonomy.md). Her reklam, hangi
// post(lar)dan ve hangi fikirden çıktığını ve metninin hangi niteliklere
// sahip olduğunu (kanca tipi, teklif, uzunluk, biçim...) lansman spec'inde
// taşır. Sonuçlar bu etiketlere dağıtılınca sistem "bu reklam kazandı"dan
// "bu tür kanca kazandı"ya geçer ve öğrenme fikir motoruna geri akar.
// Saf: sunucu yalnız kimlikleri çözer, etiketler buradan çıkar.

export const HOOK_STYLES = [
  "question",
  "number",
  "urgency",
  "proof",
  "how-to",
  "benefit",
  "statement",
] as const;
export type HookStyle = (typeof HOOK_STYLES)[number];

export const OFFER_KINDS = ["discount", "free", "price", "none"] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

export const LENGTH_BUCKETS = ["short", "medium", "long"] as const;
export type LengthBucket = (typeof LENGTH_BUCKETS)[number];

// Etiketler düz metindir: yeni nitelik eklemek göç gerektirmez.
export const LINEAGE_TAG_KEYS = [
  "format",
  "hook",
  "offer",
  "length",
  "cta",
  "pillar",
  "ideaSource",
] as const;
export type LineageTagKey = (typeof LINEAGE_TAG_KEYS)[number];

export const AdLineageSchema = z.object({
  // Reklamın çıktığı postlar (carousel'de hepsi) ve bunların fikirleri.
  creativeIds: z.array(z.string().min(1).max(64)).max(10),
  ideaIds: z.array(z.string().min(1).max(64)).max(10),
  // Fikrin açısı: reklamın neye bahis yaptığı (hipotez).
  angle: z.string().max(200).optional(),
  tags: z.record(z.string().max(40), z.string().max(60)),
});
export type AdLineage = z.infer<typeof AdLineageSchema>;

// Sunucunun bir postun kökeni için çözdüğü bilgi.
export type CreativeOrigin = {
  postId?: string;
  ideaId?: string;
  angle?: string;
  pillar?: string;
  ideaSource?: string;
};

// Sezgisel sınıflandırma: kural tabanlıdır (maliyetsiz, her çalışmada aynı
// sonuç); TR ve EN kalıpları. "Kesin" değil, "tutarlı" olması yeter: aynı
// kanca tipi hep aynı etiketi alır, öğrenme bu tutarlılıktan beslenir.
const URGENCY =
  /\b(simdi|bugun|son\s+(gun|saat|firsat|\d+)|sinirli|tukenmeden|kacirma|hemen|only\s+\d+|last\s+(day|chance)|limited|hurry|today only|ends?\s+(soon|today)|now)\b/;
const PROOF =
  /\b(musteri|yorum|puan|yildiz|referans|guvenen|tercih eden|\d+\s*\+?\s*(musteri|kisi|kullanici)|customers?|reviews?|rated|trusted by|stars?|testimonial)\b/;
const HOWTO =
  /\b(nasil|adim adim|rehber|ipucu|ipuclari|how to|guide|tips?|step by step|learn)\b/;
const BENEFIT =
  /\b(tasarruf|kazan|daha\s+\w+|kolay|hizli|garanti|ucretsiz|save|get|more|easier|faster|better|boost|grow|results?)\b/;

export function classifyHook(text: string): HookStyle {
  const first = foldForMatch(text.trim().split(/\n|(?<=[.!?])\s/u)[0] ?? "");
  if (!first) return "statement";
  if (
    /\?\s*$/.test(first) ||
    /^(neden|nasil|ne zaman|kim|hangi|why|what|who|which|do you|are you|is your)\b/.test(
      first,
    )
  ) {
    return /^(nasil|how)\b/.test(first) && HOWTO.test(first)
      ? "how-to"
      : "question";
  }
  if (HOWTO.test(first)) return "how-to";
  if (URGENCY.test(first)) return "urgency";
  if (PROOF.test(first)) return "proof";
  if (/\d/.test(first)) return "number";
  if (BENEFIT.test(first)) return "benefit";
  return "statement";
}

export function detectOffer(text: string): OfferKind {
  const folded = foldForMatch(text);
  if (
    /%\s*\d+|\d+\s*%|\b(indirim|kampanya|firsat|discount|off\b|sale\b|promo)/.test(
      folded,
    )
  ) {
    return "discount";
  }
  if (/\b(ucretsiz|bedava|hediye|free|complimentary|gift)\b/.test(folded)) {
    return "free";
  }
  if (/(\d[\d.,]*\s*(tl|₺|try|usd|eur|€|\$|£))|([€$£₺]\s*\d)/i.test(text)) {
    return "price";
  }
  return "none";
}

export function lengthBucket(text: string): LengthBucket {
  const words = text.trim().split(/\s+/u).filter(Boolean).length;
  if (words <= 12) return "short";
  if (words <= 35) return "medium";
  return "long";
}

export type AdShape = "image" | "video" | "carousel";

// Bir reklamın etiketleri. `text`: reklamın söylediği (ana metin + başlık).
export function lineageTagsFor(input: {
  text: string;
  shape: AdShape;
  callToAction: string;
  origins: readonly CreativeOrigin[];
  ideaSource?: string;
}): Record<string, string> {
  const pillar = input.origins.find((o) => o.pillar)?.pillar;
  const ideaSource =
    input.ideaSource ?? input.origins.find((o) => o.ideaSource)?.ideaSource;
  return {
    format: input.shape,
    hook: classifyHook(input.text),
    offer: detectOffer(input.text),
    length: lengthBucket(input.text),
    cta: input.callToAction.toLowerCase(),
    ...(pillar
      ? { pillar: foldForMatch(pillar).replace(/\s+/g, "-").slice(0, 40) }
      : {}),
    ...(ideaSource ? { ideaSource } : {}),
  };
}

export function buildLineage(input: {
  creativeIds: readonly string[];
  text: string;
  shape: AdShape;
  callToAction: string;
  origins: Readonly<Record<string, CreativeOrigin | undefined>>;
}): AdLineage {
  const found = input.creativeIds
    .map((id) => input.origins[id])
    .filter((o): o is CreativeOrigin => Boolean(o));
  const ideaIds = [
    ...new Set(
      found.map((o) => o.ideaId).filter((v): v is string => Boolean(v)),
    ),
  ];
  return {
    creativeIds: [...input.creativeIds],
    ideaIds,
    ...(found.find((o) => o.angle)?.angle
      ? { angle: found.find((o) => o.angle)!.angle!.slice(0, 200) }
      : {}),
    tags: lineageTagsFor({
      text: input.text,
      shape: input.shape,
      callToAction: input.callToAction,
      origins: found,
    }),
  };
}

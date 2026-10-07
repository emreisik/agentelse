import type { AdsLaunchSpec } from "./launch-spec";

// Bir lansmandaki yüklenecek görsel yuvaları (docs/meta-ads-plan.md F3, F8+).
// Tek görselli reklamda reklam başına bir yuva (anahtar: reklam sırası);
// carousel'de kart başına bir yuva: ilk kart reklamın kendi anahtarını
// (`progress.images[index]`, eski yollar ve önizleme için), sonrakiler
// "index:kart" anahtarını kullanır. Saf.

type Ad = AdsLaunchSpec["ads"][number];

export type ImageSlot = {
  key: string;
  assetId: string;
  adIndex: number;
  // Carousel kart sırası; tek görselde null.
  card: number | null;
};

export function slotKey(adIndex: number, card: number | null): string {
  return card === null || card === 0 ? String(adIndex) : `${adIndex}:${card}`;
}

export function imageSlots(ads: readonly Ad[]): ImageSlot[] {
  const slots: ImageSlot[] = [];
  for (const [adIndex, ad] of ads.entries()) {
    if (ad.creative.cards) {
      for (const [card, spec] of ad.creative.cards.entries()) {
        slots.push({
          key: slotKey(adIndex, card),
          assetId: spec.imageAssetId,
          adIndex,
          card,
        });
      }
    } else {
      slots.push({
        key: slotKey(adIndex, null),
        assetId: ad.creative.imageAssetId,
        adIndex,
        card: null,
      });
    }
  }
  return slots;
}

export type CreativeCard = {
  imageHash: string;
  link: string;
  headline?: string;
  description?: string;
};

// Reklamın carousel kartları, yüklenmiş görsel özetleriyle. Carousel değilse
// undefined; bir kartın görseli henüz yüklenmediyse null.
export function creativeCards(
  ad: Ad,
  adIndex: number,
  images: Readonly<Record<string, string>> | undefined,
): CreativeCard[] | undefined | null {
  if (!ad.creative.cards) return undefined;
  const cards: CreativeCard[] = [];
  for (const [index, card] of ad.creative.cards.entries()) {
    const imageHash = images?.[slotKey(adIndex, index)];
    if (!imageHash) return null;
    cards.push({
      imageHash,
      link: card.link,
      ...(card.headline ? { headline: card.headline } : {}),
      ...(card.description ? { description: card.description } : {}),
    });
  }
  return cards;
}

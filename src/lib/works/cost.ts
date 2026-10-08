import {
  channelOfFormatKey,
  resolveFormat,
  type ChannelKey,
} from "@/lib/content-channels";

// Medium quality is what plan production and variants render with. The
// numbers live here because reasoning-pricing.ts is server-only; cost.test.ts
// keeps them within 0.002 USD of estimateImageCostUsd for the real sizes.
export const IMAGE_PIECE_COST_USD = { post: 0.0791, story: 0.1055 } as const;

type CostPiece = {
  formatKey?: string;
  channel?: ChannelKey;
  // Made from one of the brand's own photos: no image model draws it.
  photo?: boolean;
};

export function isImagePiece(piece: CostPiece): boolean {
  if (!piece.formatKey) return piece.channel === "instagram";
  const channel = channelOfFormatKey(piece.formatKey);
  if (!channel) return false;
  return resolveFormat(channel, piece.formatKey)?.deliverable === "instagram_post";
}

export function pieceCostUsd(piece: CostPiece): number {
  if (piece.photo || !isImagePiece(piece)) return 0;
  return piece.formatKey === "instagram.story"
    ? IMAGE_PIECE_COST_USD.story
    : IMAGE_PIECE_COST_USD.post;
}

export function formatUsd(amount: number): string {
  return `$${(Math.round(amount * 100) / 100).toFixed(2)}`;
}

// "about $0.24", or null when nothing in the list makes a picture.
export function produceCostNote(pieces: readonly CostPiece[]): string | null {
  const total = pieces.reduce((sum, piece) => sum + pieceCostUsd(piece), 0);
  return total > 0 ? `about ${formatUsd(total)}` : null;
}

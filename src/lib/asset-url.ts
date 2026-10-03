// URLs for a stored asset. The original file is what a download or "open
// full size" gets; everything that only shows the picture asks the route for a
// resized WebP (`?w=`), which is a fraction of the bytes. The widths are a
// closed set so the server can cache each one (src/app/api/assets/[assetId]).

export const ASSET_WIDTHS = {
  // Grid tiles, strips, calendar chips (≤ ~160 CSS px, sharp on 2x screens).
  thumb: 320,
  // A card's picture in the chat or a panel (≤ ~380 CSS px).
  card: 768,
  // The big picture in a dialog or lightbox.
  large: 1280,
} as const;

export type AssetSize = keyof typeof ASSET_WIDTHS;

export const ALLOWED_ASSET_WIDTHS: readonly number[] = Object.values(ASSET_WIDTHS);

export function assetUrl(assetId: string, size?: AssetSize): string {
  const base = `/api/assets/${assetId}`;
  return size ? `${base}?w=${ASSET_WIDTHS[size]}` : base;
}

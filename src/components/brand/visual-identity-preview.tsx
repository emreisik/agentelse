"use client";

import type { ColorSwatchValue } from "@/components/brand/color-swatch-input";
import type {
  LogoPositionValue,
  AccentBarPositionValue,
} from "@/server/media/creative-template";

// A mock creative canvas rendered entirely in CSS — no AI call, no server
// round trip. Every measurement here is a PERCENTAGE of the canvas
// (logoSizePercent, logoMarginPercent, accentBarHeightPercent), the same
// unit applyBrandTemplate's sharp compositing uses server-side — so this
// preview is genuinely representative of the actual output, not just an
// approximation. Updates live as the edit Sheet's controlled fields change,
// before the user ever saves.
const LOGO_POSITION_STYLE: Record<LogoPositionValue, React.CSSProperties> = {
  TOP_LEFT: { top: 0, left: 0 },
  TOP_RIGHT: { top: 0, right: 0 },
  BOTTOM_LEFT: { bottom: 0, left: 0 },
  BOTTOM_RIGHT: { bottom: 0, right: 0 },
  CENTER_BOTTOM: { bottom: 0, left: "50%", transform: "translateX(-50%)" },
};

export function VisualIdentityPreview({
  logoUrl,
  primaryColors,
  secondaryColors,
  logoPosition,
  logoSizePercent,
  logoMarginPercent,
  accentBarEnabled,
  accentBarColorHex,
  accentBarHeightPercent,
  accentBarPosition,
}: {
  logoUrl: string | null;
  primaryColors: ColorSwatchValue[];
  secondaryColors: ColorSwatchValue[];
  logoPosition: LogoPositionValue;
  logoSizePercent: number;
  logoMarginPercent: number;
  accentBarEnabled: boolean;
  accentBarColorHex: string | null;
  accentBarHeightPercent: number;
  accentBarPosition: AccentBarPositionValue;
}) {
  const primary = primaryColors[0]?.hex ?? "#1F2937";
  const secondary = secondaryColors[0]?.hex ?? primary;
  const accentHex =
    accentBarColorHex || primaryColors[0]?.hex || secondaryColors[0]?.hex;

  const badgePosition = LOGO_POSITION_STYLE[logoPosition];
  const barOnTop = accentBarEnabled && accentBarPosition === "TOP";
  const barOnBottom = accentBarEnabled && accentBarPosition === "BOTTOM";
  const sharesTopEdge =
    barOnTop && (logoPosition === "TOP_LEFT" || logoPosition === "TOP_RIGHT");
  const sharesBottomEdge =
    barOnBottom &&
    (logoPosition === "BOTTOM_LEFT" ||
      logoPosition === "BOTTOM_RIGHT" ||
      logoPosition === "CENTER_BOTTOM");

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-foreground">Live preview</p>
      <div
        className="relative aspect-[4/5] w-full overflow-hidden rounded-xl ring-1 ring-foreground/10"
        style={{
          background: `linear-gradient(135deg, ${primary}, ${secondary})`,
        }}
      >
        {/* Neutral placeholder subject — keeps attention on the overlay
            geometry, not fake generated art. */}
        <div className="absolute inset-[12%] rounded-lg bg-white/10" />

        {accentBarEnabled && accentHex ? (
          <div
            className="absolute inset-x-0"
            style={{
              [accentBarPosition === "TOP" ? "top" : "bottom"]: 0,
              height: `${accentBarHeightPercent}%`,
              backgroundColor: accentHex,
              opacity: 0.85,
            }}
          />
        ) : null}

        <div
          className="absolute flex items-center justify-center rounded-lg bg-white/88 p-[8%] shadow-sm"
          style={{
            ...badgePosition,
            width: `${logoSizePercent + 6}%`,
            aspectRatio: "1 / 1",
            margin: `${logoMarginPercent}%`,
            marginTop:
              badgePosition.top === 0
                ? `${logoMarginPercent + (sharesTopEdge ? accentBarHeightPercent : 0)}%`
                : undefined,
            marginBottom:
              badgePosition.bottom === 0
                ? `${logoMarginPercent + (sharesBottomEdge ? accentBarHeightPercent : 0)}%`
                : undefined,
          }}
        >
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a tiny
            // preview swatch inside a live-updating client canvas; next/image
            // adds no value here and this is not user-facing content.
            <img
              src={logoUrl}
              alt=""
              className="h-full w-full object-contain"
            />
          ) : (
            <span className="text-[9px] font-medium text-muted-foreground">
              LOGO
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

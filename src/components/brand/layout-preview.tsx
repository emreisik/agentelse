import {
  isDarkColor,
  LIGHT_INK,
  DARK_INK,
  readableOn,
} from "@/lib/color-contrast";
import {
  resolveLayoutColor,
  type AspectClass,
  type HeadlineZone,
  type LayoutPalette,
  type LayoutTemplate,
} from "@/lib/layout-templates";
import { cn } from "@/lib/utils";

// A mock post rendered entirely in CSS: the brand's colours as the "photo",
// a soft shape where the subject would sit, placeholder bars where the
// headline goes, and the REAL logo / bar / band at the layout's exact
// percentages (the same units applyBrandTemplate composites with), so what
// the gallery shows is what a generated post gets. No hooks: usable from
// server and client components alike.

const RATIO: Record<AspectClass, number> = {
  portrait: 4 / 5,
  square: 1,
  landscape: 1.91,
  vertical: 9 / 16,
};

// The aspect a layout is best previewed at: the feed portrait unless it is
// made for something else.
export function previewAspect(layout: LayoutTemplate): AspectClass {
  if (layout.formats.length === 0 || layout.formats.includes("portrait")) {
    return "portrait";
  }
  return layout.formats[0]!;
}

export type PreviewLogos = { light: string | null; dark: string | null };

// Mirrors applyBrandTemplate: with both variants the surface behind the logo
// decides (light logo on dark, dark on light); with one, that one is always
// used, even where it will be hard to read — the preview must not hide it.
export function pickPreviewLogo(
  logos: PreviewLogos,
  surfaceHex: string,
): { url: string; variant: "light" | "dark" } | null {
  if (logos.light && logos.dark) {
    return isDarkColor(surfaceHex)
      ? { url: logos.light, variant: "light" }
      : { url: logos.dark, variant: "dark" };
  }
  if (logos.light) return { url: logos.light, variant: "light" };
  if (logos.dark) return { url: logos.dark, variant: "dark" };
  return null;
}

const FALLBACK_BASE = "#334155";
const FALLBACK_DEEP = "#0f172a";

const HEADLINE_BAR_HEIGHT = { M: 2.6, L: 3.6, XL: 4.8 } as const; // % of height
const HEADLINE_LINE_WIDTHS = [100, 86, 64];
const LINE_GAP = 1.6; // % of canvas height between placeholder lines
// Width of each headline zone as a % of the canvas width (see zoneBox).
const ZONE_WIDTH: Record<HeadlineZone, number> = {
  TOP: 84,
  UPPER_LEFT: 62,
  CENTER: 80,
  LEFT_COLUMN: 50,
  BOTTOM: 84,
};

type Box = React.CSSProperties;

// Where the subject would sit, opposite the headline so the mock shows the
// layout's intended balance.
function subjectBox(layout: LayoutTemplate): Box {
  if (!layout.headline.enabled) {
    return { left: "14%", right: "14%", top: "18%", bottom: "18%" };
  }
  switch (layout.headline.zone) {
    case "TOP":
    case "UPPER_LEFT":
      return { left: "12%", right: "12%", top: "36%", bottom: "12%" };
    case "BOTTOM":
      return { left: "12%", right: "12%", top: "10%", bottom: "36%" };
    case "LEFT_COLUMN":
      return { left: "56%", right: "6%", top: "16%", bottom: "16%" };
    case "CENTER":
    default:
      return { left: "30%", right: "30%", top: "34%", bottom: "34%" };
  }
}

export function LayoutPreview({
  layout,
  colors,
  logos,
  aspect,
  className,
}: {
  layout: LayoutTemplate;
  colors: LayoutPalette;
  logos: PreviewLogos;
  aspect?: AspectClass;
  className?: string;
}) {
  const cls = aspect ?? previewAspect(layout);
  const ratio = RATIO[cls];
  const base = colors.primary ?? FALLBACK_BASE;
  const deep = colors.secondary ?? colors.primary ?? FALLBACK_DEEP;
  const ink = readableOn(base);

  const barColor = layout.bar.enabled
    ? (resolveLayoutColor(layout.bar.color, colors) ?? colors.accent ?? base)
    : null;
  const band = layout.bar.style === "band";
  const barH = layout.bar.heightPercent;
  const barTop = layout.bar.enabled && layout.bar.position === "TOP";
  const barBottom = layout.bar.enabled && layout.bar.position === "BOTTOM";
  const logoOnBand = layout.logo.onBand && layout.bar.enabled && band;

  // 1% of the canvas width is `ratio`% of its height: margins are defined in
  // width units (as applyBrandTemplate does), so vertical offsets convert.
  const marginX = layout.logo.marginPercent;
  const marginY = marginX * ratio;

  const logoPos = layout.logo.position;
  const logoAtTop = logoPos.startsWith("TOP");
  const logoSide: "left" | "right" | "center" = logoPos.endsWith("LEFT")
    ? "left"
    : logoPos.endsWith("RIGHT")
      ? "right"
      : "center";

  // Which logo variant reads here: the band's colour, or the "photo".
  const logo = pickPreviewLogo(logos, logoOnBand && barColor ? barColor : base);

  // --- headline -----------------------------------------------------------
  const lines = Math.min(layout.headline.maxLines, 3);
  const barLineH = HEADLINE_BAR_HEIGHT[layout.headline.scale];
  const zone = layout.headline.zone;
  const centered = layout.headline.align === "center";
  const headlineTopOffset =
    (logoAtTop && !logoOnBand ? 22 : 11) + (barTop ? barH : 0);
  const headlineBottomOffset =
    9 +
    (barBottom ? barH : 0) +
    (!logoAtTop && !logoOnBand && logoSide !== "center" ? 10 : 0);

  const zoneBox: Box =
    zone === "TOP"
      ? { left: "8%", right: "8%", top: `${headlineTopOffset}%` }
      : zone === "UPPER_LEFT"
        ? { left: "8%", width: "62%", top: `${headlineTopOffset}%` }
        : zone === "CENTER"
          ? { left: "10%", right: "10%", top: "50%", transform: "translateY(-50%)" }
          : zone === "LEFT_COLUMN"
            ? { left: "8%", width: "50%", top: "50%", transform: "translateY(-50%)" }
            : { left: "8%", right: "8%", bottom: `${headlineBottomOffset}%` };

  // The placeholder lines are sized in canvas-HEIGHT units, but CSS percent
  // padding/margin resolve against the containing block's WIDTH. Convert:
  // h% of the height = h / (ratio * zoneWidth/100) % of the zone's width.
  const linePad = barLineH / (ratio * (ZONE_WIDTH[zone] / 100));
  const lineGap = LINE_GAP / (ratio * (ZONE_WIDTH[zone] / 100));

  // --- logo -------------------------------------------------------------------
  const logoWidth = `${layout.logo.sizePercent}%`;
  const logoImage = logo ? (
    // eslint-disable-next-line @next/next/no-img-element -- a mock canvas; the logo is /api/assets/<id> or a scan preview data URL
    <img
      src={logo.url}
      alt=""
      data-logo-variant={logo.variant}
      className="block object-contain"
      style={
        logoOnBand
          ? { height: "68%", width: "auto", maxWidth: logoWidth }
          : { width: "100%", height: "auto" }
      }
    />
  ) : (
    <span
      data-logo-placeholder
      className="block rounded-[2px] border border-dashed text-center text-[6px] leading-[1.9] font-semibold tracking-wider"
      style={{
        width: logoOnBand ? logoWidth : "100%",
        borderColor: ink,
        color: ink,
        opacity: 0.8,
      }}
    >
      LOGO
    </span>
  );

  const cornerStyle: Box = {
    width: logoWidth,
    ...(logoSide === "left"
      ? { left: `${marginX}%` }
      : logoSide === "right"
        ? { right: `${marginX}%` }
        : { left: "50%", transform: "translateX(-50%)" }),
    ...(logoAtTop
      ? { top: `${marginY + (barTop ? barH : 0)}%` }
      : { bottom: `${marginY + (barBottom ? barH : 0)}%` }),
  };

  return (
    <div
      data-layout-id={layout.id}
      data-aspect={cls}
      className={cn(
        "relative w-full overflow-hidden rounded-xl ring-1 ring-black/10",
        className,
      )}
      style={{
        aspectRatio: `${ratio}`,
        background: `linear-gradient(155deg, color-mix(in srgb, ${base} 88%, white), ${deep})`,
      }}
    >
      <div
        data-part="subject"
        className="absolute rounded-[26%] bg-white/15 ring-1 ring-white/25"
        style={subjectBox(layout)}
      />

      {layout.bar.enabled && barColor ? (
        <div
          data-part={band ? "band" : "bar"}
          className="absolute inset-x-0"
          style={{
            [layout.bar.position === "TOP" ? "top" : "bottom"]: 0,
            height: `${barH}%`,
            backgroundColor: barColor,
            opacity: band ? 1 : 0.85,
          }}
        />
      ) : null}

      {layout.headline.enabled ? (
        <div
          data-part="headline"
          data-zone={zone}
          className="absolute flex flex-col"
          style={zoneBox}
        >
          {HEADLINE_LINE_WIDTHS.slice(0, lines).map((width, index) => (
            <span
              key={index}
              className="block rounded-full"
              style={{
                height: 0,
                paddingBottom: `${linePad}%`,
                marginTop: index === 0 ? 0 : `${lineGap}%`,
                width: `${index === lines - 1 && lines > 1 ? width : Math.max(width, 92)}%`,
                marginLeft: centered ? "auto" : 0,
                marginRight: centered ? "auto" : 0,
                backgroundColor:
                  ink === LIGHT_INK
                    ? "rgba(255,255,255,0.92)"
                    : "rgba(11,11,11,0.85)",
              }}
            />
          ))}
        </div>
      ) : null}

      {logoOnBand && barColor ? (
        <div
          data-part="logo-on-band"
          className="absolute inset-x-0 flex items-center"
          style={{
            [layout.bar.position === "TOP" ? "top" : "bottom"]: 0,
            height: `${barH}%`,
            padding: `0 ${marginX}%`,
            justifyContent:
              logoSide === "left"
                ? "flex-start"
                : logoSide === "right"
                  ? "flex-end"
                  : "center",
          }}
        >
          {logoImage}
        </div>
      ) : (
        <div data-part="logo" className="absolute" style={cornerStyle}>
          {logoImage}
        </div>
      )}
    </div>
  );
}

// Re-exported for the gallery's contrast warnings.
export { DARK_INK, LIGHT_INK };

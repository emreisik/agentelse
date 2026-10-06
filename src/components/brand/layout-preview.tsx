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

// The headline's size as a share of the canvas's SHORT side, the same table
// the compositor typesets with (creative-text.ts SCALE_SIZE), so real words in
// the preview sit at the size the post gets.
const TEXT_SCALE = { M: 0.064, L: 0.08, XL: 0.1 } as const;

// The words a post carries on its picture (OnImageText in creative-text.ts).
export type PreviewText = {
  headline: string;
  // The words of the headline set in the brand's accent colour.
  highlight?: string;
  // At most one supporting line under it.
  lines?: string[];
};

// The headline with its highlighted words split out (first match, any case).
export function splitHighlight(
  headline: string,
  highlight?: string,
): { before: string; match: string; after: string } | null {
  const needle = highlight?.trim();
  if (!needle) return null;
  const at = headline.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1) return null;
  return {
    before: headline.slice(0, at),
    match: headline.slice(at, at + needle.length),
    after: headline.slice(at + needle.length),
  };
}

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
  ratio: ratioOverride,
  text,
  fontFamily,
  showLogo = true,
  className,
}: {
  layout: LayoutTemplate;
  colors: LayoutPalette;
  logos: PreviewLogos;
  aspect?: AspectClass;
  // Width / height, when the post's real shape differs from the class's
  // (an Instagram post is 3:4, the class's portrait 4:5).
  ratio?: number;
  // Real words in the headline zone instead of placeholder bars. Without a
  // headline zone the picture carries no words, exactly like the post.
  text?: PreviewText;
  // CSS font-family for those words (the brand's font, loaded by the caller).
  fontFamily?: string;
  // false: no logo and no placeholder for one (a post that gets no logo).
  showLogo?: boolean;
  className?: string;
}) {
  const cls = aspect ?? previewAspect(layout);
  const ratio = ratioOverride ?? RATIO[cls];
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
        // The headline's size is set in container units (cqw).
        containerType: "inline-size",
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

      {layout.headline.enabled && text?.headline ? (
        <HeadlineText
          text={text}
          zone={zone}
          zoneBox={zoneBox}
          centered={centered}
          maxLines={layout.headline.maxLines}
          sizeCqw={
            TEXT_SCALE[layout.headline.scale] * 100 * Math.min(1, 1 / ratio)
          }
          ink={ink}
          accent={colors.accent ?? null}
          fontFamily={fontFamily}
        />
      ) : layout.headline.enabled && !text ? (
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

      {!showLogo ? null : logoOnBand && barColor ? (
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

// Real headline words in the layout's headline zone: the brand's font, the
// layout's size and alignment, the highlighted words in the accent colour (as
// the compositor sets them) and at most one supporting line.
function HeadlineText({
  text,
  zone,
  zoneBox,
  centered,
  maxLines,
  sizeCqw,
  ink,
  accent,
  fontFamily,
}: {
  text: PreviewText;
  zone: HeadlineZone;
  zoneBox: Box;
  centered: boolean;
  maxLines: number;
  sizeCqw: number;
  ink: string;
  accent: string | null;
  fontFamily?: string;
}) {
  const split = splitHighlight(text.headline, text.highlight);
  // The accent reads on its own only when it differs from the ink's side.
  const highlightColor =
    accent && isDarkColor(accent) !== (ink === LIGHT_INK) ? accent : ink;
  const line = text.lines?.find((entry) => entry.trim());
  return (
    <div
      data-part="headline"
      data-zone={zone}
      className="absolute flex flex-col"
      style={{
        ...zoneBox,
        color: ink,
        textAlign: centered ? "center" : "left",
        fontFamily,
        textShadow:
          ink === LIGHT_INK ? "0 1px 2px rgba(0,0,0,0.25)" : undefined,
      }}
    >
      <span
        data-part="headline-text"
        style={{
          fontSize: `${sizeCqw.toFixed(2)}cqw`,
          fontWeight: 700,
          lineHeight: 1.06,
          letterSpacing: "-0.01em",
          display: "-webkit-box",
          WebkitLineClamp: maxLines,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          overflowWrap: "anywhere",
        }}
      >
        {split ? (
          <>
            {split.before}
            <span style={{ color: highlightColor }}>{split.match}</span>
            {split.after}
          </>
        ) : (
          text.headline
        )}
      </span>
      {line ? (
        <span
          data-part="headline-line"
          style={{
            marginTop: `${(sizeCqw * 0.3).toFixed(2)}cqw`,
            fontSize: `${(sizeCqw * 0.5).toFixed(2)}cqw`,
            fontWeight: 500,
            lineHeight: 1.2,
            opacity: 0.92,
          }}
        >
          {line}
        </span>
      ) : null}
    </div>
  );
}

// Re-exported for the gallery's contrast warnings.
export { DARK_INK, LIGHT_INK };

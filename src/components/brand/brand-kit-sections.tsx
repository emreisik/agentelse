import Link from "next/link";
import { BadgeCheck, Sparkles } from "lucide-react";

import { BrandScanButton } from "@/components/brand/brand-scan-dialog";
import { CopyableSwatch } from "@/components/brand/copyable-swatch";
import { FontSpecimen } from "@/components/brand/font-specimen";
import { LayoutEditorButton } from "@/components/brand/layout-editor-dialog";
import {
  LayoutPreview,
  previewAspect,
} from "@/components/brand/layout-preview";
import { buildHubHref } from "@/components/hub-core/hub-core-params";
import { BrandVisualIdentityQuickEdit } from "@/components/workspace/brand-visual-identity-quick-edit";
import {
  allPaletteHexes,
  BACKGROUND_TONE_LABEL,
  brandSurfaceColor,
  kitLayoutPalette,
  PHOTOGRAPHY_STYLE_LABEL,
  pickLogoForBackground,
  type BrandKit,
} from "@/lib/brand-kit";
import {
  buildPresetLayouts,
  describeLayout,
  resolveLayout,
} from "@/lib/layout-templates";
import {
  DARK_INK,
  isDarkColor,
  LIGHT_INK,
  readableOn,
} from "@/lib/color-contrast";

// The visual half of the Brand tab. Every colour on these surfaces comes from
// the brand's own kit (with the app's neutral tokens only for chrome), so the
// panel looks like the brand it describes. Server components except for the
// interactive leaves they import (copy-to-clipboard swatches, font specimens,
// the scan dialog).

function brandBrainHref(projectId: string, sub?: string): string {
  return buildHubHref(projectId, { panel: "brand-brain", sub: sub ?? null });
}

export function KitSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className="border-t py-4"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <div className="mb-2.5 flex items-center justify-between">
        <h3
          className="text-[10px] font-semibold tracking-[0.1em]"
          style={{ color: "var(--ws-text-3)" }}
        >
          {title}
        </h3>
        {action ?? null}
      </div>
      {children}
    </section>
  );
}

function Chip({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "good" | "bad";
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]"
      style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
    >
      {tone === "good" ? (
        <span style={{ color: "var(--ws-approved)" }}>✓</span>
      ) : tone === "bad" ? (
        <span style={{ color: "var(--destructive)" }}>✕</span>
      ) : null}
      {children}
    </span>
  );
}

// --- hero ----------------------------------------------------------------------

// Name, verified tick and site address. On the hero it inherits the card's
// ink colour (currentColor) so it reads on any brand colour; standalone it
// uses the app's own text tokens.
export function BrandIdentityLine({
  name,
  website,
  verified,
  fallbackLabel,
  onSurface,
}: {
  name: string;
  website: string | null;
  verified: boolean;
  // Shown instead of the site address when the brand has none.
  fallbackLabel: string;
  onSurface: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <p
          className="truncate text-xl leading-tight font-semibold tracking-[-0.02em]"
          style={onSurface ? undefined : { color: "var(--ws-text)" }}
        >
          {name}
        </p>
        {verified ? (
          <BadgeCheck
            className="size-4 shrink-0"
            style={onSurface ? undefined : { color: "var(--ws-approved)" }}
          />
        ) : null}
      </div>
      {website ? (
        <a
          href={website.startsWith("http") ? website : `https://${website}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs hover:underline"
          style={onSurface ? { opacity: 0.78 } : { color: "var(--ws-text-3)" }}
        >
          {website}
        </a>
      ) : (
        <p
          className="text-xs"
          style={onSurface ? { opacity: 0.78 } : { color: "var(--ws-text-3)" }}
        >
          {fallbackLabel}
        </p>
      )}
    </div>
  );
}

// The brand as one card in its own colour: the primary colour is the surface,
// the ink is chosen for contrast, the logo variant that is legible on it sits
// top-left, the identity (name, site) bottom-left, the actions top-right, and
// the whole palette runs along the bottom edge as a signature strip.
export function BrandHero({
  name,
  website,
  verified,
  fallbackLabel,
  kit,
  actions,
}: {
  name: string;
  website: string | null;
  verified: boolean;
  fallbackLabel: string;
  kit: BrandKit;
  actions: React.ReactNode;
}) {
  const surface = brandSurfaceColor(kit);
  const background = surface ?? "var(--ws-accent)";
  const ink = surface ? readableOn(surface) : "var(--ws-on-accent)";
  const logo = surface ? pickLogoForBackground(kit.logos, surface) : null;
  const strip = allPaletteHexes(kit);

  return (
    <div
      data-kit="hero"
      className="mb-3 flex min-h-40 w-full flex-col justify-between gap-4 overflow-hidden rounded-2xl p-4 ring-1 ring-black/10"
      style={{ background, color: ink }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image can't optimize it
            <img
              src={`/api/assets/${logo.assetId}`}
              alt={`${name} logo`}
              className="max-h-12 max-w-[70%] object-contain object-left"
            />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      </div>
      <div>
        <BrandIdentityLine
          name={name}
          website={website}
          verified={verified}
          fallbackLabel={fallbackLabel}
          onSurface
        />
        {strip.length > 1 ? (
          <div
            data-kit="palette-strip"
            className="mt-3 flex h-2 overflow-hidden rounded-full ring-1 ring-black/10"
          >
            {strip.map((hex) => (
              <span
                key={hex}
                className="flex-1"
                style={{ backgroundColor: hex }}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function EmptyKitCard({
  projectId,
  website,
  kit,
}: {
  projectId: string;
  website: string | null;
  kit: BrandKit;
}) {
  return (
    <div
      data-kit="empty"
      className="mb-3 flex flex-col items-center gap-2.5 rounded-2xl border border-dashed p-5 text-center"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <span
        className="flex size-9 items-center justify-center rounded-full"
        style={{ background: "var(--ws-hover)", color: "var(--ws-text)" }}
      >
        <Sparkles className="size-4" />
      </span>
      <p className="text-sm font-semibold" style={{ color: "var(--ws-text)" }}>
        Build your brand kit
      </p>
      <p className="text-xs leading-relaxed" style={{ color: "var(--ws-text-2)" }}>
        Scan your website and we&apos;ll pull your logo, colors, fonts and
        visual style. You review everything before it is saved.
      </p>
      <BrandScanButton
        projectId={projectId}
        website={website}
        hasLogo={false}
        kit={kit}
        variant="default"
        size="sm"
        label="Scan my website"
        className="gap-1.5"
      />
    </div>
  );
}

// --- logos ---------------------------------------------------------------------

export function LogoTiles({
  kit,
  projectId,
}: {
  kit: BrandKit;
  projectId: string;
}) {
  const primary = brandSurfaceColor(kit);
  // "On dark" uses the brand's own colour when it is dark, else near-black.
  const darkSurface = primary && isDarkColor(primary) ? primary : "#0f172a";

  const tiles = [
    {
      key: "on-light",
      label: "On light",
      assetId: kit.logos.dark,
      surface: "#ffffff",
      missing: "Add a dark-colored logo",
    },
    {
      key: "on-dark",
      label: "On dark",
      assetId: kit.logos.light,
      surface: darkSurface,
      missing: "Add a light-colored logo",
    },
  ];

  return (
    <KitSection title="LOGO">
      <div className="grid grid-cols-2 gap-2">
        {tiles.map((tile) =>
          tile.assetId ? (
            <div key={tile.key} data-kit={`logo-${tile.key}`} className="flex flex-col gap-1">
              <div
                className="flex aspect-[3/2] items-center justify-center rounded-xl p-3 ring-1 ring-black/10"
                style={{ backgroundColor: tile.surface }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id> */}
                <img
                  src={`/api/assets/${tile.assetId}`}
                  alt={`Logo ${tile.label.toLowerCase()}`}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
              <span className="text-[10px]" style={{ color: "var(--ws-text-3)" }}>
                {tile.label}
              </span>
            </div>
          ) : (
            <Link
              key={tile.key}
              data-kit={`logo-${tile.key}-missing`}
              href={brandBrainHref(projectId)}
              scroll={false}
              className="flex flex-col gap-1"
            >
              <div
                className="flex aspect-[3/2] items-center justify-center rounded-xl border border-dashed px-2 text-center text-[11px] transition-colors hover:bg-[var(--ws-hover)]"
                style={{
                  borderColor: "var(--ws-border)",
                  color: "var(--ws-text-3)",
                }}
              >
                {tile.missing}
              </div>
              <span className="text-[10px]" style={{ color: "var(--ws-text-3)" }}>
                {tile.label}
              </span>
            </Link>
          ),
        )}
      </div>
    </KitSection>
  );
}

// --- colours -------------------------------------------------------------------

export function PaletteSection({
  kit,
  projectId,
}: {
  kit: BrandKit;
  projectId: string;
}) {
  const { palette } = kit;
  const rows = kit.paletteHasRoles
    ? [
        { label: "Primary", swatches: palette.primary, size: "lg" as const, columns: 2 },
        { label: "Secondary", swatches: palette.secondary, size: "md" as const, columns: 3 },
        { label: "Accent", swatches: palette.accent, size: "sm" as const, columns: 4 },
      ]
    : [{ label: "Colors", swatches: palette.primary, size: "md" as const, columns: 3 }];
  const visible = rows.filter((row) => row.swatches.length > 0);

  return (
    <KitSection
      title="COLORS"
      action={
        <BrandVisualIdentityQuickEdit
          projectId={projectId}
          colors={palette.primary}
          fonts={kit.fonts}
        />
      }
    >
      {visible.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
          No colors yet. Scan your site, or use the pencil to add them.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((row) => (
            <div key={row.label} data-kit={`palette-${row.label.toLowerCase()}`}>
              <div
                className="mb-1.5 text-[9px] font-semibold tracking-[0.08em] uppercase"
                style={{ color: "var(--ws-text-3)" }}
              >
                {row.label}
              </div>
              <div
                className="grid gap-2"
                style={{
                  gridTemplateColumns: `repeat(${Math.min(row.swatches.length, row.columns)}, minmax(0, 1fr))`,
                }}
              >
                {row.swatches.map((swatch) => (
                  <CopyableSwatch
                    key={swatch.hex}
                    hex={swatch.hex}
                    name={swatch.name}
                    size={row.size}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </KitSection>
  );
}

// --- typography ------------------------------------------------------------------

export function TypographySection({ kit }: { kit: BrandKit }) {
  return (
    <KitSection title="TYPOGRAPHY">
      {kit.fonts.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
          No fonts yet. Scan your site, or use the pencil in Colors to add them.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {kit.fonts.slice(0, 3).map((font, index) => (
            <FontSpecimen key={font} name={font} index={index} />
          ))}
        </div>
      )}
    </KitSection>
  );
}

// --- style ----------------------------------------------------------------------

export function StyleSection({
  kit,
  projectId,
}: {
  kit: BrandKit;
  projectId: string;
}) {
  const { style } = kit;
  const chips = [
    style.photographyStyle
      ? (PHOTOGRAPHY_STYLE_LABEL[style.photographyStyle] ?? style.photographyStyle)
      : null,
    style.backgroundTone && style.backgroundTone !== "NO_PREFERENCE"
      ? (BACKGROUND_TONE_LABEL[style.backgroundTone] ?? style.backgroundTone)
      : null,
  ].filter((label): label is string => Boolean(label));

  const hasAnything =
    chips.length > 0 ||
    style.moodTags.length > 0 ||
    style.refinement ||
    style.composition ||
    style.alwaysInclude.length > 0 ||
    style.alwaysAvoid.length > 0;

  return (
    <KitSection title="STYLE & MOOD">
      {!hasAnything ? (
        <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
          Photography style and mood appear here once your visual identity is
          set.{" "}
          <Link
            href={brandBrainHref(projectId, "visual-identity")}
            scroll={false}
            className="underline"
          >
            Set it up
          </Link>
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {chips.length > 0 || style.moodTags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" data-kit="style-chips">
              {chips.map((label) => (
                <span
                  key={label}
                  className="inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium"
                  style={{ background: "var(--ws-hover)", color: "var(--ws-text)" }}
                >
                  {label}
                </span>
              ))}
              {style.moodTags.map((tag) => (
                <Chip key={tag}>{tag}</Chip>
              ))}
            </div>
          ) : null}
          {style.refinement ? (
            <p className="line-clamp-3 text-xs leading-relaxed" style={{ color: "var(--ws-text-2)" }}>
              {style.refinement}
            </p>
          ) : null}
          {style.composition ? (
            <p className="line-clamp-2 text-xs leading-relaxed" style={{ color: "var(--ws-text-3)" }}>
              {style.composition}
            </p>
          ) : null}
          {style.alwaysInclude.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {style.alwaysInclude.slice(0, 6).map((item) => (
                <Chip key={item} tone="good">
                  {item}
                </Chip>
              ))}
            </div>
          ) : null}
          {style.alwaysAvoid.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {style.alwaysAvoid.slice(0, 6).map((item) => (
                <Chip key={item} tone="bad">
                  {item}
                </Chip>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </KitSection>
  );
}

// --- post layouts ---------------------------------------------------------------

export function LayoutSection({
  kit,
  projectId,
}: {
  kit: BrandKit;
  projectId: string;
}) {
  const saved = Boolean(kit.layouts);
  const layouts = kit.layouts ?? buildPresetLayouts(kit.template);
  const main = resolveLayout(layouts)!;
  const colors = kitLayoutPalette(kit);
  const logos = {
    light: kit.logos.light ? `/api/assets/${kit.logos.light}` : null,
    dark: kit.logos.dark ? `/api/assets/${kit.logos.dark}` : null,
  };

  return (
    <KitSection
      title="POST LAYOUTS"
      action={
        <LayoutEditorButton
          projectId={projectId}
          saved={kit.layouts}
          baseTemplate={kit.template}
          colors={colors}
          logoIds={kit.logos}
          label={saved ? "Edit layouts" : "Set up layouts"}
        />
      }
    >
      <div className="flex gap-3">
        <div className="w-[128px] shrink-0" data-kit="layout-preview">
          <LayoutPreview
            layout={main}
            colors={colors}
            logos={logos}
            aspect={previewAspect(main)}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span
              className="truncate text-sm font-semibold"
              style={{ color: "var(--ws-text)" }}
            >
              {main.name}
            </span>
            <span
              className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
              style={{ background: "var(--ws-hover)", color: "var(--ws-text)" }}
            >
              Default
            </span>
          </div>
          {main.description ? (
            <p
              className="text-[11px] leading-snug"
              style={{ color: "var(--ws-text-2)" }}
            >
              {main.description}
            </p>
          ) : null}
          <p
            className="text-[11px] leading-snug"
            style={{ color: "var(--ws-text-3)" }}
          >
            {describeLayout(main)}
          </p>
        </div>
      </div>

      {layouts.items.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-2" data-kit="layout-thumbs">
          {layouts.items.map((item) => (
            <div
              key={item.id}
              title={item.name}
              data-kit="layout-thumb"
              className={
                item.id === layouts.defaultId
                  ? "w-[50px] rounded-xl ring-2 ring-foreground/70 ring-offset-1"
                  : "w-[50px]"
              }
            >
              <LayoutPreview
                layout={item}
                colors={colors}
                logos={logos}
                aspect={previewAspect(item)}
              />
            </div>
          ))}
        </div>
      ) : null}

      <p
        className="mt-2 text-[11px] leading-snug"
        style={{ color: "var(--ws-text-3)" }}
      >
        {saved
          ? "New posts follow these layouts. The logo and color bar are added after the image is made, so they are identical every time."
          : "Suggested layouts, not saved yet. Posts use your logo and color bar template until you save them."}
      </p>
    </KitSection>
  );
}

// Re-exported so the panel's tests and callers share one definition of the
// two ink colours the hero can use.
export { DARK_INK, LIGHT_INK };

import { Sparkles } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import {
  updateBrandVisualIdentityAction,
  uploadStyleReferenceAction,
  removeStyleReferenceAction,
} from "@/server/actions/brand-visual-identity-actions";
import type { ColorSwatchValue } from "@/components/brand/color-swatch-input";
import { VisualIdentityControls } from "@/components/brand/visual-identity-controls";
import { parseLayoutTemplates } from "@/lib/layout-templates";
import { DEFAULT_TEMPLATE_CONFIG } from "@/server/media/creative-template";

function ColorRow({
  label,
  colors,
}: {
  label: string;
  colors: ColorSwatchValue[];
}) {
  if (colors.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <div className="flex flex-wrap gap-3">
        {colors.map((color, index) => (
          <div
            key={`${color.hex}-${index}`}
            className="flex flex-col items-center gap-1.5"
          >
            <span
              className="size-8 rounded-full shadow-sm ring-1 ring-foreground/15"
              style={{ backgroundColor: color.hex }}
              title={color.name ?? color.hex}
            />
            <span className="font-mono text-[10px] text-muted-foreground">
              {color.name ?? color.hex}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const PHOTOGRAPHY_STYLE_LABEL: Record<string, string> = {
  PHOTOGRAPHIC: "Photographic",
  ILLUSTRATED: "Illustrated",
  THREE_D_RENDER: "3D render",
  FLAT_DESIGN: "Flat design",
  MIXED: "Mixed / whichever fits",
};
const BACKGROUND_TONE_LABEL: Record<string, string> = {
  LIGHT: "Light",
  DARK: "Dark",
  BRAND_COLORED: "Brand-colored",
  NO_PREFERENCE: "No preference",
};
const LOGO_POSITION_LABEL: Record<string, string> = {
  TOP_LEFT: "Top left",
  TOP_RIGHT: "Top right",
  BOTTOM_LEFT: "Bottom left",
  BOTTOM_RIGHT: "Bottom right",
  CENTER_BOTTOM: "Bottom center",
};

// New Brand Brain section — read-only summary + the edit Sheet. Placed
// right after AssetsSection (logo/positioning/tone — "protected core
// identity") and before Constitution: this is a denser, creative-
// generation-specific follow-on, kept as its own section rather than
// further bloating AssetsSection, matching the panel's existing
// convention of many small focused sections.
export async function VisualIdentitySection({
  projectId,
  brandId,
}: {
  projectId: string;
  brandId: string;
}) {
  const [identity, dossier] = await Promise.all([
    prisma.brandVisualIdentity.findUnique({ where: { brandId } }),
    prisma.brandDossier.findUnique({
      where: { brandId },
      select: { logoAssetId: true },
    }),
  ]);

  // Saved post layouts decide the logo and bar placement (planCreativeLayout):
  // the template fields below then only matter as the on/off switch.
  const layoutsActive = Boolean(parseLayoutTemplates(identity?.layoutTemplates));
  const logoUrl = dossier?.logoAssetId
    ? `/api/assets/${dossier.logoAssetId}`
    : null;
  const referenceImageUrl = identity?.referenceImageAssetId
    ? `/api/assets/${identity.referenceImageAssetId}`
    : null;

  const primaryColors = (identity?.primaryColors ?? []) as ColorSwatchValue[];
  const secondaryColors = (identity?.secondaryColors ??
    []) as ColorSwatchValue[];
  const accentColors = (identity?.accentColors ?? []) as ColorSwatchValue[];

  const editable = {
    primaryColors,
    secondaryColors,
    accentColors,
    photographyStyle: identity?.photographyStyle ?? null,
    styleRefinement: identity?.styleRefinement ?? null,
    moodTags: identity?.moodTags ?? [],
    compositionNotes: identity?.compositionNotes ?? null,
    backgroundTone: identity?.backgroundTone ?? null,
    alwaysInclude: identity?.alwaysInclude ?? [],
    alwaysAvoid: identity?.alwaysAvoid ?? [],
    templateEnabled:
      identity?.templateEnabled ?? DEFAULT_TEMPLATE_CONFIG.enabled,
    logoPosition:
      identity?.logoPosition ?? DEFAULT_TEMPLATE_CONFIG.logoPosition,
    logoSizePercent:
      identity?.logoSizePercent ?? DEFAULT_TEMPLATE_CONFIG.logoSizePercent,
    logoMarginPercent:
      identity?.logoMarginPercent ?? DEFAULT_TEMPLATE_CONFIG.logoMarginPercent,
    accentBarEnabled:
      identity?.accentBarEnabled ?? DEFAULT_TEMPLATE_CONFIG.accentBarEnabled,
    accentBarColorHex: identity?.accentBarColorHex ?? null,
    accentBarHeightPercent:
      identity?.accentBarHeightPercent ??
      DEFAULT_TEMPLATE_CONFIG.accentBarHeightPercent,
    accentBarPosition:
      identity?.accentBarPosition ?? DEFAULT_TEMPLATE_CONFIG.accentBarPosition,
  };

  const hasAnyStyleData =
    primaryColors.length > 0 ||
    secondaryColors.length > 0 ||
    accentColors.length > 0 ||
    Boolean(editable.photographyStyle) ||
    Boolean(editable.styleRefinement) ||
    editable.moodTags.length > 0 ||
    Boolean(editable.compositionNotes) ||
    Boolean(editable.backgroundTone) ||
    editable.alwaysInclude.length > 0 ||
    editable.alwaysAvoid.length > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
            <Sparkles className="size-4" />
          </span>
          <CardTitle className="text-base">Visual Identity</CardTitle>
        </div>
        <VisualIdentityControls
          projectId={projectId}
          logoUrl={logoUrl}
          identity={editable}
          action={updateBrandVisualIdentityAction}
          layoutsActive={layoutsActive}
        />
      </CardHeader>
      <CardContent className="space-y-5">
        {hasAnyStyleData ? (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <ColorRow label="Primary" colors={primaryColors} />
              <ColorRow label="Secondary" colors={secondaryColors} />
              <ColorRow label="Accent" colors={accentColors} />
            </div>
            {editable.photographyStyle || editable.backgroundTone ? (
              <div className="flex flex-wrap gap-4 text-sm">
                {editable.photographyStyle ? (
                  <p>
                    <span className="text-muted-foreground">Style: </span>
                    {PHOTOGRAPHY_STYLE_LABEL[editable.photographyStyle] ??
                      editable.photographyStyle}
                  </p>
                ) : null}
                {editable.backgroundTone ? (
                  <p>
                    <span className="text-muted-foreground">Background: </span>
                    {BACKGROUND_TONE_LABEL[editable.backgroundTone] ??
                      editable.backgroundTone}
                  </p>
                ) : null}
              </div>
            ) : null}
            {editable.styleRefinement ? (
              <p className="text-sm text-muted-foreground">
                {editable.styleRefinement}
              </p>
            ) : null}
            {editable.moodTags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {editable.moodTags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-muted px-2.5 py-1 text-xs text-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
            {editable.compositionNotes ? (
              <p className="text-sm text-muted-foreground">
                <span className="text-foreground">Composition: </span>
                {editable.compositionNotes}
              </p>
            ) : null}
            {editable.alwaysInclude.length > 0 ||
            editable.alwaysAvoid.length > 0 ? (
              <div className="grid gap-3 text-xs sm:grid-cols-2">
                {editable.alwaysInclude.length > 0 ? (
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">
                      Always include
                    </p>
                    <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                      {editable.alwaysInclude.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {editable.alwaysAvoid.length > 0 ? (
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">Always avoid</p>
                    <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                      {editable.alwaysAvoid.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No visual identity configured yet — every AI creative uses the
            neutral default. Set a palette and style to get consistent, on-brand
            output.
          </p>
        )}

        <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2 text-sm">
          <span>
            Template:{" "}
            {!editable.templateEnabled
              ? "off (pure AI output)"
              : layoutsActive
                ? "on — logo and bar placement come from your Post layouts"
                : `logo ${LOGO_POSITION_LABEL[editable.logoPosition]}, ${editable.accentBarEnabled ? "accent bar on" : "no accent bar"}`}
          </span>
        </div>

        <div className="space-y-2 border-t border-border/60 pt-4">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Style reference (optional)
          </p>
          {referenceImageUrl ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- a
                  small thumbnail in a server component summary card; no
                  next/image config needed for this. */}
              <img
                src={referenceImageUrl}
                alt="Style reference"
                className="h-16 w-16 rounded-lg object-cover ring-1 ring-foreground/10"
              />
              <form action={removeStyleReferenceAction}>
                <input type="hidden" name="projectId" value={projectId} />
                <SubmitButton size="sm" variant="outline">
                  Remove
                </SubmitButton>
              </form>
            </div>
          ) : (
            <form
              action={uploadStyleReferenceAction}
              className="flex items-center gap-2"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <Input
                type="file"
                name="referenceImage"
                accept="image/png,image/jpeg,image/webp"
                required
                className="max-w-xs"
              />
              <SubmitButton size="sm" variant="outline">
                Upload
              </SubmitButton>
            </form>
          )}
          <p className="text-[11px] text-muted-foreground">
            One image the AI matches for style/palette/mood only — it&apos;s
            told never to copy a logo or subject matter from it.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

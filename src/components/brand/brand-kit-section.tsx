import { LayoutTemplate, ScanSearch, Type as FontIcon } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { parseDesignProfile } from "@/lib/design-profile";
import { resolveArchetype } from "@/server/brand/design-archetype";
import { listPreviewPhotos, previewLookKey } from "@/server/brand/design-preview";
import { isCustomTemplate } from "@/server/media/creative-layout";
import { loadBrandKit } from "@/server/brand/load-brand-kit";
import { BrandScanButton } from "@/components/brand/brand-scan-dialog";
import { CustomLayoutsNotice } from "@/components/brand/custom-layouts-notice";
import { DesignGallery } from "@/components/brand/design-gallery";
import { FontPicker } from "@/components/brand/font-picker";
import { FontSpecimen } from "@/components/brand/font-specimen";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// The rest of the brand's look that the Visual Identity card does not edit: the
// website scan, the font and the post designs. Everything that changes how the
// brand looks is edited here in Brand Brain, nowhere else.
export async function BrandKitSection({
  projectId,
  brandId,
  afterScan,
}: {
  projectId: string;
  brandId: string;
  // Rendered between the scan strip and the font/design cards (the Visual
  // Identity card: colors and style).
  afterScan?: React.ReactNode;
}) {
  const [kit, project, archetype, identityRow, photos, lookKey] = await Promise.all([
    loadBrandKit(brandId),
    prisma.project.findUnique({
      where: { id: projectId },
      select: { domain: true },
    }),
    resolveArchetype(brandId),
    prisma.brandVisualIdentity.findUnique({
      where: { brandId },
      select: { designProfile: true },
    }),
    listPreviewPhotos(projectId),
    previewLookKey(projectId, brandId),
  ]);
  // The design picked for each format, if any; every other format follows what
  // the brand's own words point to (the automatic pick).
  const profile = parseDesignProfile(identityRow?.designProfile);

  // Posts follow the designs unless the brand saved layouts of its own or
  // customised its logo template by hand.
  const customLayouts = Boolean(kit.layouts);
  const customTemplate = !customLayouts && isCustomTemplate(kit.template);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent">
            <ScanSearch className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium">Fill it from your website</p>
            <p className="text-xs text-muted-foreground">
              Scan the site to pick up the logo, colors and fonts. You review
              everything before it is saved.
            </p>
          </div>
        </div>
        <BrandScanButton
          projectId={projectId}
          website={project?.domain ?? null}
          hasLogo={Boolean(kit.logos.light || kit.logos.dark)}
          size="sm"
        />
      </div>

      {afterScan}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
              <FontIcon className="size-4" />
            </span>
            <CardTitle className="text-base">Font</CardTitle>
          </div>
          <FontPicker projectId={projectId} fonts={kit.fonts} />
        </CardHeader>
        <CardContent className="space-y-2">
          {kit.fonts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No font yet, so the words on posts are set in Inter. Choose a
              font to give them your brand&apos;s voice.
            </p>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                {kit.fonts.slice(0, 3).map((font, index) => (
                  <FontSpecimen key={font} name={font} index={index} />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                The words on your posts are set in {kit.fonts[0]}.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
              <LayoutTemplate className="size-4" />
            </span>
            <CardTitle className="text-base">Post designs</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {customLayouts ? (
            <CustomLayoutsNotice projectId={projectId} />
          ) : (
            <>
              {customTemplate ? (
                <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  A logo template was set by hand in Visual Identity, so posts
                  use it. Picking a design here applies once that template is
                  reset to the defaults.
                </p>
              ) : null}
              {kit.template.enabled ? null : (
                <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  The post template is switched off in Visual Identity, so no
                  logo is added to posts until you turn it on.
                </p>
              )}
              <DesignGallery
                projectId={projectId}
                profile={profile}
                suggested={archetype}
                photos={photos}
                lookKey={lookKey}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

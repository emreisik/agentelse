import Image from "next/image";
import { ImagePlus, Sparkles } from "lucide-react";

import { prisma } from "@/lib/prisma";
import {
  generateLogoAction,
  uploadLogoAction,
} from "@/server/actions/project-actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

// Logo upload/generation was moved here from the removed 3-step setup
// wizard — the natural home for brand assets is the Brand Brain's Assets
// tab.
export async function BrandLogoCard({
  projectId,
  brandId,
}: {
  projectId: string;
  brandId: string;
}) {
  const dossier = await prisma.brandDossier.findUnique({
    where: { brandId },
    select: { logoAssetId: true, darkLogoAssetId: true },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <ImagePlus className="size-4" />
        </span>
        <CardTitle className="text-base">Logo</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Upload both a light and a dark variant — generated creatives
          automatically pick whichever one reads clearly against the background,
          no artificial backdrop behind the logo.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <LogoVariantSlot
            projectId={projectId}
            variant="light"
            label="Light logo"
            hint="For dark backgrounds"
            previewBg="bg-neutral-900"
            assetId={dossier?.logoAssetId ?? null}
          />
          <LogoVariantSlot
            projectId={projectId}
            variant="dark"
            label="Dark logo"
            hint="For light backgrounds"
            previewBg="bg-neutral-100"
            assetId={dossier?.darkLogoAssetId ?? null}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function LogoVariantSlot({
  projectId,
  variant,
  label,
  hint,
  previewBg,
  assetId,
}: {
  projectId: string;
  variant: "light" | "dark";
  label: string;
  hint: string;
  previewBg: string;
  assetId: string | null;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        {label} <span className="text-muted-foreground">— {hint}</span>
      </p>
      {assetId ? (
        <div
          className={`flex items-center justify-center rounded-xl p-4 ${previewBg}`}
        >
          <Image
            src={`/api/assets/${assetId}`}
            alt={`${label} preview`}
            width={96}
            height={96}
            unoptimized
            className="h-24 w-auto object-contain"
          />
        </div>
      ) : (
        <p className="rounded-xl bg-accent/40 p-4 text-sm text-muted-foreground">
          No {label.toLowerCase()} yet.
        </p>
      )}

      <form action={uploadLogoAction} className="space-y-2">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="variant" value={variant} />
        <Input type="file" name="logo" accept="image/png,image/jpeg" required />
        <p className="text-xs text-muted-foreground">
          PNG or JPEG, up to 5 MB.
        </p>
        <SubmitButton size="sm" variant="outline">
          Upload
        </SubmitButton>
      </form>

      <form action={generateLogoAction}>
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="variant" value={variant} />
        <SubmitButton size="sm">
          <Sparkles className="size-4" />
          Generate with AI
        </SubmitButton>
      </form>
    </div>
  );
}

import Image from "next/image";
import { ImagePlus, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  generateLogoAction,
  uploadLogoAction,
} from "@/server/actions/project-actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";

// Logo upload/generation lives on the Brand Brain's Assets tab. Two slots, one
// per variant: generated creatives pick whichever reads clearly against the
// background, so a brand ships a light logo (for dark backgrounds) and a dark
// logo (for light backgrounds). The asset ids come from the caller, which has
// already loaded the dossier.
export function BrandLogoSlots({
  projectId,
  lightAssetId,
  darkAssetId,
}: {
  projectId: string;
  lightAssetId: string | null;
  darkAssetId: string | null;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <LogoVariantSlot
        projectId={projectId}
        variant="light"
        label="Light logo"
        hint="Shown on dark backgrounds"
        previewClassName="bg-neutral-900"
        assetId={lightAssetId}
      />
      <LogoVariantSlot
        projectId={projectId}
        variant="dark"
        label="Dark logo"
        hint="Shown on light backgrounds"
        previewClassName="bg-neutral-100"
        assetId={darkAssetId}
      />
    </div>
  );
}

function LogoVariantSlot({
  projectId,
  variant,
  label,
  hint,
  previewClassName,
  assetId,
}: {
  projectId: string;
  variant: "light" | "dark";
  label: string;
  hint: string;
  previewClassName: string;
  assetId: string | null;
}) {
  const onDark = variant === "light";
  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <div
        className={cn(
          "flex h-40 items-center justify-center p-6",
          previewClassName,
        )}
      >
        {assetId ? (
          <Image
            src={`/api/assets/${assetId}`}
            alt={`${label} preview`}
            width={160}
            height={96}
            unoptimized
            className="max-h-24 w-auto object-contain"
          />
        ) : (
          <div
            className={cn(
              "flex flex-col items-center gap-1.5 text-xs",
              onDark ? "text-neutral-400" : "text-neutral-500",
            )}
          >
            <ImagePlus className="size-5" />
            Not added yet
          </div>
        )}
      </div>

      <div className="space-y-3 p-4">
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>

        <form action={uploadLogoAction} className="space-y-2">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="variant" value={variant} />
          <Input
            type="file"
            name="logo"
            accept="image/png,image/jpeg"
            required
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">PNG or JPEG, ≤ 5 MB</p>
            <SubmitButton size="sm" variant="outline">
              {assetId ? "Replace" : "Upload"}
            </SubmitButton>
          </div>
        </form>

        <form
          action={generateLogoAction}
          className="border-t border-border pt-3"
        >
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="variant" value={variant} />
          <SubmitButton size="sm" variant="ghost" className="w-full">
            <Sparkles className="size-3.5" />
            Generate with AI
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}

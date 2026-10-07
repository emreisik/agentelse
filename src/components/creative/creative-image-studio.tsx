"use client";

import { useActionState, useState } from "react";
import { ImagePlus, Ratio, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";

import {
  getAvailableContentFormats,
  getCreativePlatformFormat,
} from "@/lib/creative-platform-format";
import { FAL_IMAGE_MODELS } from "@/lib/fal-image-models";
import { generateRealCreativeImageAction } from "@/server/actions/creative-actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CreativeContentFormat, SocialPlatform } from "@prisma/client";

type State = { ok: true } | { ok: false; message: string } | null;

// A saved post layout the picker can offer (see the Brand tab's layouts).
export type StudioLayoutOption = {
  id: string;
  name: string;
  description?: string;
};

// For regenerating a creative's image or editing the existing image with
// an instruction. Both modes share the same form; the difference is the
// submitted `mode` field: "edit" feeds the existing image to the model as
// input and modifies it while preserving composition, "new" generates
// from scratch.
export function CreativeImageStudio({
  creativeId,
  hasImage,
  platform,
  // Server-computed (getEnv() isn't available client-side) — see
  // isFalImageConfigured() in fal-image-client.ts. When false, the model
  // picker below doesn't render at all: zero UI change for a project
  // without FAL_API_KEY set, same as before this option existed.
  isFalConfigured = false,
  // The brand's saved post layouts and the one the current version was made
  // with. Empty = the brand has none: no picker, posts compose as before.
  layouts = [],
  currentLayoutId = null,
}: {
  creativeId: string;
  hasImage: boolean;
  platform?: SocialPlatform | null;
  isFalConfigured?: boolean;
  layouts?: StudioLayoutOption[];
  currentLayoutId?: string | null;
}) {
  // A platform can carry more than one content-type slot (Instagram Post
  // vs. Story vs. Reel are different pixel targets) — when there's more
  // than one, the user picks which one to generate for; otherwise the
  // platform's single/default format is used silently, same as before.
  const availableFormats = platform ? getAvailableContentFormats(platform) : [];
  const [contentFormat, setContentFormat] = useState<
    CreativeContentFormat | undefined
  >(availableFormats[0]?.contentFormat);
  const format = getCreativePlatformFormat(platform, contentFormat);
  const [instruction, setInstruction] = useState("");
  // "" means the default (OpenAI) — only set to
  // a fal-image-models.ts id when the user deliberately picks one. In edit
  // mode, only models with supportsImageInput can actually do anything with
  // the existing image, so the list is filtered accordingly.
  const [falModelId, setFalModelId] = useState("");
  const falModelChoices = FAL_IMAGE_MODELS.filter(
    (model) => !hasImage || model.supportsImageInput,
  );
  const falModelOptionLabel = (model: (typeof FAL_IMAGE_MODELS)[number]) =>
    `${model.category} · ${model.label} — ${model.approxPrice}`;
  // "" = keep the version's own layout (or the brand's default for the
  // format). Only a from-scratch render can switch layout: an edit builds on
  // pixels that already carry the current one.
  const [layoutId, setLayoutId] = useState("");
  const currentLayout = layouts.find((layout) => layout.id === currentLayoutId);
  const keepLayoutLabel = currentLayout
    ? `Keep current (${currentLayout.name})`
    : "Brand default";
  const pickedLayout = layouts.find((layout) => layout.id === layoutId);

  const [, formAction] = useActionState(
    async (_prev: State, form: FormData) => {
      const result = await generateRealCreativeImageAction(form);
      if (result.ok) {
        toast.success(
          form.get("mode") === "edit"
            ? "Image edited per instruction"
            : "New image generated",
        );
        setInstruction("");
      } else {
        toast.error(result.message);
      }
      return result as State;
    },
    null,
  );

  return (
    <form
      action={formAction}
      className="space-y-2 rounded-xl p-3 ring-1 ring-foreground/10"
    >
      <input type="hidden" name="creativeId" value={creativeId} />
      {contentFormat ? (
        <input type="hidden" name="contentFormat" value={contentFormat} />
      ) : null}
      {falModelId ? (
        <input type="hidden" name="falModelId" value={falModelId} />
      ) : null}
      {layoutId ? (
        <input type="hidden" name="layoutId" value={layoutId} />
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
            <Wand2 className="size-4" />
          </span>
          <p className="text-sm font-medium">Image studio</p>
        </div>
        {availableFormats.length > 1 ? (
          <Select
            items={availableFormats.map((f) => ({
              value: f.contentFormat,
              label: f.contentFormatLabel,
            }))}
            value={contentFormat}
            onValueChange={(next) =>
              next && setContentFormat(next as CreativeContentFormat)
            }
          >
            <SelectTrigger size="sm" className="h-7 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableFormats.map((f) => (
                <SelectItem key={f.contentFormat} value={f.contentFormat}>
                  {f.contentFormatLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Ratio className="size-3" />
            {format.label} · {format.aspectRatio}
          </span>
        )}
      </div>

      {availableFormats.length > 1 ? (
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Ratio className="size-3" />
          {format.label} · {format.pixelSize.width} × {format.pixelSize.height}
          px ({format.aspectRatio})
        </p>
      ) : null}

      {isFalConfigured ? (
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            Model
          </span>
          <Select
            items={[
              { value: "", label: "OpenAI (default)" },
              ...falModelChoices.map((model) => ({
                value: model.id,
                label: falModelOptionLabel(model),
              })),
            ]}
            value={falModelId}
            onValueChange={(next) => setFalModelId(next ?? "")}
          >
            <SelectTrigger size="sm" className="h-7 w-full text-[11px]">
              <SelectValue />
            </SelectTrigger>
            {/* Popup width is decoupled from the (narrow, w-fit) trigger —
                item text is whitespace-nowrap, so without this override
                long labels (e.g. "FLUX Pro Fill (inpaint) —
                $0.05/mp") get clipped to the trigger's width instead of
                fully readable. alignItemWithTrigger=false: that mode
                positions the popup assuming it's roughly the trigger's own
                width (opens with the selected item directly over the
                trigger, like a native <select>) — with a popup this much
                wider than the trigger it mispositions, so this falls back
                to a plain "opens below, left-aligned" dropdown instead. */}
            <SelectContent
              className="w-[24rem] max-w-[90vw]"
              align="start"
              alignItemWithTrigger={false}
            >
              <SelectItem value="">OpenAI (default)</SelectItem>
              {falModelChoices.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {falModelOptionLabel(model)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ) : null}

      {layouts.length > 0 ? (
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            Post layout
          </span>
          <Select
            items={[
              { value: "", label: keepLayoutLabel },
              ...layouts.map((layout) => ({
                value: layout.id,
                label: layout.name,
              })),
            ]}
            value={layoutId}
            onValueChange={(next) => setLayoutId(next ?? "")}
          >
            <SelectTrigger size="sm" className="h-7 w-full text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              <SelectItem value="">{keepLayoutLabel}</SelectItem>
              {layouts.map((layout) => (
                <SelectItem key={layout.id} value={layout.id}>
                  {layout.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="block text-[11px] text-muted-foreground">
            {pickedLayout?.description ||
              "Where the logo, the color bar and any headline go."}{" "}
            Used when generating from scratch; editing keeps the image&apos;s own
            layout.
          </span>
        </label>
      ) : null}

      <Textarea
        name="instruction"
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        rows={3}
        placeholder={
          hasImage
            ? "What should change? Example: simplify the background, enlarge the product, bring out the brand blue, remove the text at the top"
            : "What kind of image do you want? Example: premium product shot on a dark background, soft side lighting, no text"
        }
      />

      <div className="flex flex-wrap gap-2">
        {hasImage ? (
          <SubmitButton
            size="sm"
            name="mode"
            value="edit"
            disabled={!instruction.trim()}
          >
            <Wand2 className="size-4" />
            Edit this image
          </SubmitButton>
        ) : null}

        <SubmitButton size="sm" variant="outline" name="mode" value="new">
          {hasImage ? (
            <Sparkles className="size-4" />
          ) : (
            <ImagePlus className="size-4" />
          )}
          {hasImage ? "Regenerate from scratch" : "Generate image"}
        </SubmitButton>
      </div>

      <p className="text-xs text-muted-foreground">
        {hasImage
          ? "Editing builds on the existing image and preserves the composition. Generating from scratch uses the description and the creative's copy; if the description is empty, it generates from the copy alone."
          : "If the description is left empty, the image is generated from the creative's title and copy."}
      </p>
      <p className="text-xs text-muted-foreground">
        Every generation creates a new version — older images are not lost.
      </p>
    </form>
  );
}

"use client";

import { useActionState, useState } from "react";
import { ImagePlus, Ratio, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";

import {
  getAvailableContentFormats,
  getCreativePlatformFormat,
} from "@/lib/creative-platform-format";
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

// For regenerating a creative's image or editing the existing image with
// an instruction. Both modes share the same form; the difference is the
// submitted `mode` field: "edit" feeds the existing image to the model as
// input and modifies it while preserving composition, "new" generates
// from scratch.
export function CreativeImageStudio({
  creativeId,
  hasImage,
  platform,
}: {
  creativeId: string;
  hasImage: boolean;
  platform?: SocialPlatform | null;
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

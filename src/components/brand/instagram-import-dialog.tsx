"use client";

import { useState, useTransition } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  analyzeInstagramPostsAction,
  type InstagramImportResult,
} from "@/server/actions/brand-visual-identity-actions";
import type { InstagramStyleSuggestion } from "@/server/reasoning/prompts/instagram-style";

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

function SwatchDots({
  colors,
}: {
  colors: InstagramStyleSuggestion["primaryColors"];
}) {
  if (colors.length === 0) return null;
  return (
    <div className="flex gap-1.5">
      {colors.map((color, i) => (
        <span
          key={`${color.hex}-${i}`}
          className="size-5 rounded-full ring-1 ring-foreground/15"
          style={{ backgroundColor: color.hex }}
          title={color.name ?? color.hex}
        />
      ))}
    </div>
  );
}

// Paste-links entry point for populating Visual Identity from an account's
// existing posts instead of filling every field by hand. Two steps in one
// Dialog: paste links -> analyze, then review the suggestion -> apply. It
// never saves anything itself — "Apply" hands the suggestion up to
// VisualIdentityControls, which opens the real edit Dialog
// (VisualIdentityEditSheet) pre-filled with it, so the existing Save flow
// (and the user's chance to review/edit first) stays the only save path.
export function InstagramImportDialog({
  projectId,
  onApply,
}: {
  projectId: string;
  onApply: (suggestion: InstagramStyleSuggestion) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<InstagramImportResult | null>(null);

  function reset() {
    setResult(null);
  }

  function onAnalyze(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const outcome = await analyzeInstagramPostsAction(formData);
      setResult(outcome);
      if (!outcome.ok) toast.error(outcome.message);
    });
  }

  function onApplyClick() {
    if (result?.ok) {
      onApply(result.suggestion);
      setOpen(false);
      reset();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setOpen(true)}
        aria-label="Import visual identity from Instagram"
      >
        <Download className="size-3.5" />
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import from Instagram</DialogTitle>
          <DialogDescription>
            Your 5 most recent posts are read from your connected Instagram
            account and their images analyzed for a recurring color palette,
            photography style, and mood, which you can then review and apply to
            your settings.
          </DialogDescription>
        </DialogHeader>

        {!result?.ok ? (
          <form onSubmit={onAnalyze} className="space-y-3">
            <input type="hidden" name="projectId" value={projectId} />
            <p className="text-[11px] text-muted-foreground">
              Only your own connected account can be read. For inspiration from
              another account, upload a screenshot as your style reference
              instead.
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Analyze my recent posts
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="space-y-3 rounded-lg border border-border/60 p-3">
              <SwatchDots
                colors={[
                  ...result.suggestion.primaryColors,
                  ...result.suggestion.secondaryColors,
                  ...result.suggestion.accentColors,
                ]}
              />
              <p className="text-sm">
                <span className="text-muted-foreground">Style: </span>
                {PHOTOGRAPHY_STYLE_LABEL[result.suggestion.photographyStyle]}
                {" · "}
                <span className="text-muted-foreground">Background: </span>
                {BACKGROUND_TONE_LABEL[result.suggestion.backgroundTone]}
              </p>
              {result.suggestion.moodTags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {result.suggestion.moodTags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-muted px-2.5 py-1 text-xs text-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
              <p className="text-sm text-muted-foreground">
                {result.suggestion.styleRefinement}
              </p>
              <p className="text-xs text-muted-foreground">
                {result.suggestion.compositionNotes}
              </p>
            </div>
            {result.failedUrls.length > 0 ? (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                Couldn&apos;t download {result.failedUrls.length} post
                {result.failedUrls.length > 1 ? "s" : ""}:{" "}
                {result.failedUrls.join(", ")}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={reset}>
                Back
              </Button>
              <Button type="button" onClick={onApplyClick}>
                Apply to settings
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

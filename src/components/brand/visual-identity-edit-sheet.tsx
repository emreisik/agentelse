"use client";

import { useState, useTransition } from "react";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

import type { ActionResult } from "@/components/shared/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  ColorSwatchInput,
  type ColorSwatchValue,
} from "@/components/brand/color-swatch-input";
import { VisualIdentityPreview } from "@/components/brand/visual-identity-preview";
import type {
  LogoPositionValue,
  AccentBarPositionValue,
} from "@/server/media/creative-template";

export type VisualIdentityEditable = {
  primaryColors: ColorSwatchValue[];
  secondaryColors: ColorSwatchValue[];
  accentColors: ColorSwatchValue[];
  photographyStyle: string | null;
  styleRefinement: string | null;
  moodTags: string[];
  compositionNotes: string | null;
  backgroundTone: string | null;
  alwaysInclude: string[];
  alwaysAvoid: string[];
  templateEnabled: boolean;
  logoPosition: LogoPositionValue;
  logoSizePercent: number;
  logoMarginPercent: number;
  accentBarEnabled: boolean;
  accentBarColorHex: string | null;
  accentBarHeightPercent: number;
  accentBarPosition: AccentBarPositionValue;
};

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
const LOGO_POSITION_LABEL: Record<LogoPositionValue, string> = {
  TOP_LEFT: "Top left",
  TOP_RIGHT: "Top right",
  BOTTOM_LEFT: "Bottom left",
  BOTTOM_RIGHT: "Bottom right",
  CENTER_BOTTOM: "Bottom center",
};

// A centered Dialog, not a side Sheet: this form is wide (a two-column
// field grid plus a live preview column) and Sheet's side="right" panel
// hardcodes `sm:max-w-sm` via a data-[side=right] compound class, which
// beats a plain className override on specificity — the content gets
// crushed into ~220px no matter what width you pass in. Dialog's default
// max-width has no such compound variant, so overriding it in the same
// modifier group (sm:) actually works (see entity-dialog.tsx's SIZE_CLASSES
// comment for the same tailwind-merge gotcha).
//
// Same interaction pattern as brand-dossier-edit-sheet.tsx otherwise
// (controlled open state, useTransition, toast + close-on-success), but
// with lifted state for the fields the live preview needs to react to
// (colors + template geometry) — everything else stays a plain
// uncontrolled form field, matching the rest of the codebase's dialog
// forms.
export function VisualIdentityEditSheet({
  projectId,
  logoUrl,
  identity,
  action,
  suggestion = null,
  open: openProp,
  onOpenChange: onOpenChangeProp,
  hideTrigger = false,
  layoutsActive = false,
}: {
  projectId: string;
  logoUrl: string | null;
  identity: VisualIdentityEditable;
  action: (formData: FormData) => Promise<ActionResult>;
  // AI-suggested values (e.g. from Instagram import) layered over the
  // saved identity — pre-fills the form for review, never auto-saves. Only
  // read on mount (useState initial value + uncontrolled defaultValue), so
  // the CALLER must remount this component (a `key` on <VisualIdentityEditSheet>
  // itself, e.g. keyed by a suggestion version counter) whenever a new
  // suggestion should take effect — changing this prop in place on an
  // already-mounted instance has no effect.
  suggestion?: Partial<VisualIdentityEditable> | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  // The Instagram import flow renders its own trigger and drives `open`
  // itself; the plain "edit" entry point keeps the built-in pencil button.
  hideTrigger?: boolean;
  // The brand has saved post layouts: they decide where the logo and the color
  // bar go, so the placement fields below only apply once they are removed.
  layoutsActive?: boolean;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChangeProp ?? setOpenState;
  const [pending, startTransition] = useTransition();

  const effectiveIdentity = suggestion
    ? { ...identity, ...suggestion }
    : identity;

  const [primaryColors, setPrimaryColors] = useState(
    effectiveIdentity.primaryColors,
  );
  const [secondaryColors, setSecondaryColors] = useState(
    effectiveIdentity.secondaryColors,
  );
  const [logoPosition, setLogoPosition] = useState<LogoPositionValue>(
    effectiveIdentity.logoPosition,
  );
  const [logoSizePercent, setLogoSizePercent] = useState(
    effectiveIdentity.logoSizePercent,
  );
  const [logoMarginPercent, setLogoMarginPercent] = useState(
    effectiveIdentity.logoMarginPercent,
  );
  const [accentBarEnabled, setAccentBarEnabled] = useState(
    effectiveIdentity.accentBarEnabled,
  );
  const [accentBarColorHex, setAccentBarColorHex] = useState(
    effectiveIdentity.accentBarColorHex ?? "",
  );
  const [accentBarHeightPercent, setAccentBarHeightPercent] = useState(
    effectiveIdentity.accentBarHeightPercent,
  );
  const [accentBarPosition, setAccentBarPosition] =
    useState<AccentBarPositionValue>(effectiveIdentity.accentBarPosition);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await action(formData);
      if (result.ok) {
        toast.success("Visual identity updated");
        setOpen(false);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {hideTrigger ? null : (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setOpen(true)}
          aria-label="Edit visual identity"
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
      <DialogContent className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b border-foreground/10 p-4">
          <DialogTitle>Edit Visual Identity</DialogTitle>
          <DialogDescription>
            Sets the palette, style, and logo/accent-bar template every
            AI-generated creative uses — the template part is composited after
            generation, so it&apos;s the same on every image, not just a
            suggestion to the model.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-y-auto p-4 sm:grid-cols-[1fr_220px]">
            <div className="space-y-5">
              <div className="space-y-1 border-b border-border/60 pb-1">
                <p className="text-xs font-semibold tracking-wide text-foreground uppercase">
                  Palette
                </p>
              </div>
              <ColorSwatchInput
                name="primaryColors"
                label="Primary colors"
                defaultValue={effectiveIdentity.primaryColors}
                onChange={setPrimaryColors}
              />
              <ColorSwatchInput
                name="secondaryColors"
                label="Secondary colors"
                defaultValue={effectiveIdentity.secondaryColors}
                onChange={setSecondaryColors}
              />
              <ColorSwatchInput
                name="accentColors"
                label="Accent colors"
                defaultValue={effectiveIdentity.accentColors}
              />

              <div className="space-y-1 border-b border-border/60 pt-2 pb-1">
                <p className="text-xs font-semibold tracking-wide text-foreground uppercase">
                  Style
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="vi-photography-style">
                    Photography style
                  </Label>
                  <Select
                    items={Object.entries(PHOTOGRAPHY_STYLE_LABEL).map(
                      ([value, label]) => ({ value, label }),
                    )}
                    name="photographyStyle"
                    defaultValue={
                      effectiveIdentity.photographyStyle ?? undefined
                    }
                  >
                    <SelectTrigger id="vi-photography-style" className="w-full">
                      <SelectValue placeholder="Not set" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(PHOTOGRAPHY_STYLE_LABEL).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vi-background-tone">Background tone</Label>
                  <Select
                    items={Object.entries(BACKGROUND_TONE_LABEL).map(
                      ([value, label]) => ({ value, label }),
                    )}
                    name="backgroundTone"
                    defaultValue={effectiveIdentity.backgroundTone ?? undefined}
                  >
                    <SelectTrigger id="vi-background-tone" className="w-full">
                      <SelectValue placeholder="Not set" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(BACKGROUND_TONE_LABEL).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="vi-style-refinement">
                  Style refinement (free text)
                </Label>
                <Textarea
                  id="vi-style-refinement"
                  name="styleRefinement"
                  defaultValue={effectiveIdentity.styleRefinement ?? ""}
                  rows={2}
                  placeholder="e.g. soft natural light, shallow depth of field"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="vi-mood-tags">Mood / aesthetic tags</Label>
                <Input
                  id="vi-mood-tags"
                  name="moodTags"
                  defaultValue={effectiveIdentity.moodTags.join(", ")}
                  placeholder="premium, playful, editorial"
                />
                <p className="text-[11px] text-muted-foreground">
                  Comma-separated.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="vi-composition-notes">Composition notes</Label>
                <Textarea
                  id="vi-composition-notes"
                  name="compositionNotes"
                  defaultValue={effectiveIdentity.compositionNotes ?? ""}
                  rows={2}
                  placeholder="e.g. rule-of-thirds, generous negative space"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="vi-always-include">Always include</Label>
                  <Textarea
                    id="vi-always-include"
                    name="alwaysInclude"
                    defaultValue={effectiveIdentity.alwaysInclude.join("\n")}
                    rows={3}
                    placeholder="One instruction per line"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vi-always-avoid">Always avoid</Label>
                  <Textarea
                    id="vi-always-avoid"
                    name="alwaysAvoid"
                    defaultValue={effectiveIdentity.alwaysAvoid.join("\n")}
                    rows={3}
                    placeholder="One instruction per line"
                  />
                </div>
              </div>

              <div className="space-y-1 border-b border-border/60 pt-2 pb-1">
                <p className="text-xs font-semibold tracking-wide text-foreground uppercase">
                  Template — logo &amp; accent bar
                </p>
                <p className="text-[11px] text-muted-foreground">
                  The logo and the brand bar are added to every generated image
                  after AI generation, so they are always exact. Their size and
                  position are chosen for you.
                </p>
                {layoutsActive ? (
                  <p className="rounded-md bg-muted/60 px-2 py-1.5 text-[11px] text-foreground">
                    You have saved post layouts. Each layout decides where the
                    logo and the color bar go, so the position, size and bar
                    settings below are used only when no layouts are saved. The
                    switch below still turns the whole template off.
                  </p>
                ) : null}
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Apply template
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Off = pure AI output, no guaranteed logo placement.
                  </p>
                </div>
                <Switch
                  name="templateEnabled"
                  defaultChecked={effectiveIdentity.templateEnabled}
                />
              </div>
              <details className="rounded-lg border border-border/60 p-3">
                <summary className="cursor-pointer text-xs font-medium text-foreground select-none">
                  Advanced: place the logo and bar by hand
                </summary>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Not needed: the logo&apos;s size and position, the bar and the
                  headline area are designed automatically for each post
                  format. Changing these replaces that automatic design.
                </p>
                <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="vi-logo-position">Logo position</Label>
                  <Select
                    items={Object.entries(LOGO_POSITION_LABEL).map(
                      ([value, label]) => ({ value, label }),
                    )}
                    name="logoPosition"
                    value={logoPosition}
                    onValueChange={(next) =>
                      next && setLogoPosition(next as LogoPositionValue)
                    }
                  >
                    <SelectTrigger id="vi-logo-position" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(LOGO_POSITION_LABEL).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vi-logo-size">Logo size (% of width)</Label>
                  <Input
                    id="vi-logo-size"
                    name="logoSizePercent"
                    type="number"
                    min={8}
                    max={30}
                    value={logoSizePercent}
                    onChange={(event) =>
                      setLogoSizePercent(Number(event.target.value) || 16)
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vi-logo-margin">Logo margin (%)</Label>
                  <Input
                    id="vi-logo-margin"
                    name="logoMarginPercent"
                    type="number"
                    min={1}
                    max={15}
                    value={logoMarginPercent}
                    onChange={(event) =>
                      setLogoMarginPercent(Number(event.target.value) || 4)
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vi-accent-bar-color">
                    Accent bar color override
                  </Label>
                  <Input
                    id="vi-accent-bar-color"
                    name="accentBarColorHex"
                    value={accentBarColorHex}
                    onChange={(event) =>
                      setAccentBarColorHex(event.target.value)
                    }
                    placeholder="Defaults to first accent color"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                <p className="text-sm font-medium text-foreground">
                  Accent color bar
                </p>
                <Switch
                  name="accentBarEnabled"
                  checked={accentBarEnabled}
                  onCheckedChange={setAccentBarEnabled}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="vi-accent-bar-position">
                    Accent bar position
                  </Label>
                  <Select
                    items={[
                      { value: "TOP", label: "Top" },
                      { value: "BOTTOM", label: "Bottom" },
                    ]}
                    name="accentBarPosition"
                    value={accentBarPosition}
                    onValueChange={(next) =>
                      next &&
                      setAccentBarPosition(next as AccentBarPositionValue)
                    }
                  >
                    <SelectTrigger
                      id="vi-accent-bar-position"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="TOP">Top</SelectItem>
                      <SelectItem value="BOTTOM">Bottom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vi-accent-bar-height">
                    Accent bar height (%)
                  </Label>
                  <Input
                    id="vi-accent-bar-height"
                    name="accentBarHeightPercent"
                    type="number"
                    min={2}
                    max={15}
                    value={accentBarHeightPercent}
                    onChange={(event) =>
                      setAccentBarHeightPercent(Number(event.target.value) || 5)
                    }
                  />
                </div>
              </div>
                </div>
              </details>
            </div>

            <div className="sm:sticky sm:top-0">
              <VisualIdentityPreview
                logoUrl={logoUrl}
                primaryColors={primaryColors}
                secondaryColors={secondaryColors}
                logoPosition={logoPosition}
                logoSizePercent={logoSizePercent}
                logoMarginPercent={logoMarginPercent}
                accentBarEnabled={accentBarEnabled}
                accentBarColorHex={accentBarColorHex || null}
                accentBarHeightPercent={accentBarHeightPercent}
                accentBarPosition={accentBarPosition}
              />
            </div>
          </div>
          <DialogFooter className="mx-0 mb-0 shrink-0 flex-row justify-end gap-2 rounded-none">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

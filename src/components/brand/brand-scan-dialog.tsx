"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, Loader2, ScanSearch } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ColorSwatchInput,
  type ColorSwatchValue,
} from "@/components/brand/color-swatch-input";
import { LayoutGallery } from "@/components/brand/layout-gallery";
import type { PreviewLogos } from "@/components/brand/layout-preview";
import {
  DEFAULT_KIT_TEMPLATE,
  type BrandKit,
} from "@/lib/brand-kit";
import {
  buildPresetLayouts,
  normalizeLayoutNames,
  type LayoutPalette,
  type LayoutTemplates,
} from "@/lib/layout-templates";
import {
  applyBrandScanAction,
  scanBrandWebsiteAction,
  type ApplyBrandScanPayload,
} from "@/server/actions/brand-scan-actions";
import type { SiteScanResult } from "@/server/brand/site-scan/scan";

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

// Shown in order while the (single, blocking) scan runs. They are honest
// stage names, but the timing is an estimate: the server does not report
// progress mid-call.
const SCAN_STAGES = [
  "Fetching the site",
  "Reading styles and fonts",
  "Finding the logo",
  "Analyzing the brand identity",
];

// Button + modal. The flow component is mounted only while the dialog is
// open, so closing it discards any half-reviewed scan.
export function BrandScanButton({
  projectId,
  website,
  hasLogo,
  kit,
  variant = "outline",
  size = "xs",
  label = "Scan site",
  className,
}: {
  projectId: string;
  website: string | null;
  hasLogo: boolean;
  // What the brand already has, for the layouts step (the current base
  // template, saved layouts and both logo variants). Optional: without it the
  // step starts from the defaults.
  kit?: Pick<BrandKit, "template" | "layouts" | "logos">;
  variant?: "outline" | "default";
  size?: "xs" | "sm";
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={() => setOpen(true)}
        className={className ?? "gap-1"}
      >
        <ScanSearch className={size === "xs" ? "size-3" : "size-3.5"} />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-2xl">
          {open ? (
            <ScanFlow
              projectId={projectId}
              initialUrl={website ?? ""}
              hasLogo={hasLogo}
              kit={kit}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ScanFlow({
  projectId,
  initialUrl,
  hasLogo,
  kit,
  onClose,
}: {
  projectId: string;
  initialUrl: string;
  hasLogo: boolean;
  kit?: Pick<BrandKit, "template" | "layouts" | "logos">;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [result, setResult] = useState<SiteScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, startScan] = useTransition();
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (!scanning) return undefined;
    const id = setInterval(
      () =>
        setStage((current) => Math.min(current + 1, SCAN_STAGES.length - 1)),
      3500,
    );
    return () => clearInterval(id);
  }, [scanning]);

  function scan() {
    setError(null);
    setStage(0);
    startScan(async () => {
      const response = await scanBrandWebsiteAction(projectId, url);
      if (response.ok) setResult(response.result);
      else setError(response.message);
    });
  }

  if (result) {
    return (
      <ReviewStep
        // A new scan result must reset every default in the form.
        key={result.url + (result.logo?.dataUrl.length ?? 0)}
        projectId={projectId}
        result={result}
        hasLogo={hasLogo}
        kit={kit}
        onBack={() => setResult(null)}
        onDone={onClose}
      />
    );
  }

  return (
    <>
      <DialogHeader className="shrink-0 border-b border-foreground/10 p-4">
        <DialogTitle>Scan your website</DialogTitle>
        <DialogDescription>
          We read your public pages to find the logo, brand colors, fonts and
          visual style. Nothing is saved until you review and apply it.
        </DialogDescription>
      </DialogHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!scanning && url.trim()) scan();
        }}
        className="flex flex-col gap-4 p-4"
      >
        <div className="space-y-1.5">
          <Label htmlFor="scan-url">Website address</Label>
          <Input
            id="scan-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="example.com"
            autoFocus
            disabled={scanning}
          />
        </div>
        {scanning ? (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5 text-sm"
          >
            <Loader2 className="size-4 animate-spin" />
            {SCAN_STAGES[stage]}…
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter className="border-0 bg-transparent p-0">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={scanning || !url.trim()}>
            {scanning ? "Scanning…" : "Scan site"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-1 border-b border-border/60 pb-1">
      <p className="text-xs font-semibold tracking-wide text-foreground uppercase">
        {children}
      </p>
    </div>
  );
}

function ReviewStep({
  projectId,
  result,
  hasLogo,
  kit,
  onBack,
  onDone,
}: {
  projectId: string;
  result: SiteScanResult;
  hasLogo: boolean;
  kit?: Pick<BrandKit, "template" | "layouts" | "logos">;
  onBack: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [applying, startApply] = useTransition();
  const [primary, setPrimary] = useState<ColorSwatchValue[]>(
    result.colors.primary,
  );
  const [secondary, setSecondary] = useState<ColorSwatchValue[]>(
    result.colors.secondary,
  );
  const [accent, setAccent] = useState<ColorSwatchValue[]>(
    result.colors.accent,
  );

  // Replace the current logo by default only when there is none, or when a
  // real logo (not a fallback icon) was found.
  const [useLogo, setUseLogo] = useState(
    Boolean(result.logo) && (!hasLogo || !result.logo!.fallback),
  );

  // Post layouts: the brand's saved set, or presets built from its current
  // logo / bar template. Reviewed and saved together with the identity.
  const baseTemplate = kit?.template ?? DEFAULT_KIT_TEMPLATE;
  const [layouts, setLayouts] = useState<LayoutTemplates>(
    () => kit?.layouts ?? buildPresetLayouts(baseTemplate),
  );
  const layoutColors: LayoutPalette = {
    primary: primary[0]?.hex ?? null,
    secondary: secondary[0]?.hex ?? null,
    accent: accent[0]?.hex ?? null,
  };
  // The logos the layouts will be previewed with: what the brand already has,
  // with the scanned logo dropped into the slot its tone belongs to when the
  // user is saving it.
  const previewLogos: PreviewLogos = {
    light: kit?.logos.light ? `/api/assets/${kit.logos.light}` : null,
    dark: kit?.logos.dark ? `/api/assets/${kit.logos.dark}` : null,
  };
  if (useLogo && result.logo) {
    previewLogos[result.logo.tone] = result.logo.dataUrl;
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const list = (value: FormDataEntryValue | null, separator: RegExp) =>
      String(value ?? "")
        .split(separator)
        .map((item) => item.trim())
        .filter(Boolean);

    const payload: ApplyBrandScanPayload = {
      url: result.url,
      logoDataUrl: useLogo && result.logo ? result.logo.dataUrl : null,
      colors: {
        primary: primary.map(({ hex, name }) => ({
          hex,
          name: name || undefined,
        })),
        secondary: secondary.map(({ hex, name }) => ({
          hex,
          name: name || undefined,
        })),
        accent: accent.map(({ hex, name }) => ({
          hex,
          name: name || undefined,
        })),
      },
      fonts: list(form.get("fonts"), /,/),
      style: {
        photographyStyle: String(
          form.get("photographyStyle") ?? "MIXED",
        ) as ApplyBrandScanPayload["style"]["photographyStyle"],
        styleRefinement: String(form.get("styleRefinement") ?? ""),
        moodTags: list(form.get("moodTags"), /,/),
        compositionNotes: String(form.get("compositionNotes") ?? ""),
        backgroundTone: String(
          form.get("backgroundTone") ?? "NO_PREFERENCE",
        ) as ApplyBrandScanPayload["style"]["backgroundTone"],
        alwaysAvoid: list(form.get("alwaysAvoid"), /\n/),
      },
      layouts: normalizeLayoutNames(layouts),
    };

    startApply(async () => {
      const response = await applyBrandScanAction(projectId, payload);
      if (response.ok) {
        toast.success("Brand identity saved.");
        router.refresh();
        onDone();
      } else {
        toast.error(response.message);
      }
    });
  }

  return (
    <>
      <DialogHeader className="shrink-0 border-b border-foreground/10 p-4">
        <DialogTitle>Review brand identity</DialogTitle>
        <DialogDescription>
          Found on {new URL(result.url).hostname}. Edit anything that looks
          wrong, then apply.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          {result.warnings.length > 0 ? (
            <ul className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
              {result.warnings.map((warning) => (
                <li key={warning} className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                  {warning}
                </li>
              ))}
            </ul>
          ) : null}

          <SectionTitle>Logo</SectionTitle>
          {result.logo ? (
            <div className="flex items-center gap-4">
              {/* A light-coloured logo is only visible on a dark tile, and a
                  dark one on a light tile: the tile follows the detected
                  tone so the preview shows what the logo will look like
                  where it will actually be used. */}
              <div
                className={
                  result.logo.tone === "light"
                    ? "flex h-24 w-40 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-slate-900 p-2"
                    : "flex h-24 w-40 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-[repeating-conic-gradient(#e5e7eb_0%_25%,#f9fafb_0%_50%)] bg-[length:16px_16px] p-2"
                }
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={result.logo.dataUrl}
                  alt="Logo found on the site"
                  className="max-h-full max-w-full object-contain"
                />
              </div>
              <div className="space-y-2 text-sm">
                <p className="text-xs text-muted-foreground">
                  {result.logo.source} · {result.logo.width}×
                  {result.logo.height}px
                </p>
                <p className="text-xs text-muted-foreground">
                  {result.logo.tone === "light"
                    ? "Light-colored logo: saved as the logo for dark backgrounds."
                    : "Dark-colored logo: saved as the logo for light backgrounds."}
                </p>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="useLogo"
                    checked={useLogo}
                    onChange={(event) => setUseLogo(event.target.checked)}
                    className="size-4"
                  />
                  {hasLogo ? "Save this logo (replaces its slot)" : "Save as the brand logo"}
                </label>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No logo found. You can upload one from the Brand Brain page.
            </p>
          )}

          <SectionTitle>Palette</SectionTitle>
          <ColorSwatchInput
            name="primary"
            label="Primary colors"
            defaultValue={result.colors.primary}
            onChange={setPrimary}
          />
          <ColorSwatchInput
            name="secondary"
            label="Secondary colors"
            defaultValue={result.colors.secondary}
            onChange={setSecondary}
          />
          <ColorSwatchInput
            name="accent"
            label="Accent colors"
            defaultValue={result.colors.accent}
            onChange={setAccent}
          />

          <SectionTitle>Fonts</SectionTitle>
          <div className="space-y-1.5">
            <Input
              name="fonts"
              defaultValue={result.fonts.join(", ")}
              placeholder="Inter, Playfair Display"
              aria-label="Fonts"
            />
            <p className="text-[11px] text-muted-foreground">
              Comma-separated.
            </p>
          </div>

          <SectionTitle>Style</SectionTitle>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="scan-photo">Photography style</Label>
              <Select
                items={Object.entries(PHOTOGRAPHY_STYLE_LABEL).map(
                  ([value, label]) => ({ value, label }),
                )}
                name="photographyStyle"
                defaultValue={result.style.photographyStyle}
              >
                <SelectTrigger id="scan-photo" className="w-full">
                  <SelectValue />
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
              <Label htmlFor="scan-bg">Background tone</Label>
              <Select
                items={Object.entries(BACKGROUND_TONE_LABEL).map(
                  ([value, label]) => ({ value, label }),
                )}
                name="backgroundTone"
                defaultValue={result.style.backgroundTone}
              >
                <SelectTrigger id="scan-bg" className="w-full">
                  <SelectValue />
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
            <Label htmlFor="scan-mood">Mood / aesthetic tags</Label>
            <Input
              id="scan-mood"
              name="moodTags"
              defaultValue={result.style.moodTags.join(", ")}
              placeholder="premium, calm, trustworthy"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="scan-refine">Style refinement</Label>
            <Textarea
              id="scan-refine"
              name="styleRefinement"
              defaultValue={result.style.styleRefinement}
              rows={2}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="scan-comp">Composition notes</Label>
            <Textarea
              id="scan-comp"
              name="compositionNotes"
              defaultValue={result.style.compositionNotes}
              rows={2}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="scan-avoid">Always avoid (one per line)</Label>
            <Textarea
              id="scan-avoid"
              name="alwaysAvoid"
              defaultValue={result.style.alwaysAvoid.join("\n")}
              rows={3}
            />
          </div>

          <SectionTitle>Post layouts</SectionTitle>
          <p className="-mt-2 text-xs text-muted-foreground">
            Where the logo, color bar and headline go on your posts. The previews
            use the colors and logo above. Pick a default; new posts use it (or
            the one chosen in chat). You can change these any time from the
            Brand tab.
          </p>
          <LayoutGallery
            value={layouts}
            onChange={setLayouts}
            colors={layoutColors}
            logos={previewLogos}
            baseTemplate={baseTemplate}
            disabled={applying}
          />
        </div>
        <DialogFooter className="shrink-0 border-t border-foreground/10 p-4">
          <Button
            type="button"
            variant="ghost"
            onClick={onBack}
            disabled={applying}
            className="gap-1.5"
          >
            <ArrowLeft className="size-3.5" />
            Scan again
          </Button>
          <Button type="submit" disabled={applying}>
            {applying ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Apply to brand"
            )}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

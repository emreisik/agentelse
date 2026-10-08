"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  ARCHETYPES,
  ARCHETYPE_HINT,
  ARCHETYPE_LABEL,
  type Archetype,
} from "@/lib/auto-layout";
import {
  DESIGN_FORMATS,
  DESIGN_FORMAT_LABEL,
  type DesignFormat,
  type DesignProfile,
} from "@/lib/design-profile";
import { cn } from "@/lib/utils";
import { updateDesignLookAction } from "@/server/actions/brand-layout-actions";

const RATIO: Record<DesignFormat, string> = {
  feed: "3 / 4",
  square: "1 / 1",
  landscape: "1080 / 566",
  story: "9 / 16",
};

// The post designs, each drawn on a real picture by the code that makes the
// posts (api/projects/:id/design-preview), with the brand's own logo, font and
// colors. Each post format (feed, square, landscape, story) has its own pick,
// which applies everywhere: chat, plans, ideas, the weekly plan.
export function DesignGallery({
  projectId,
  profile,
  suggested,
  photos,
  lookKey,
}: {
  projectId: string;
  // The designs a person picked, per format.
  profile: DesignProfile | null;
  // What the brand's own words point to, used for any format with no pick.
  suggested: Archetype;
  // The brand's own clean pictures to try the designs on.
  photos: { id: string }[];
  // The brand's look, in every picture's address: a picture is drawn once per
  // look, then the browser keeps it.
  lookKey: string;
}) {
  const router = useRouter();
  const [format, setFormat] = useState<DesignFormat>("feed");
  const [photo, setPhoto] = useState<string>(photos[0]?.id ?? "sample-1");
  const [pending, startTransition] = useTransition();

  const pickOf = (key: DesignFormat) => profile?.formats[key] ?? null;
  const inUse = (key: DesignFormat) => pickOf(key) ?? suggested;
  const current = inUse(format);
  const anyPicked = DESIGN_FORMATS.some((key) => pickOf(key));
  const allSame = DESIGN_FORMATS.every((key) => inUse(key) === current);

  function change(
    target: DesignFormat | "all",
    design: Archetype | null,
    message: string,
  ) {
    startTransition(async () => {
      const result = await updateDesignLookAction(projectId, target, design);
      if (result.ok) {
        toast.success(message);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  const sources = [
    ...photos.map((entry, index) => ({
      id: entry.id,
      label: `Your photo ${index + 1}`,
    })),
    { id: "sample-1", label: "Sample 1" },
    { id: "sample-2", label: "Sample 2" },
    { id: "sample-3", label: "Sample 3" },
  ];

  return (
    <div className="space-y-4" data-kit="design-gallery">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="inline-flex rounded-lg bg-muted p-0.5"
          role="tablist"
          aria-label="Post format"
        >
          {DESIGN_FORMATS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={format === key}
              onClick={() => setFormat(key)}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                format === key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {DESIGN_FORMAT_LABEL[key]}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Preview on
          <select
            value={photo}
            onChange={(event) => setPhoto(event.target.value)}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
          >
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ul className="flex flex-wrap gap-1.5" aria-label="Design in use per format">
        {DESIGN_FORMATS.map((key) => (
          <li key={key}>
            <button
              type="button"
              onClick={() => setFormat(key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 transition-colors",
                format === key
                  ? "bg-accent ring-foreground/30"
                  : "ring-foreground/10 hover:bg-accent/50",
              )}
            >
              <span className="text-muted-foreground">
                {DESIGN_FORMAT_LABEL[key]}
              </span>
              <span className="font-medium">{ARCHETYPE_LABEL[inUse(key)]}</span>
              {pickOf(key) ? null : (
                <span className="text-[10px] text-muted-foreground">auto</span>
              )}
            </button>
          </li>
        ))}
      </ul>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ARCHETYPES.map((design) => {
          const active = design === current;
          return (
            <button
              key={design}
              type="button"
              onClick={() =>
                change(
                  format,
                  design,
                  `${DESIGN_FORMAT_LABEL[format]} posts now use the ${ARCHETYPE_LABEL[design]} design`,
                )
              }
              disabled={pending || design === pickOf(format)}
              aria-pressed={active}
              className={cn(
                "group flex flex-col gap-2 rounded-2xl p-2.5 text-left ring-1 transition-colors disabled:opacity-60",
                active
                  ? "bg-accent ring-foreground/40"
                  : "bg-card ring-foreground/10 hover:bg-accent/50",
              )}
            >
              <div
                className="w-full overflow-hidden rounded-xl bg-muted"
                style={{ aspectRatio: RATIO[format] }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a server-rendered preview, not a static asset */}
                <img
                  src={`/api/projects/${projectId}/design-preview?design=${design}&format=${format}&photo=${encodeURIComponent(photo)}&v=${lookKey}`}
                  alt={`${ARCHETYPE_LABEL[design]} design on a ${DESIGN_FORMAT_LABEL[format].toLowerCase()} post`}
                  loading="lazy"
                  decoding="async"
                  className="size-full object-cover"
                />
              </div>
              <div className="flex items-start gap-2 px-0.5 pb-0.5">
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ring-1",
                    active
                      ? "bg-foreground text-background ring-foreground"
                      : "ring-foreground/25",
                  )}
                  aria-hidden
                >
                  {active ? <Check className="size-3" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {ARCHETYPE_LABEL[design]}
                    {active ? (
                      <span className="rounded-full bg-foreground px-1.5 py-0.5 text-[10px] font-semibold text-background">
                        {pickOf(format)
                          ? `In use for ${DESIGN_FORMAT_LABEL[format]}`
                          : "Automatic pick"}
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {ARCHETYPE_HINT[design]}
                  </span>
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span>
          Each format has its own design. The logo, your font and your colors
          are your own.
        </span>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {allSame ? null : (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                change(
                  "all",
                  current,
                  `Every format now uses the ${ARCHETYPE_LABEL[current]} design`,
                )
              }
              className="inline-flex items-center gap-1.5 font-medium text-foreground underline-offset-4 hover:underline disabled:opacity-60"
            >
              Use {ARCHETYPE_LABEL[current]} for all formats
            </button>
          )}
          {pickOf(format) ? (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                change(format, null, `${DESIGN_FORMAT_LABEL[format]} is automatic again`)
              }
              className="inline-flex items-center gap-1.5 font-medium text-foreground underline-offset-4 hover:underline disabled:opacity-60"
            >
              {pending ? <Loader2 className="size-3 animate-spin" /> : null}
              {DESIGN_FORMAT_LABEL[format]} back to automatic
            </button>
          ) : null}
          {anyPicked ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => change("all", null, "Every format is automatic again")}
              className="inline-flex items-center gap-1.5 font-medium text-foreground underline-offset-4 hover:underline disabled:opacity-60"
            >
              All back to automatic
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

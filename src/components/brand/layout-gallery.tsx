"use client";

import { useState } from "react";
import { AlertTriangle, Copy, RotateCcw, Trash2 } from "lucide-react";

import {
  LayoutPreview,
  previewAspect,
  type PreviewLogos,
} from "@/components/brand/layout-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { KitTemplate } from "@/lib/brand-kit";
import { isDarkColor } from "@/lib/color-contrast";
import {
  barModeOf,
  buildPresetLayouts,
  describeLayout,
  duplicateLayout,
  HEADLINE_ZONES,
  LAYOUT_LOGO_POSITIONS,
  MAX_LAYOUTS,
  removeLayout,
  resolveLayoutColor,
  withBarMode,
  type BarMode,
  type LayoutPalette,
  type LayoutTemplate,
  type LayoutTemplates,
} from "@/lib/layout-templates";
import { cn } from "@/lib/utils";

// The layout editor: a grid of live previews (each the brand's real colours
// and logo at the layout's exact geometry) and, for the selected layout, the
// controls that change it. Fully controlled — the parent owns the layouts and
// decides when to save (the Brand tab's editor dialog, or the scan modal).

const LOGO_POSITION_LABEL: Record<
  (typeof LAYOUT_LOGO_POSITIONS)[number],
  string
> = {
  TOP_LEFT: "Top left",
  TOP_CENTER: "Top center",
  TOP_RIGHT: "Top right",
  BOTTOM_LEFT: "Bottom left",
  CENTER_BOTTOM: "Bottom center",
  BOTTOM_RIGHT: "Bottom right",
};

const HEADLINE_ZONE_LABEL: Record<(typeof HEADLINE_ZONES)[number], string> = {
  TOP: "Top",
  UPPER_LEFT: "Upper left",
  CENTER: "Center",
  LEFT_COLUMN: "Left column",
  BOTTOM: "Bottom",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

// A band that swallows the logo: with one logo variant only, the band's own
// colour may make it unreadable. Corner logos sit on a photo we cannot see, so
// only the band case can be judged.
function bandLogoWarning(
  layout: LayoutTemplate,
  colors: LayoutPalette,
  logos: PreviewLogos,
): string | null {
  const onBand =
    layout.logo.onBand && layout.bar.enabled && layout.bar.style === "band";
  if (!onBand) return null;
  if (!logos.light && !logos.dark) {
    return "No logo is set yet, so the band will be empty.";
  }
  if (logos.light && logos.dark) return null;
  const band = resolveLayoutColor(layout.bar.color, colors);
  if (!band) return null;
  if (isDarkColor(band) && !logos.light) {
    return "This band is dark but only a dark-colored logo is set. Add a light-colored logo so it stays readable.";
  }
  if (!isDarkColor(band) && !logos.dark) {
    return "This band is light but only a light-colored logo is set. Add a dark-colored logo so it stays readable.";
  }
  return null;
}

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50";

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11px]">
      <span className="text-muted-foreground">
        {label}
        {hint ? <span className="ml-1 tabular-nums">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

export function LayoutGallery({
  value,
  onChange,
  colors,
  logos,
  baseTemplate,
  disabled,
}: {
  value: LayoutTemplates;
  onChange: (next: LayoutTemplates) => void;
  colors: LayoutPalette;
  logos: PreviewLogos;
  // The brand's base template: what a preset "Classic" resets to.
  baseTemplate: KitTemplate;
  disabled?: boolean;
}) {
  const [selectedId, setSelectedId] = useState(value.defaultId);
  const selected =
    value.items.find((item) => item.id === selectedId) ?? value.items[0]!;

  const update = (
    id: string,
    change: (layout: LayoutTemplate) => LayoutTemplate,
  ) =>
    onChange({
      ...value,
      items: value.items.map((item) => (item.id === id ? change(item) : item)),
    });

  const setBarMode = (mode: BarMode) =>
    update(selected.id, (layout) => withBarMode(layout, mode));

  const duplicate = () => {
    const result = duplicateLayout(value, selected.id);
    if (!result) return;
    onChange(result.value);
    setSelectedId(result.newId);
  };

  const remove = () => {
    const next = removeLayout(value, selected.id);
    if (!next) return;
    onChange(next);
    setSelectedId(value.defaultId);
  };

  const presetOfSelected = buildPresetLayouts(baseTemplate).items.find(
    (item) => item.id === selected.id,
  );
  const warning = bandLogoWarning(selected, colors, logos);
  const bandMode = barModeOf(selected) === "band";

  return (
    <div className="flex flex-col gap-4" data-layout-gallery>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {value.items.map((layout) => {
          const isDefault = layout.id === value.defaultId;
          const isSelected = layout.id === selected.id;
          return (
            <button
              key={layout.id}
              type="button"
              disabled={disabled}
              aria-pressed={isSelected}
              onClick={() => setSelectedId(layout.id)}
              className={cn(
                "flex flex-col gap-1.5 rounded-xl border p-2 text-left transition-colors hover:bg-muted/50",
                isSelected
                  ? "border-foreground/60 bg-muted/40"
                  : "border-border/60",
              )}
            >
              <div className="mx-auto w-full max-w-[120px]">
                <LayoutPreview
                  layout={layout}
                  colors={colors}
                  logos={logos}
                  aspect={previewAspect(layout)}
                />
              </div>
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-xs font-medium">
                  {layout.name || "Untitled"}
                </span>
                {isDefault ? (
                  <span className="shrink-0 rounded-full bg-foreground px-1.5 py-0.5 text-[9px] font-semibold text-background">
                    Default
                  </span>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>

      <div
        className="flex flex-col gap-4 rounded-xl border border-border/60 p-3.5"
        data-layout-editor={selected.id}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {selected.name || "Untitled"}
            </p>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {selected.description || describeLayout(selected)}
            </p>
          </div>
          {selected.id === value.defaultId ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              Default layout
            </span>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => onChange({ ...value, defaultId: selected.id })}
            >
              Use as default
            </Button>
          )}
        </div>

        {warning ? (
          <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
            {warning}
          </p>
        ) : null}

        <Field label="Name">
          <Input
            value={selected.name}
            maxLength={40}
            disabled={disabled}
            onChange={(event) =>
              update(selected.id, (layout) => ({
                ...layout,
                name: event.target.value.slice(0, 40),
              }))
            }
            className="h-8 text-xs"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Logo position">
            <select
              className={selectClass}
              disabled={disabled}
              value={selected.logo.position}
              onChange={(event) =>
                update(selected.id, (layout) => ({
                  ...layout,
                  logo: {
                    ...layout.logo,
                    position: event.target
                      .value as LayoutTemplate["logo"]["position"],
                  },
                }))
              }
            >
              {LAYOUT_LOGO_POSITIONS.map((position) => (
                <option key={position} value={position}>
                  {LOGO_POSITION_LABEL[position]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Logo size" hint={`${selected.logo.sizePercent}%`}>
            <input
              type="range"
              min={8}
              max={30}
              disabled={disabled}
              value={selected.logo.sizePercent}
              onChange={(event) =>
                update(selected.id, (layout) => ({
                  ...layout,
                  logo: {
                    ...layout.logo,
                    sizePercent: clamp(Number(event.target.value), 8, 30),
                  },
                }))
              }
            />
          </Field>
          <Field label="Logo margin" hint={`${selected.logo.marginPercent}%`}>
            <input
              type="range"
              min={1}
              max={15}
              disabled={disabled}
              value={selected.logo.marginPercent}
              onChange={(event) =>
                update(selected.id, (layout) => ({
                  ...layout,
                  logo: {
                    ...layout.logo,
                    marginPercent: clamp(Number(event.target.value), 1, 15),
                  },
                }))
              }
            />
          </Field>
          <label className="flex items-end gap-2 pb-1 text-xs">
            <input
              type="checkbox"
              className="size-4"
              disabled={disabled || !bandMode}
              checked={selected.logo.onBand && bandMode}
              onChange={(event) =>
                update(selected.id, (layout) => ({
                  ...layout,
                  logo: { ...layout.logo, onBand: event.target.checked },
                }))
              }
            />
            <span className={bandMode ? "" : "text-muted-foreground"}>
              Logo sits on the band
            </span>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Color bar">
            <select
              className={selectClass}
              disabled={disabled}
              value={barModeOf(selected)}
              onChange={(event) => setBarMode(event.target.value as BarMode)}
            >
              <option value="none">None</option>
              <option value="line">Thin line</option>
              <option value="band">Brand band</option>
            </select>
          </Field>
          <Field label="Bar color">
            <select
              className={selectClass}
              disabled={disabled || !selected.bar.enabled}
              value={
                selected.bar.color === "primary" ||
                selected.bar.color === "secondary" ||
                selected.bar.color === "accent"
                  ? selected.bar.color
                  : "custom"
              }
              onChange={(event) => {
                const next = event.target.value;
                if (next === "custom") return;
                update(selected.id, (layout) => ({
                  ...layout,
                  bar: {
                    ...layout.bar,
                    color: next as "primary" | "secondary" | "accent",
                  },
                }));
              }}
            >
              <option value="primary">Primary</option>
              <option value="secondary">Secondary</option>
              <option value="accent">Accent</option>
              {selected.bar.color.startsWith("#") ? (
                <option value="custom">{selected.bar.color}</option>
              ) : null}
            </select>
          </Field>
          <Field label="Bar edge">
            <select
              className={selectClass}
              disabled={disabled || !selected.bar.enabled}
              value={selected.bar.position}
              onChange={(event) =>
                update(selected.id, (layout) => ({
                  ...layout,
                  bar: {
                    ...layout.bar,
                    position: event.target.value as "TOP" | "BOTTOM",
                  },
                }))
              }
            >
              <option value="BOTTOM">Bottom</option>
              <option value="TOP">Top</option>
            </select>
          </Field>
          <Field label="Bar height" hint={`${selected.bar.heightPercent}%`}>
            <input
              type="range"
              min={bandMode ? 8 : 2}
              max={bandMode ? 20 : 8}
              disabled={disabled || !selected.bar.enabled}
              value={selected.bar.heightPercent}
              onChange={(event) =>
                update(selected.id, (layout) => ({
                  ...layout,
                  bar: {
                    ...layout.bar,
                    heightPercent: clamp(
                      Number(event.target.value),
                      layout.bar.style === "band" ? 8 : 2,
                      layout.bar.style === "band" ? 20 : 8,
                    ),
                  },
                }))
              }
            />
          </Field>
        </div>

        <div className="space-y-3">
          <label className="flex items-center gap-2 text-xs font-medium">
            <input
              type="checkbox"
              className="size-4"
              disabled={disabled}
              checked={selected.headline.enabled}
              onChange={(event) =>
                update(selected.id, (layout) => ({
                  ...layout,
                  headline: {
                    ...layout.headline,
                    enabled: event.target.checked,
                  },
                }))
              }
            />
            Headline on the image
          </label>
          {selected.headline.enabled ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Headline area">
                <select
                  className={selectClass}
                  disabled={disabled}
                  value={selected.headline.zone}
                  onChange={(event) =>
                    update(selected.id, (layout) => ({
                      ...layout,
                      headline: {
                        ...layout.headline,
                        zone: event.target
                          .value as LayoutTemplate["headline"]["zone"],
                      },
                    }))
                  }
                >
                  {HEADLINE_ZONES.map((zone) => (
                    <option key={zone} value={zone}>
                      {HEADLINE_ZONE_LABEL[zone]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Alignment">
                <select
                  className={selectClass}
                  disabled={disabled}
                  value={selected.headline.align}
                  onChange={(event) =>
                    update(selected.id, (layout) => ({
                      ...layout,
                      headline: {
                        ...layout.headline,
                        align: event.target.value as "left" | "center",
                      },
                    }))
                  }
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                </select>
              </Field>
              <Field label="Size">
                <select
                  className={selectClass}
                  disabled={disabled}
                  value={selected.headline.scale}
                  onChange={(event) =>
                    update(selected.id, (layout) => ({
                      ...layout,
                      headline: {
                        ...layout.headline,
                        scale: event.target.value as "M" | "L" | "XL",
                      },
                    }))
                  }
                >
                  <option value="M">Medium</option>
                  <option value="L">Large</option>
                  <option value="XL">Extra large</option>
                </select>
              </Field>
              <Field label="Max lines">
                <select
                  className={selectClass}
                  disabled={disabled}
                  value={selected.headline.maxLines}
                  onChange={(event) =>
                    update(selected.id, (layout) => ({
                      ...layout,
                      headline: {
                        ...layout.headline,
                        maxLines: clamp(Number(event.target.value), 1, 5),
                      },
                    }))
                  }
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ) : null}
        </div>

        <Field label="Scene guidance for the image (optional)">
          <Textarea
            value={selected.composition}
            maxLength={240}
            rows={2}
            disabled={disabled}
            placeholder="e.g. keep the subject in the lower two thirds, upper third calm"
            onChange={(event) =>
              update(selected.id, (layout) => ({
                ...layout,
                composition: event.target.value.slice(0, 240),
              }))
            }
            className="text-xs"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled || value.items.length >= MAX_LAYOUTS}
            onClick={duplicate}
            className="gap-1"
          >
            <Copy className="size-3" />
            Duplicate
          </Button>
          {presetOfSelected ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => update(selected.id, () => presetOfSelected)}
              className="gap-1"
            >
              <RotateCcw className="size-3" />
              Reset to preset
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={
              disabled ||
              value.items.length <= 1 ||
              selected.id === value.defaultId
            }
            onClick={remove}
            className="gap-1"
            title={
              selected.id === value.defaultId
                ? "Pick another default first"
                : undefined
            }
          >
            <Trash2 className="size-3" />
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

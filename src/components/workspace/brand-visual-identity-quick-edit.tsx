"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, X } from "lucide-react";

import { buildHubHref } from "@/components/hub-core/hub-core-params";
import {
  ColorSwatchInput,
  type ColorSwatchValue,
} from "@/components/brand/color-swatch-input";
import { updateApprovedFontsAction } from "@/server/actions/project-actions";
import { updateVisualIdentityColorsAction } from "@/server/actions/brand-visual-identity-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// The workspace "Brand" panel's compact "change it right here" affordance
// — the full Visual Identity dialog (17 fields, 3 role-split color groups,
// template geometry, mood/composition notes) stays the tool for a real
// styling pass, but forcing a 4-click detour for "just fix this hex code"
// is exactly what the client complained about. This popover only ever
// touches `primaryColors` + `approvedFonts` (see the two actions' own
// comments for why they're separate, narrow, partial updates rather than
// reusing the full-form actions) — everything set via the advanced dialog
// (secondary/accent colors, photography style, etc.) is untouched by it.
export function BrandVisualIdentityQuickEdit({
  projectId,
  colors,
  fonts,
}: {
  projectId: string;
  colors: ColorSwatchValue[];
  fonts: string[];
}) {
  const [open, setOpen] = useState(false);
  const [colorDraft, setColorDraft] = useState<ColorSwatchValue[]>(colors);
  const [fontDraft, setFontDraft] = useState<string[]>(fonts);
  const [fontInput, setFontInput] = useState("");
  const [isSaving, startSaving] = useTransition();

  const addFont = () => {
    const value = fontInput.trim();
    if (!value || fontDraft.includes(value)) {
      setFontInput("");
      return;
    }
    setFontDraft((prev) => [...prev, value]);
    setFontInput("");
  };

  const save = () => {
    startSaving(async () => {
      const [colorResult, fontResult] = await Promise.all([
        updateVisualIdentityColorsAction(projectId, colorDraft),
        updateApprovedFontsAction(projectId, fontDraft),
      ]);
      if (!colorResult.ok) {
        toast.error(colorResult.message);
        return;
      }
      if (!fontResult.ok) {
        toast.error(fontResult.message);
        return;
      }
      toast.success("Visual identity updated");
      setOpen(false);
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setColorDraft(colors);
          setFontDraft(fonts);
        }
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Quick-edit visual identity"
            className="flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--ws-hover)]"
            style={{ color: "var(--ws-text-3)" }}
          />
        }
      >
        <Pencil className="size-3" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="space-y-3">
          <ColorSwatchInput
            name="primaryColors"
            label="Colors"
            defaultValue={colorDraft}
            onChange={setColorDraft}
          />

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">Fonts</p>
            <div className="flex flex-wrap gap-1.5">
              {fontDraft.map((font) => (
                <span
                  key={font}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs"
                >
                  {font}
                  <button
                    type="button"
                    aria-label={`Remove ${font} font`}
                    onClick={() =>
                      setFontDraft((prev) => prev.filter((f) => f !== font))
                    }
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <Input
                value={fontInput}
                onChange={(e) => setFontInput(e.target.value)}
                placeholder="Add a font name"
                className="h-8 flex-1 text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addFont();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={addFont}
                aria-label="Add font"
              >
                <Plus className="size-3.5" />
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
            <Link
              href={buildHubHref(projectId, {
                panel: "brand-brain",
                sub: "visual-identity",
              })}
              scroll={false}
              className="text-[11px] text-muted-foreground hover:underline"
              onClick={() => setOpen(false)}
            >
              Edit advanced →
            </Link>
            <Button type="button" size="sm" disabled={isSaving} onClick={save}>
              {isSaving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

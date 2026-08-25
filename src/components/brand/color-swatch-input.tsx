"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ColorSwatchValue = { hex: string; name?: string };

const HEX = /^#[0-9a-fA-F]{3,8}$/;
const HEX6 = /^#[0-9a-fA-F]{6}$/;

// Replaces the "structured color = raw JSON textarea" anti-pattern
// (BrandDossier.approvedColors never got a real edit UI for exactly this
// reason) with an actual color picker per row. Owns its own row list as
// local state and serializes it into ONE hidden JSON input on every
// change — the server action (brand-visual-identity-actions.ts) validates
// that shape, but the user never hand-writes JSON. `onChange` is only for
// a sibling (the live preview) that needs to react to the same colors;
// this component is the source of truth for what actually submits.
export function ColorSwatchInput({
  name,
  label,
  defaultValue,
  onChange,
}: {
  name: string;
  label: string;
  defaultValue: ColorSwatchValue[];
  onChange?: (swatches: ColorSwatchValue[]) => void;
}) {
  const [swatches, setSwatches] = useState<ColorSwatchValue[]>(defaultValue);

  function apply(next: ColorSwatchValue[]) {
    setSwatches(next);
    onChange?.(next);
  }

  function update(index: number, patch: Partial<ColorSwatchValue>) {
    apply(swatches.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }
  function remove(index: number) {
    apply(swatches.filter((_, i) => i !== index));
  }
  function add() {
    apply([...swatches, { hex: "#4338CA", name: "" }]);
  }

  const validSwatches = swatches.filter((s) => HEX.test(s.hex));

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <input type="hidden" name={name} value={JSON.stringify(validSwatches)} />
      <div className="space-y-1.5">
        {swatches.map((swatch, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              type="color"
              value={HEX6.test(swatch.hex) ? swatch.hex : "#000000"}
              onChange={(event) => update(index, { hex: event.target.value })}
              className="size-8 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
              aria-label={`${label} — color ${index + 1}`}
            />
            <Input
              value={swatch.name ?? ""}
              onChange={(event) => update(index, { name: event.target.value })}
              placeholder="Name (optional)"
              className="h-8 flex-1 text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => remove(index)}
              aria-label="Remove color"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={add}
        className="gap-1.5"
      >
        <Plus className="size-3.5" />
        Add color
      </Button>
    </div>
  );
}

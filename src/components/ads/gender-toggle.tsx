"use client";

import { cn } from "@/lib/utils";
import { GENDER_OPTIONS } from "@/lib/meta-ad-targeting-data";

// A 3-way segmented control (All / Men / Women) — genders are mutually
// exclusive as a SET (Meta's `genders` targeting field is either omitted,
// [1], or [2] for this wizard's purposes; targeting "men AND women
// specifically" separately from "all" isn't meaningfully different from
// omitting the field, so a single-select toggle is enough — no need for a
// full Checkbox group here).
export function GenderToggle({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex rounded-lg bg-muted p-0.5">
      {GENDER_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
            value === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

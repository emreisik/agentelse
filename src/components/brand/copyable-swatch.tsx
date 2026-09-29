"use client";

import { toast } from "sonner";

import { readableOn } from "@/lib/color-contrast";
import { cn } from "@/lib/utils";

const SIZE = {
  lg: "h-20",
  md: "h-14",
  sm: "h-12",
} as const;

// A brand colour as a real colour block: the label colour is picked for
// contrast against the swatch, and a click copies the hex.
export function CopyableSwatch({
  hex,
  name,
  size = "md",
  className,
}: {
  hex: string;
  name?: string;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const label = hex.toUpperCase();

  async function copy() {
    try {
      await navigator.clipboard.writeText(label);
      toast.success(`Copied ${label}`);
    } catch {
      toast.error("Couldn't copy the color");
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${label}`}
      aria-label={`${name ? `${name}, ` : ""}${label}. Click to copy.`}
      className={cn(
        "flex w-full min-w-0 flex-col justify-end overflow-hidden rounded-xl p-2 text-left ring-1 ring-black/10 transition-transform hover:scale-[1.02] focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none",
        SIZE[size],
        className,
      )}
      style={{ backgroundColor: hex, color: readableOn(hex) }}
    >
      {name ? (
        <span className="w-full truncate text-[11px] leading-tight font-medium">
          {name}
        </span>
      ) : null}
      <span className="font-mono text-[10px] leading-tight opacity-80">
        {label}
      </span>
    </button>
  );
}

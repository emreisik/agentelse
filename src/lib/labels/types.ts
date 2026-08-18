import type { LucideIcon } from "lucide-react";

// UI-only enum metadata layer. Pure constants — NEVER import engine/repository
// modules from here (client components consume these maps directly).
export type StatusTone =
  "positive" | "active" | "waiting" | "neutral" | "danger" | "special";

export type EnumMeta = {
  label: string;
  tone: StatusTone;
  icon?: LucideIcon;
};

export type EnumMap<T extends string> = Record<T, EnumMeta>;

// Tone -> class strings live in StatusBadge; exported here so score chips and
// custom surfaces can reuse the same palette.
export const TONE_CLASSES: Record<StatusTone, string> = {
  positive: "bg-success/15 text-success ring-1 ring-success/25",
  active:
    "bg-primary/12 text-primary ring-1 ring-primary/25 dark:bg-primary/20",
  waiting: "bg-warning/15 text-warning ring-1 ring-warning/25",
  neutral: "bg-muted text-muted-foreground ring-1 ring-foreground/10",
  danger:
    "bg-destructive/10 text-destructive ring-1 ring-destructive/25 dark:bg-destructive/20",
  special: "bg-special/15 text-special ring-1 ring-special/25",
};

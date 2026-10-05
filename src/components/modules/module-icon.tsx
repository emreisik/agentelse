import {
  CalendarHeart,
  ChartNoAxesColumnIncreasing,
  Megaphone,
  ScanSearch,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

import type { ModuleKey } from "@/lib/modules/catalog";
import { cn } from "@/lib/utils";

// One icon per module (src/lib/modules/catalog.ts leaves icons to the UI): the
// launcher tiles, a module's start and any list that names a module use these,
// so a module looks the same everywhere. Social is not the Content Calendar's
// plain calendar: the two sit side by side in the sidebar.
export const MODULE_ICONS: Readonly<Record<ModuleKey, LucideIcon>> = {
  social: CalendarHeart,
  ads: Megaphone,
  analytics: ChartNoAxesColumnIncreasing,
  seo: ScanSearch,
};

export function ModuleIcon({
  module,
  className,
  ...props
}: { module: ModuleKey } & Omit<LucideProps, "ref">) {
  const Icon = MODULE_ICONS[module];
  return (
    <Icon aria-hidden="true" className={cn("size-4", className)} {...props} />
  );
}

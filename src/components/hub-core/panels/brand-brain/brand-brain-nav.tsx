import Link from "next/link";
import {
  BookOpen,
  Compass,
  Gem,
  GraduationCap,
  Images,
  Palette,
  ShieldCheck,
  Target,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { buildHubHref, type BrandBrainSubKey } from "../../hub-core-params";

export const BRAND_BRAIN_TAB_LABEL: Record<BrandBrainSubKey, string> = {
  assets: "Assets",
  rules: "Rules & Knowledge",
  "visual-identity": "Visual Identity",
  media: "Media",
  constitution: "Constitution",
  goals: "Goals",
  intelligence: "Intelligence",
  // The chat's brand memory: what the user decided and what the brand learned.
  learnings: "Memory",
};

const BRAND_BRAIN_TAB_ICON: Record<BrandBrainSubKey, LucideIcon> = {
  assets: Gem,
  rules: ShieldCheck,
  "visual-identity": Palette,
  media: Images,
  constitution: BookOpen,
  goals: Target,
  intelligence: Compass,
  learnings: GraduationCap,
};

// The left menu reads top to bottom as "what the brand is" and then "where it
// is going and what it has learned".
const NAV_GROUPS: { label: string; keys: BrandBrainSubKey[] }[] = [
  {
    label: "Brand",
    keys: ["assets", "visual-identity", "media", "rules", "constitution"],
  },
  { label: "Strategy", keys: ["goals", "intelligence", "learnings"] },
];

// Vertical menu on the left from md up; a horizontally scrolling strip on a
// phone, where there is no room for a side column.
export function BrandBrainNav({
  projectId,
  active,
  counts,
}: {
  projectId: string;
  active: BrandBrainSubKey;
  counts: Partial<Record<BrandBrainSubKey, number>>;
}) {
  return (
    <nav
      aria-label="Brand Brain sections"
      className="-mx-6 flex gap-1 overflow-x-auto px-6 pb-1 md:sticky md:top-6 md:mx-0 md:block md:space-y-6 md:self-start md:overflow-visible md:px-0 md:pb-0"
    >
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="flex gap-1 md:block md:space-y-0.5">
          <p className="hidden px-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase md:block">
            {group.label}
          </p>
          {group.keys.map((key) => {
            const isActive = key === active;
            const Icon = BRAND_BRAIN_TAB_ICON[key];
            const count = counts[key];
            return (
              <Link
                key={key}
                href={buildHubHref(projectId, {
                  panel: "brand-brain",
                  sub: key,
                  entity: null,
                })}
                scroll={false}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors",
                  isActive
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="flex-1">{BRAND_BRAIN_TAB_LABEL[key]}</span>
                {count !== undefined ? (
                  <span
                    className={cn(
                      "flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums",
                      isActive
                        ? "bg-foreground/10 text-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {count}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

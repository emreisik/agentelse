import { Check, ChevronsUpDown, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { MockCard, Pill, type PillTone } from "@/components/site/mock/parts";

const BRANDS: {
  name: string;
  site: string;
  color: string;
  status: { label: string; tone: PillTone };
  active?: boolean;
}[] = [
  {
    name: "Mira Coffee",
    site: "miracoffee.com",
    color: "#2B1D16",
    status: { label: "3 to review", tone: "waiting" },
    active: true,
  },
  {
    name: "Northwind Bikes",
    site: "northwind.bike",
    color: "#1F4E79",
    status: { label: "Plan ready", tone: "live" },
  },
  {
    name: "Atelier Lune",
    site: "atelierlune.fr",
    color: "#8A5A83",
    status: { label: "5 scheduled", tone: "positive" },
  },
  {
    name: "Kale & Co.",
    site: "kaleandco.com",
    color: "#3F6B3A",
    status: { label: "Up to date", tone: "neutral" },
  },
];

// The brand switcher of an agency workspace: every client brand is its own
// project with its own brain, chats and calendar.
export function BrandsMock({ className }: { className?: string }) {
  return (
    <MockCard className={cn("overflow-hidden text-left", className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-[12px] font-medium text-muted-foreground">
          Your brands
        </p>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </div>
      <ul className="flex flex-col p-1.5">
        {BRANDS.map((brand) => (
          <li
            key={brand.name}
            className={cn(
              "flex items-center gap-3 rounded-xl px-2.5 py-2.5",
              brand.active && "bg-secondary",
            )}
          >
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold text-white"
              style={{ background: brand.color }}
            >
              {brand.name.charAt(0)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">
                {brand.name}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {brand.site}
              </span>
            </span>
            <Pill tone={brand.status.tone}>{brand.status.label}</Pill>
            {brand.active ? (
              <Check className="size-3.5" />
            ) : (
              <span className="w-3.5" />
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 border-t border-border px-4 py-3 text-[12px] font-medium">
        <Plus className="size-3.5" />
        New brand
      </div>
    </MockCard>
  );
}

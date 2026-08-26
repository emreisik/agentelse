"use client";

import { useState } from "react";
import { ChevronsUpDown, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { SUPPORTED_COUNTRIES, countryLabel } from "@/lib/locales";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

// Country multi-select — same Command+Popover+chip pattern as
// new-project-wizard.tsx's MarketMultiSelect, without the continent
// shortcuts (targeting a handful of countries at a time doesn't need them
// the way project-setup market selection did).
function summarize(codes: string[]): string {
  if (codes.length === 0) return "Select countries";
  const labels = codes.map((code) => countryLabel(code));
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

export function GeoTargetSelect({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [open, setOpen] = useState(false);

  function toggle(code: string) {
    onChange(
      value.includes(code) ? value.filter((c) => c !== code) : [...value, code],
    );
  }

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              className="w-full justify-between font-normal"
            />
          }
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {summarize(value)}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-(--anchor-width) min-w-64 p-0"
        >
          <Command>
            <CommandInput placeholder="Search countries…" />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup>
                {SUPPORTED_COUNTRIES.map((option) => (
                  <CommandItem
                    key={option.code}
                    value={option.label}
                    data-checked={value.includes(option.code)}
                    onSelect={() => toggle(option.code)}
                  >
                    {option.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((code) => (
            <span
              key={code}
              className={cn(
                "flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pr-1 pl-2.5 text-xs font-medium text-primary",
              )}
            >
              {countryLabel(code)}
              <button
                type="button"
                onClick={() => toggle(code)}
                className="flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-foreground/10"
                aria-label={`Remove ${countryLabel(code)}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

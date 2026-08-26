"use client";

import { useState } from "react";
import { ChevronsUpDown, X } from "lucide-react";

import { META_LOCALES } from "@/lib/meta-ad-targeting-data";
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

// Locale (ad_locale) multi-select — same Command+Popover+chip pattern as
// GeoTargetSelect, just over the static META_LOCALES list instead of
// SUPPORTED_COUNTRIES. Optional targeting dimension: an empty selection
// means "don't restrict by language" (the `locales` field is simply
// omitted from MetaAdSetTargeting).
function labelFor(id: number): string {
  return META_LOCALES.find((l) => l.id === id)?.label ?? String(id);
}

function summarize(ids: number[]): string {
  if (ids.length === 0) return "Any language";
  const labels = ids.map(labelFor);
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

// value/onChange are plain numbers (not the narrow MetaLocaleId union) so
// this composes with a generic react-hook-form `z.array(z.number())` field
// — same looseness GeoTargetSelect uses for its `string[]` country codes.
export function LocaleMultiSelect({
  value,
  onChange,
}: {
  value: number[];
  onChange: (value: number[]) => void;
}) {
  const [open, setOpen] = useState(false);

  function toggle(id: number) {
    onChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
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
            <CommandInput placeholder="Search languages…" />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup>
                {META_LOCALES.map((locale) => (
                  <CommandItem
                    key={locale.id}
                    value={locale.label}
                    data-checked={value.includes(locale.id)}
                    onSelect={() => toggle(locale.id)}
                  >
                    {locale.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => (
            <span
              key={id}
              className="flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pr-1 pl-2.5 text-xs font-medium text-primary"
            >
              {labelFor(id)}
              <button
                type="button"
                onClick={() => toggle(id)}
                className="flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-foreground/10"
                aria-label={`Remove ${labelFor(id)}`}
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

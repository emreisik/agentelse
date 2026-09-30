"use client";

import { useState } from "react";
import { ChevronsUpDown, X } from "lucide-react";

import { cn } from "@/lib/utils";
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
  CommandShortcut,
} from "@/components/ui/command";
import {
  SUPPORTED_COUNTRIES,
  COUNTRY_CONTINENTS,
  countryLabel,
} from "@/lib/locales";

// A prop-driven COPY of the combobox and multi-select of new-project-wizard.tsx
// (not exported there; extracting them would edit the legacy file, which stays
// untouched while the flag can turn it back on). The copy is deleted together
// with the wizard when the flag is retired.

export function ComboboxField({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { code: string; label: string }[];
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.code === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full justify-between font-normal"
          />
        }
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {selected ? selected.label : placeholder}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--anchor-width) min-w-64 p-0">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.code}
                  value={option.label}
                  data-checked={option.code === value}
                  onSelect={() => {
                    onChange(option.code);
                    setOpen(false);
                  }}
                >
                  {option.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function summarizeMarketSelection(codes: string[]): string {
  const labels = codes.map((code) => countryLabel(code));
  if (labels.length === 0) return "Select market";
  if (labels.length === 1) return labels[0] ?? "Select market";
  if (labels.length === 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

export function MarketMultiSelect({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [open, setOpen] = useState(false);

  function toggleCountry(code: string) {
    onChange(
      value.includes(code) ? value.filter((c) => c !== code) : [...value, code],
    );
  }

  function toggleContinent(continent: (typeof COUNTRY_CONTINENTS)[number]) {
    const fullySelected = continent.countryCodes.every((code) =>
      value.includes(code),
    );
    onChange(
      fullySelected
        ? value.filter(
            (code) => !continent.countryCodes.some((c) => c === code),
          )
        : Array.from(new Set([...value, ...continent.countryCodes])),
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
              className="h-11 w-full justify-between font-normal"
            />
          }
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {summarizeMarketSelection(value)}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-(--anchor-width) min-w-64 p-0"
        >
          <Command>
            <CommandInput placeholder="Search…" />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup heading="Continents">
                {COUNTRY_CONTINENTS.map((continent) => (
                  <CommandItem
                    key={continent.id}
                    value={continent.label}
                    data-checked={continent.countryCodes.every((code) =>
                      value.includes(code),
                    )}
                    onSelect={() => toggleContinent(continent)}
                  >
                    {continent.label}
                    <CommandShortcut>
                      {continent.countryCodes.length} countries
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Countries">
                {SUPPORTED_COUNTRIES.map((option) => (
                  <CommandItem
                    key={option.code}
                    value={option.label}
                    data-checked={value.includes(option.code)}
                    onSelect={() => toggleCountry(option.code)}
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
        <div className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
          {value.map((code, index) => (
            <span
              key={code}
              className={cn(
                "flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-xs font-medium",
                index === 0
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {countryLabel(code)}
              {index === 0 ? (
                <span className="text-[10px] opacity-70">· primary</span>
              ) : null}
              <button
                type="button"
                onClick={() => toggleCountry(code)}
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

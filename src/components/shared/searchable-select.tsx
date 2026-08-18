"use client";

import { useState, useTransition } from "react";
import { ChevronsUpDown, Loader2 } from "lucide-react";
import { toast } from "sonner";

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
import type { ActionResult } from "@/components/shared/action-form";

export type SearchableSelectOption = {
  value: string;
  label: string;
  // Disambiguating info shown on the second line — e.g. which account a
  // GA4 property belongs to when multiple properties share the same name.
  hint?: string;
};

// The searchable/wide-list version of ModeSwitcher — dozens of options
// (e.g. GA4 property, Search Console site) become unreadable in a native
// <select>, so this uses a Command+Popover based combobox instead.
export function SearchableSelect({
  value,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No results found.",
  options,
  action,
  hiddenFields,
  fieldName,
  successMessage = "Updated",
}: {
  value: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  options: SearchableSelectOption[];
  action: (formData: FormData) => Promise<ActionResult | void>;
  hiddenFields: Record<string, string>;
  fieldName: string;
  successMessage?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const selected = options.find((option) => option.value === value);

  function onSelect(nextValue: string) {
    setOpen(false);
    if (!nextValue || nextValue === value) return;
    const formData = new FormData();
    for (const [key, val] of Object.entries(hiddenFields)) {
      formData.set(key, val);
    }
    formData.set(fieldName, nextValue);
    startTransition(async () => {
      try {
        const result = await action(formData);
        if (result && result.ok === false) toast.error(result.message);
        else toast.success(successMessage);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Action failed");
      }
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            className="w-full justify-between font-normal"
          />
        }
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {selected ? selected.label : placeholder}
        </span>
        {pending ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin opacity-50" />
        ) : (
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--anchor-width) min-w-72 p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.hint ?? ""}`}
                  data-checked={option.value === value}
                  onSelect={() => onSelect(option.value)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {option.label}
                  </span>
                  {option.hint ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {option.hint}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

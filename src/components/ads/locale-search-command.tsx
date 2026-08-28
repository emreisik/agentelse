"use client";

import { useEffect, useState, useTransition } from "react";
import { ChevronsUpDown, Loader2, X } from "lucide-react";

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
import { searchMetaLocalesAction } from "@/server/actions/meta-targeting-actions";
import type { MetaAdLocale } from "@/server/integrations/meta-client";

const DEBOUNCE_MS = 300;

// Debounced server-backed locale (language) search — same shape as
// city-search-command.tsx, replacing a former hardcoded META_LOCALES table
// that turned out to have at least one confirmed-wrong id with a live
// lookup against Meta's own `/search?type=adlocale`. Every chip this
// produces carries the real label Meta returned, not a guessed one.
export function LocaleSearchCommand({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: { id: number; label?: string }[];
  onChange: (value: { id: number; label?: string }[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MetaAdLocale[]>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (query.trim().length < 2) {
      return;
    }
    const timer = setTimeout(() => {
      startTransition(async () => {
        const found = await searchMetaLocalesAction(projectId, query);
        setResults(found);
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, projectId]);

  const visibleResults = query.trim().length < 2 ? [] : results;

  function toggle(locale: MetaAdLocale) {
    const exists = value.some((v) => v.id === locale.id);
    onChange(
      exists
        ? value.filter((v) => v.id !== locale.id)
        : [...value, { id: locale.id, label: locale.label }],
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
          <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
            {value.length > 0
              ? `${value.length} language${value.length === 1 ? "" : "s"} selected`
              : "Search languages (optional)…"}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-(--anchor-width) min-w-64 p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Type a language name…"
            />
            <CommandList>
              {isPending ? (
                <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Searching…
                </div>
              ) : (
                <>
                  <CommandEmpty>
                    {query.trim().length < 2
                      ? "Type at least 2 characters."
                      : "No languages found."}
                  </CommandEmpty>
                  <CommandGroup>
                    {visibleResults.map((locale) => (
                      <CommandItem
                        key={locale.id}
                        value={String(locale.id)}
                        data-checked={value.some((v) => v.id === locale.id)}
                        onSelect={() => toggle(locale)}
                      >
                        {locale.label}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((locale) => (
            <span
              key={locale.id}
              className="flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pr-1 pl-2.5 text-xs font-medium text-primary"
            >
              {locale.label ?? `Locale #${locale.id}`}
              <button
                type="button"
                onClick={() =>
                  onChange(value.filter((v) => v.id !== locale.id))
                }
                className="flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-foreground/10"
                aria-label={`Remove ${locale.label ?? locale.id}`}
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

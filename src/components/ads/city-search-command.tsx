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
import { searchMetaCitiesAction } from "@/server/actions/meta-targeting-actions";
import type { MetaAdGeoLocation } from "@/server/integrations/meta-client";

const DEBOUNCE_MS = 300;

// Debounced server-backed city search — Meta's adgeolocation search isn't a
// static list (worldwide cities), so this can't reuse the local
// Command+static-array pattern GeoTargetSelect uses for countries.
// shouldFilter={false} on CommandList (via CommandInput not being wired to
// client-side filtering) — the server's `q` param IS the filter.
export function CitySearchCommand({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: { key: string; name: string }[];
  onChange: (value: { key: string; name: string }[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MetaAdGeoLocation[]>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (query.trim().length < 2) {
      return;
    }
    const timer = setTimeout(() => {
      startTransition(async () => {
        const found = await searchMetaCitiesAction(projectId, query);
        setResults(found);
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, projectId]);

  const visibleResults = query.trim().length < 2 ? [] : results;

  function toggle(loc: MetaAdGeoLocation) {
    const exists = value.some((v) => v.key === loc.key);
    onChange(
      exists
        ? value.filter((v) => v.key !== loc.key)
        : [...value, { key: loc.key, name: loc.name }],
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
              ? `${value.length} cit${value.length === 1 ? "y" : "ies"} selected`
              : "Search cities (optional)…"}
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
              placeholder="Type a city name…"
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
                      : "No cities found."}
                  </CommandEmpty>
                  <CommandGroup>
                    {visibleResults.map((loc) => (
                      <CommandItem
                        key={loc.key}
                        value={loc.key}
                        data-checked={value.some((v) => v.key === loc.key)}
                        onSelect={() => toggle(loc)}
                      >
                        {loc.name}
                        {loc.region ? (
                          <span className="ml-1 text-muted-foreground">
                            {loc.region}
                          </span>
                        ) : null}
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
          {value.map((city) => (
            <span
              key={city.key}
              className="flex items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-2.5 text-xs font-medium text-muted-foreground"
            >
              {city.name}
              <button
                type="button"
                onClick={() =>
                  onChange(value.filter((v) => v.key !== city.key))
                }
                className="flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-foreground/10"
                aria-label={`Remove ${city.name}`}
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

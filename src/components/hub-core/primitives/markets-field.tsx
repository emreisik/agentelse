"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// Proje kurulumunda "Avrupa" gibi bir kıta kısayoluyla 26 ülkeye kadar pazar
// seçilebiliyor — hepsini FieldGrid satırında chip olarak basmak satırı
// birden çok satıra bölüp kartı aşağı şişiriyordu. Bunun yerine tek satırlık
// bir özet ("Türkiye +25") gösterilir, tam liste tıklayınca popover'da açılır.
export function MarketsField({ labels }: { labels: string[] }) {
  const [open, setOpen] = useState(false);
  const [primary, ...rest] = labels;

  if (!primary) return <span className="text-sm">—</span>;
  if (rest.length === 0) {
    return <span className="text-sm font-medium">{primary}</span>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-sm font-medium transition-colors hover:text-primary"
          />
        }
      >
        <span>{primary}</span>
        <span className="rounded-full bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-secondary-foreground">
          +{rest.length}
        </span>
        <ChevronDown
          className={cn(
            "size-3 opacity-50 transition-transform",
            open && "rotate-180",
          )}
        />
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-64 w-64 overflow-y-auto">
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">
          {labels.length} pazar
        </p>
        <div className="flex flex-wrap gap-1">
          {labels.map((label, index) => (
            <span
              key={label}
              className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground"
            >
              {label}
              {index === 0 ? " · birincil" : ""}
            </span>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

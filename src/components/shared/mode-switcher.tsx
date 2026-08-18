"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActionResult } from "@/components/shared/action-form";

export type ModeOption = { value: string; label: string; hint?: string };

// Generic inline enum switcher (department mode, signal intensity).
// Submits the server action on change with a transition spinner + toast.
export function ModeSwitcher({
  value,
  options,
  action,
  hiddenFields,
  fieldName,
  successMessage = "Güncellendi",
  size = "sm",
}: {
  value: string;
  options: ModeOption[];
  action: (formData: FormData) => Promise<ActionResult | void>;
  hiddenFields: Record<string, string>;
  fieldName: string;
  successMessage?: string;
  size?: "sm" | "default";
}) {
  const [pending, startTransition] = useTransition();
  const items = options.map((option) => ({
    value: option.value,
    label: option.label,
  }));

  function onChange(next: string | null) {
    if (!next || next === value) return;
    const formData = new FormData();
    for (const [key, val] of Object.entries(hiddenFields)) {
      formData.set(key, val);
    }
    formData.set(fieldName, next);
    startTransition(async () => {
      try {
        const result = await action(formData);
        if (result && result.ok === false) toast.error(result.message);
        else toast.success(successMessage);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "İşlem başarısız");
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Select
        items={items}
        value={value}
        onValueChange={onChange}
        disabled={pending}
      >
        <SelectTrigger size={size} className="min-w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {pending ? (
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
      ) : null}
    </div>
  );
}

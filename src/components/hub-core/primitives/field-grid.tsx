import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { shortDate, timeAgo } from "@/lib/dates";
import type { EnumMeta } from "@/lib/labels";
import { StatusBadge } from "@/components/shared/status-badge";
import { JsonViewer } from "./json-viewer";

// The ONE general solution for the "no data left missing" requirement:
// each panel maps its own field list into this type and renders it with
// <FieldGrid>. If a new display format is needed, a `type` is added here —
// panel files don't reinvent the same JSX over and over.
export type FieldSpec =
  | { type: "text"; label: string; value: string | number | null | undefined }
  | { type: "boolean"; label: string; value: boolean | null | undefined }
  | {
      type: "date";
      label: string;
      value: Date | string | null | undefined;
      relative?: boolean;
    }
  | {
      type: "badge";
      label: string;
      meta: EnumMeta | undefined;
      fallback?: string;
      accentColor?: string;
    }
  | { type: "list"; label: string; values: string[] }
  | { type: "json"; label: string; value: unknown }
  | { type: "node"; label: string; node: ReactNode };

function FieldValue({ field }: { field: FieldSpec }) {
  switch (field.type) {
    case "text":
      return (
        <span className="break-words">
          {field.value === null ||
          field.value === undefined ||
          field.value === ""
            ? "—"
            : String(field.value)}
        </span>
      );
    case "boolean":
      return (
        <span>
          {field.value === null || field.value === undefined
            ? "—"
            : field.value
              ? "Yes"
              : "No"}
        </span>
      );
    case "date":
      return (
        <span className="tabular-nums">
          {field.relative ? timeAgo(field.value) : shortDate(field.value)}
        </span>
      );
    case "badge":
      return (
        <StatusBadge
          meta={field.meta}
          fallback={field.fallback}
          accentColor={field.accentColor}
        />
      );
    case "list":
      return field.values.length === 0 ? (
        <span>—</span>
      ) : (
        <div className="flex flex-wrap justify-end gap-1">
          {field.values.map((value, index) => (
            <span
              key={`${value}-${index}`}
              className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground"
            >
              {value}
            </span>
          ))}
        </div>
      );
    case "json":
      return <JsonViewer value={field.value} />;
    case "node":
      return <>{field.node}</>;
  }
}

export function FieldGrid({
  fields,
  className,
}: {
  fields: FieldSpec[];
  className?: string;
}) {
  return (
    <dl className={cn("divide-y divide-border/60", className)}>
      {fields.map((field, index) => (
        <div
          key={`${field.label}-${index}`}
          className={cn(
            "flex items-start justify-between gap-4 py-2",
            field.type === "json" && "flex-col items-stretch gap-1.5",
          )}
        >
          <dt className="shrink-0 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
            {field.label}
          </dt>
          <dd
            className={cn(
              "min-w-0 text-sm",
              field.type === "json" ? "w-full" : "text-right",
            )}
          >
            <FieldValue field={field} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

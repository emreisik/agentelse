import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/works/copy";

// The suggestion row shared by the idea panel, the master panel, change-time
// and set-a-time. Presentational: the owner decides what "other time" does.
export function SlotSuggestion({
  label,
  loading,
  empty,
  hasOther,
  onOther,
  zone,
}: {
  // "{when} suggested", already formatted.
  label: string;
  loading: boolean;
  // The empty-state sentence; null when there is a suggestion.
  empty: string | null;
  hasOther: boolean;
  onOther: () => void;
  // The project timezone: times are never printed without their zone.
  zone?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {loading ? (
          <p
            className="flex items-center gap-1.5 text-xs"
            style={{ color: "var(--ws-text-2)" }}
          >
            <Loader2
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {copyText("ideaOptions.finding")}
          </p>
        ) : empty ? (
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {empty}
          </p>
        ) : (
          <p
            className="text-sm font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            {label}
          </p>
        )}
        {!loading && !empty && hasOther ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-11 rounded-lg px-4"
            aria-label={copyText("a11y.otherTime")}
            onClick={onOther}
          >
            {copyText("ideaOptions.otherTime")}
          </Button>
        ) : null}
      </div>
      {zone ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {copyText("slot.zone", { zone })}
        </p>
      ) : null}
    </div>
  );
}

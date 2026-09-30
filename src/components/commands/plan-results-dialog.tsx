"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { JourneyResult } from "@/lib/journey";
import { getPlanResultsAction } from "@/server/actions/plan-progress-actions";

// "See results": what the measurement loop reported about the plan's published
// pieces, as it reported it. Nothing here is computed or estimated, and only
// pieces the agency published itself are measured; the client's own
// "I published it" pieces have nothing to measure.

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

export function PlanResultsList({
  results,
}: {
  results: readonly JourneyResult[];
}) {
  if (results.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
        No results yet. They appear a day or more after a piece goes out.
      </p>
    );
  }
  return (
    <ul className="max-h-[60vh] space-y-2.5 overflow-y-auto">
      {results.map((result) => (
        <li
          key={result.creativeId}
          className="space-y-1 rounded-xl border p-3"
          style={{ borderColor: "var(--ws-border)" }}
        >
          <p
            className="truncate text-sm font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            {result.title}
          </p>
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {result.where} · {result.check} · {formatDay(result.checkedAt)}
          </p>
          <p
            className="text-xs leading-relaxed whitespace-pre-line"
            style={{ color: "var(--ws-text)" }}
          >
            {result.observation}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function PlanResultsDialog({
  projectId,
  onClose,
  onPlanNext,
}: {
  projectId: string;
  onClose: () => void;
  onPlanNext: () => void;
}) {
  const [results, setResults] = useState<JourneyResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getPlanResultsAction(projectId).then((result) => {
      if (cancelled) return;
      if (result.ok) setResults(result.results);
      else setError(result.message);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Results</DialogTitle>
          <DialogDescription>
            What was measured after your pieces went out, as reported.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm" style={{ color: "var(--destructive)" }}>
            {error}
          </p>
        ) : results === null ? (
          <Loader2 className="mx-auto size-5 animate-spin" />
        ) : (
          <PlanResultsList results={results} />
        )}
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              onClose();
              onPlanNext();
            }}
          >
            Plan the next weeks
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

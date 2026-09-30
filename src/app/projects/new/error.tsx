"use client";

import { Button } from "@/components/ui/button";

// Nothing above /projects/new catches an unexpected throw (for example slug
// exhaustion while creating, or a failed read in the shell). A file convention
// cannot be gated by GUIDED_SETUP, so this boundary also covers the legacy
// wizard; the copy stays generic for that reason (spec 15, changes visible with
// every variable unset). retry() re-fetches and re-renders the segment;
// reset() would only clear the error state (Next 16.3).
export default function Error({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <p className="text-sm font-medium">
        Something went wrong.
      </p>
      <Button type="button" onClick={() => retry()} className="min-h-11 px-4">
        Try again
      </Button>
    </div>
  );
}

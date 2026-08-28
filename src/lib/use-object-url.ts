"use client";

import { useEffect, useState } from "react";

// Blob: URL for a File, created and revoked in lockstep with the file's
// identity. This effect's whole job is keeping React state synchronized
// with an external resource (a browser Blob URL) — the textbook shape for
// that is create-then-setState-then-cleanup-revoke, which the
// react-hooks/set-state-in-effect rule can't distinguish from an
// avoidable-derived-state anti-pattern for the early-return/null case
// below, hence the one disable. It's deliberately NOT computed via useMemo: URL.createObjectURL is a side
// effect, and useMemo offers no cleanup hook between its two invocations
// under React Strict Mode's dev-only double-render check, so the first
// invocation's URL would be silently never revoked. This effect IS safe
// under Strict Mode: mount -> cleanup(revoke) -> mount leaves exactly one
// live URL, because the cleanup always runs between the two invocations.
export function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

// Array variant for a variable-length set of files (carousel cards) — same
// reasoning as useObjectUrl, keyed on the array's own reference identity
// (not a per-item diff): the whole set is recomputed whenever the caller
// passes a new array, which is simple and correct, just slightly more
// churn than a per-file keyed cache would be. Card image swaps are
// infrequent relative to typing, so that tradeoff is fine.
export function useObjectUrls(files: (File | null)[]): (string | null)[] {
  const [urls, setUrls] = useState<(string | null)[]>([]);
  useEffect(() => {
    const next = files.map((file) => (file ? URL.createObjectURL(file) : null));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrls(next);
    return () => {
      next.forEach((url) => {
        if (url) URL.revokeObjectURL(url);
      });
    };
  }, [files]);
  return urls;
}

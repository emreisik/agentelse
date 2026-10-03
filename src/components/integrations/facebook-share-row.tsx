"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Loader2, Pencil, Share2, Trash2 } from "lucide-react";

import { BrandIcon } from "@/components/integrations/brand-icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  deleteFacebookPostAction,
  editFacebookPostAction,
  getFacebookShareAction,
  shareCreativeToFacebookAction,
  type FacebookShareResult,
  type FacebookShareState,
} from "@/server/actions/facebook-share-actions";

// The creative's Facebook Page row: share an approved piece on the project's
// Page, then read the live post back (its text and link), change its text or
// delete it. It renders nothing when no Facebook Page is connected. Sharing is
// a cross-post: the piece's own channel and publish line are untouched.

type Mode = "idle" | "edit" | "confirm-delete";
type Busy = null | "share" | "save" | "delete";

// While a share runs on the worker, look again every few seconds for a while.
const SHARING_POLL_MS = 4_000;
const SHARING_POLL_LIMIT = 30;

const pill = "h-7 rounded-full px-2 text-xs";

export function FacebookShareRow({
  creativeId,
  className,
}: {
  creativeId: string;
  className?: string;
}) {
  const [state, setState] = useState<FacebookShareState | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const polls = useRef(0);

  const load = useCallback(async () => {
    try {
      setState(await getFacebookShareAction(creativeId));
    } catch {
      setState({ kind: "unavailable" });
    }
  }, [creativeId]);

  useEffect(() => {
    let live = true;
    getFacebookShareAction(creativeId)
      .then((next) => {
        if (live) setState(next);
      })
      .catch(() => {
        if (live) setState({ kind: "unavailable" });
      });
    return () => {
      live = false;
    };
  }, [creativeId]);

  useEffect(() => {
    if (state?.kind !== "sharing") {
      polls.current = 0;
      return;
    }
    if (polls.current >= SHARING_POLL_LIMIT) return;
    const timer = setTimeout(() => {
      polls.current += 1;
      void load();
    }, SHARING_POLL_MS);
    return () => clearTimeout(timer);
  }, [state, load]);

  if (!state || state.kind === "unavailable") return null;

  const run = async (
    kind: Exclude<Busy, null>,
    call: () => Promise<FacebookShareResult>,
  ) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      const result = await call();
      if (result.ok) {
        toast.success(result.message);
        setMode("idle");
      } else {
        setError(result.message);
      }
    } catch {
      setError("Something went wrong, please try again.");
    } finally {
      await load();
      setBusy(null);
    }
  };

  const share = () =>
    run("share", () => shareCreativeToFacebookAction(creativeId));
  const save = () =>
    run("save", () => editFacebookPostAction(creativeId, draft));
  const remove = () =>
    run("delete", () => deleteFacebookPostAction(creativeId));

  const posted = state.kind === "posted" ? state : null;
  const manageable = Boolean(posted?.postId) && !posted?.detailsUnavailable;
  const subtitle =
    state.kind === "posted"
      ? `Posted on ${state.pageName}`
      : state.kind === "sharing"
        ? `Sharing on ${state.pageName}…`
        : state.pageName;

  return (
    <div
      className={cn("space-y-2 rounded-lg px-2.5 py-2", className)}
      style={{ background: "var(--ws-hover)" }}
      data-facebook-share={state.kind}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <BrandIcon brand="facebook" className="size-4" />
          <div className="min-w-0">
            <p
              className="truncate text-xs font-medium"
              style={{ color: "var(--ws-text)" }}
            >
              Facebook
            </p>
            <p
              className="truncate text-[11px]"
              style={{ color: "var(--ws-text-3)" }}
              role={state.kind === "sharing" ? "status" : undefined}
            >
              {subtitle}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 gap-1">
          {state.kind === "ready" || state.kind === "failed" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={pill}
              disabled={busy !== null}
              onClick={share}
            >
              {busy === "share" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Share2 className="size-3.5" />
              )}
              {state.kind === "failed" ? "Try again" : "Share"}
            </Button>
          ) : null}

          {state.kind === "sharing" ? (
            <Loader2
              className="size-3.5 animate-spin"
              style={{ color: "var(--ws-text-3)" }}
            />
          ) : null}

          {posted && mode === "idle" ? (
            <>
              {posted.permalinkUrl ? (
                <a
                  href={posted.permalinkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    pill,
                  )}
                >
                  <ExternalLink className="size-3.5" />
                  View
                </a>
              ) : null}
              {manageable ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={pill}
                    disabled={busy !== null}
                    onClick={() => {
                      setDraft(posted.message ?? "");
                      setError(null);
                      setMode("edit");
                    }}
                  >
                    <Pencil className="size-3.5" />
                    Edit text
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={pill}
                    disabled={busy !== null}
                    onClick={() => {
                      setError(null);
                      setMode("confirm-delete");
                    }}
                  >
                    <Trash2 className="size-3.5" />
                    Delete
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {state.kind === "failed" && state.reason && !error ? (
        <p className="text-[11px] text-destructive">
          Couldn&apos;t share: {state.reason}
        </p>
      ) : null}

      {posted && mode === "idle" && posted.message ? (
        <p
          className="line-clamp-3 text-[11px] whitespace-pre-line"
          style={{ color: "var(--ws-text-2)" }}
        >
          {posted.message}
        </p>
      ) : null}

      {posted && mode === "edit" ? (
        <div className="space-y-1.5">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Facebook post text"
            className="min-h-20 text-xs md:text-xs"
            disabled={busy !== null}
          />
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={pill}
              disabled={busy !== null}
              onClick={() => setMode("idle")}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className={pill}
              disabled={busy !== null || !draft.trim()}
              onClick={save}
            >
              {busy === "save" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              Save
            </Button>
          </div>
        </div>
      ) : null}

      {posted && mode === "confirm-delete" ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px]" style={{ color: "var(--ws-text-2)" }}>
            Delete this post from your Facebook Page?
          </p>
          <div className="flex shrink-0 gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={pill}
              disabled={busy !== null}
              onClick={() => setMode("idle")}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className={pill}
              disabled={busy !== null}
              onClick={remove}
            >
              {busy === "delete" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Delete
            </Button>
          </div>
        </div>
      ) : null}

      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}

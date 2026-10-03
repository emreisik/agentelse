"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import {
  ExternalLink,
  Loader2,
  Pencil,
  RefreshCw,
  Share2,
  Trash2,
} from "lucide-react";

import { BrandIcon } from "@/components/integrations/brand-icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  disabledReasonOf,
  useWorkCardHost,
} from "@/components/works/work-card-host";
import { cn } from "@/lib/utils";
import {
  deleteFacebookPostAction,
  editFacebookPostAction,
  shareCreativeToFacebookAction,
  type FacebookShareResult,
} from "@/server/actions/facebook-share-actions";
import type { FacebookShareState } from "@/server/commands/facebook-share";

// The creative's Facebook Page row: share an approved piece on the project's
// Page, then read the live post back (its text and link), change its text or
// delete it. It renders nothing when no Facebook Page is connected. Sharing is
// a cross-post: the piece's own channel and publish line are untouched.
//
// The state is read with a plain fetch (see the route's comment); only the
// changes go through Server Actions. Results and failures are announced by the
// toasts; the lines in the row only keep them on screen.

type Mode = "idle" | "edit" | "confirm-delete";
type Busy = null | "share" | "save" | "delete" | "check";

// While a share runs on the worker, look again every few seconds for a while;
// after that, or after a failed read, a "Check again" button takes over.
const SHARING_POLL_MS = 4_000;
const SHARING_POLL_LIMIT = 15;
const READ_FAILED = "Couldn't load the Facebook status. Try again in a moment.";

async function fetchShareState(
  creativeId: string,
): Promise<FacebookShareState> {
  const response = await fetch(
    `/api/creatives/${encodeURIComponent(creativeId)}/facebook-share`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as FacebookShareState;
}

export function FacebookShareRow({
  creativeId,
  className,
}: {
  creativeId: string;
  className?: string;
}) {
  const host = useWorkCardHost();
  const projectId = useParams<{ projectId: string }>()?.projectId;
  const [state, setState] = useState<FacebookShareState | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  // An action's own failure and a failed re-read are kept apart, so a later
  // successful read clears only the latter.
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [pollingDone, setPollingDone] = useState(false);
  const polls = useRef(0);
  const live = useRef(true);
  const lastKind = useRef<FacebookShareState["kind"] | null>(null);
  // Focus goes back to the button that opened an edit or a confirmation.
  const opener = useRef<HTMLButtonElement | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  // A share the worker finished while this row was polling is announced.
  const apply = useCallback((next: FacebookShareState) => {
    if (lastKind.current === "sharing" && next.kind === "posted") {
      toast.success(`Shared on Facebook (${next.pageName}).`);
    }
    lastKind.current = next.kind;
    setState(next);
  }, []);

  const load = useCallback(async (): Promise<FacebookShareState | null> => {
    try {
      const next = await fetchShareState(creativeId);
      if (live.current) {
        apply(next);
        setReadError(null);
      }
      return next;
    } catch {
      if (live.current) setReadError(READ_FAILED);
      return null;
    }
  }, [creativeId, apply]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // The first read. Its failure stays silent: most projects have no Facebook
  // Page, and an error line on every card would be noise. The row just stays
  // away until the next render reads again.
  useEffect(() => {
    let alive = true;
    fetchShareState(creativeId)
      .then((next) => {
        if (alive) apply(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [creativeId, apply]);

  useEffect(() => {
    if (state?.kind !== "sharing") {
      polls.current = 0;
      return;
    }
    if (polls.current >= SHARING_POLL_LIMIT) return;
    const timer = setTimeout(() => {
      polls.current += 1;
      void load().then((next) => {
        if (!next || polls.current >= SHARING_POLL_LIMIT) setPollingDone(true);
      });
    }, SHARING_POLL_MS);
    return () => clearTimeout(timer);
  }, [state, load]);

  useEffect(() => {
    if (mode !== "idle") return;
    const target = opener.current;
    opener.current = null;
    if (!target) return;
    if (target.isConnected) target.focus();
    else rowRef.current?.focus();
  }, [mode]);

  const current: FacebookShareState = state ?? { kind: "unavailable" };
  if (current.kind === "unavailable" && !error && !readError) return null;

  // Inside a Work, the same rule as the publish line above: nothing changes in
  // a Work that is no longer active.
  const blocked = disabledReasonOf(host, { kind: "server" });
  const locked = busy !== null || blocked !== null;
  const pill = host
    ? "min-h-11 rounded-lg px-3 text-xs sm:min-h-7 sm:rounded-full sm:px-2"
    : "h-7 rounded-full px-2 text-xs";

  const run = async (
    kind: Exclude<Busy, null>,
    call: () => Promise<FacebookShareResult>,
    onSuccess?: () => void,
  ) => {
    if (locked) return;
    setBusy(kind);
    setError(null);
    try {
      const result = await call();
      if (result.ok) {
        toast.success(result.message);
        onSuccess?.();
        setMode("idle");
      } else {
        toast.error(result.message);
        setError(result.message);
      }
    } catch {
      toast.error("Something went wrong, please try again.");
      setError("Something went wrong, please try again.");
    } finally {
      await load();
      setBusy(null);
    }
  };

  const posted = current.kind === "posted" ? current : null;
  const share = () => {
    polls.current = 0;
    setPollingDone(false);
    return run("share", () => shareCreativeToFacebookAction(creativeId));
  };
  const save = () =>
    run(
      "save",
      () => editFacebookPostAction(creativeId, draft),
      // Show the new text right away; the re-read confirms it.
      () => posted && apply({ ...posted, message: draft.trim() }),
    );
  const remove = () =>
    run(
      "delete",
      () => deleteFacebookPostAction(creativeId),
      () => posted && apply({ kind: "ready", pageName: posted.pageName }),
    );
  const checkAgain = async () => {
    setBusy("check");
    polls.current = 0;
    setPollingDone(false);
    await load();
    setBusy(null);
  };

  const manageable = Boolean(posted?.postId) && !posted?.detailsUnavailable;
  const showCheckAgain =
    (current.kind === "sharing" && pollingDone) ||
    Boolean(posted?.detailsUnavailable);
  const subtitle =
    current.kind === "posted"
      ? `Posted on ${current.pageName}`
      : current.kind === "sharing"
        ? `Sharing on ${current.pageName}…`
        : current.kind === "reconnect"
          ? "The connection needs renewing"
          : current.kind === "unavailable"
            ? ""
            : current.pageName;
  const reconnectHref = projectId
    ? `/projects/${projectId}/integrations?integration=facebook${
        host ? `&from=${encodeURIComponent(host.workId)}` : ""
      }`
    : null;
  const shownError = error ?? readError;

  return (
    <div
      ref={rowRef}
      tabIndex={-1}
      className={cn("space-y-2 rounded-lg px-2.5 py-2 outline-none", className)}
      style={{ background: "var(--ws-hover)" }}
      data-facebook-share={current.kind}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <BrandIcon brand="facebook" className="size-4" />
          <div className="min-w-0">
            <p
              className="truncate text-xs font-medium"
              style={{ color: "var(--ws-text)" }}
            >
              Facebook
            </p>
            {subtitle ? (
              <p
                className="truncate text-[11px]"
                style={{ color: "var(--ws-text-3)" }}
              >
                {subtitle}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-1">
          {current.kind === "ready" || current.kind === "failed" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={pill}
              disabled={locked}
              title={blocked ?? undefined}
              onClick={share}
            >
              {busy === "share" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Share2 className="size-3.5" />
              )}
              {current.kind === "failed" ? "Try again" : "Share"}
            </Button>
          ) : null}

          {current.kind === "sharing" && !showCheckAgain ? (
            <Loader2
              className="size-3.5 animate-spin"
              style={{ color: "var(--ws-text-3)" }}
              aria-hidden
            />
          ) : null}

          {showCheckAgain ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={pill}
              disabled={busy !== null}
              onClick={checkAgain}
            >
              {busy === "check" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Check again
            </Button>
          ) : null}

          {current.kind === "reconnect" && reconnectHref ? (
            <Link
              href={reconnectHref}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                pill,
              )}
            >
              Reconnect
            </Link>
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
                    disabled={locked}
                    title={blocked ?? undefined}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
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
                    disabled={locked}
                    title={blocked ?? undefined}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
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

      {current.kind === "failed" && current.reason && !shownError ? (
        <p className="text-[11px] text-destructive">
          Couldn&apos;t share: {current.reason}
        </p>
      ) : null}

      {posted?.detailsUnavailable && mode === "idle" ? (
        <p className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
          The post is on Facebook, but its details can&apos;t be loaded right
          now, so it can&apos;t be edited or deleted from here.
        </p>
      ) : null}

      {blocked && current.kind !== "unavailable" ? (
        <p className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
          {blocked}
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
            // 16px on phones: a smaller font makes iOS Safari zoom the page.
            className="min-h-20 text-base md:text-xs"
            disabled={busy !== null}
            autoFocus
          />
          <div className="flex flex-wrap justify-end gap-1">
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
              disabled={locked || !draft.trim()}
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px]" style={{ color: "var(--ws-text-2)" }}>
            Delete this post from your Facebook Page?
          </p>
          <div className="flex shrink-0 flex-wrap gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={pill}
              disabled={busy !== null}
              onClick={() => setMode("idle")}
              // The safe choice gets the focus.
              autoFocus
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className={pill}
              disabled={locked}
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

      {shownError ? (
        <p className="text-[11px] text-destructive">{shownError}</p>
      ) : null}
    </div>
  );
}

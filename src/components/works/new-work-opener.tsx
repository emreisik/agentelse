"use client";

import { Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { workHref } from "@/components/layout/work-list";
import { isFlowModuleKey } from "@/lib/module-flows/card";
import {
  MODULES,
  parseModuleKey,
  type ModuleKey,
} from "@/lib/modules/catalog";
import { startModuleFlowAction } from "@/server/actions/module-flow-actions";
import { copyText } from "@/lib/works/copy";
import {
  createWorkAction,
  openTodayWorkAction,
} from "@/server/actions/work-actions";

// Opening a project (its bare URL) always starts a new chat: the Work is opened
// for the client (the project's empty one when it has one, so no blank rows pile
// up) and the page moves into it. Today mode does the same for ?work=today before
// the day's Work exists. `?module=` (a module link) opens the new chat for that
// module. Guarded so a double effect (dev strict mode) cannot open two.

export const OPENER_COPY = {
  opening: "Opening a new chat…",
  today: copyText("today.opening"),
  failed: "Couldn't open a new chat.",
  retry: "Try again",
} as const;

export type OpenerMode = "new" | "today";

export function openerCopy(mode: OpenerMode = "new"): string {
  return mode === "today" ? OPENER_COPY.today : OPENER_COPY.opening;
}

// Where the page moves: the opened Work, with whatever else the landing URL
// asked for (?guide=setup, ?next=, the right panel's calendar). The URL only
// stood in for "a chat"; its other parameters must not be lost on the way.
// `?module=` is not carried: the opened Work remembers its module.
export function openedWorkHref(
  projectId: string,
  workId: string,
  landing: string,
): string {
  const params = new URLSearchParams(landing);
  params.delete("work");
  params.delete("module");
  params.delete("post");
  params.delete("idea");
  const rest = params.toString();
  return `${workHref(projectId, workId)}${rest ? `&${rest}` : ""}`;
}

// What the opener does once its action answers, apart from React so it can be
// tested: the new chat is moved into only while the person is still on the
// landing page. The action takes a moment (a cold database, the lock), and the
// sidebar and Back stay usable meanwhile: someone who has already clicked a
// chat or pressed Back must not be pulled into the new one when it answers.
export type OpenerOutcome =
  | { kind: "moved" }
  | { kind: "left" }
  | { kind: "error"; message: string };

export async function runOpener(input: {
  projectId: string;
  mode: OpenerMode;
  landing: string;
  create: () => Promise<
    { ok: true; workId: string } | { ok: false; message: string }
  >;
  stillHere: () => boolean;
  replace: (href: string) => void;
}): Promise<OpenerOutcome> {
  try {
    const result = await input.create();
    if (!input.stillHere()) return { kind: "left" };
    if (!result.ok) {
      return { kind: "error", message: result.message || OPENER_COPY.failed };
    }
    input.replace(openedWorkHref(input.projectId, result.workId, input.landing));
    return { kind: "moved" };
  } catch {
    // A dropped network or a cold database: the retry button instead of
    // spinning forever.
    return input.stillHere()
      ? { kind: "error", message: OPENER_COPY.failed }
      : { kind: "left" };
  }
}

// A module link (?module=): the chat for that module. Ads Manager, Analytics
// and SEO Manager run on a flow card (docs/modules.md): a ready one gets its
// card written at once, so the chat opens on its Brief. A card that cannot be
// written leaves the module's start on screen instead; the chat still opens.
async function openModuleWork(
  projectId: string,
  module: ModuleKey,
  sourcePost: string | null,
  sourceIdea: string | null,
): Promise<{ ok: true; workId: string } | { ok: false; message: string }> {
  const result = await createWorkAction(projectId, undefined, undefined, module);
  if (result.ok && isFlowModuleKey(module) && MODULES[module].ready) {
    await startModuleFlowAction(projectId, result.workId, module, {
      sourceCreativeId: sourcePost,
      sourceIdeaId: sourceIdea,
    }).catch(() => undefined);
  }
  return result;
}

export function NewWorkOpenerView({
  error,
  onRetry,
  mode = "new",
}: {
  error: string | null;
  onRetry: () => void;
  mode?: OpenerMode;
}) {
  return (
    <div
      className="flex h-full min-h-64 flex-col items-center justify-center gap-3 px-6 text-center text-sm"
      style={{ color: "var(--ws-text-2)" }}
    >
      {error ? (
        <>
          <p role="alert">{error}</p>
          <Button type="button" variant="outline" onClick={onRetry}>
            {OPENER_COPY.retry}
          </Button>
        </>
      ) : (
        <p role="status" className="flex items-center gap-2">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          {openerCopy(mode)}
        </p>
      )}
    </div>
  );
}

export function NewWorkOpener({
  projectId,
  mode = "new",
}: {
  projectId: string;
  mode?: OpenerMode;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const landing = search.toString();
  // Known keys only: anything else opens a general chat, as before.
  const requested = parseModuleKey(search.get("module"));
  // "Boost with an ad" on a post: the ads flow starts from that post.
  const sourcePost = search.get("post");
  // "Write this article" on the Ideas board: the SEO flow starts from that idea.
  const sourceIdea = search.get("idea");
  const started = React.useRef(false);
  // False once the person has left the landing page (and while the page is torn
  // down): a late answer then moves nowhere. Re-armed by the effect so React's
  // simulated unmount in development does not leave it false.
  const here = React.useRef(true);
  React.useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  const [error, setError] = React.useState<string | null>(null);

  const open = React.useCallback(async () => {
    setError(null);
    const outcome = await runOpener({
      projectId,
      mode,
      landing,
      // Today mode: the deterministic id makes a repeated call harmless.
      create: () =>
        mode === "today"
          ? openTodayWorkAction(projectId)
          : requested
            ? openModuleWork(projectId, requested, sourcePost, sourceIdea)
            : createWorkAction(projectId),
      stillHere: () => here.current,
      replace: (href) => router.replace(href),
    });
    if (outcome.kind === "error") {
      started.current = false;
      setError(outcome.message);
    }
  }, [projectId, router, mode, landing, requested, sourcePost, sourceIdea]);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void open();
  }, [open]);

  return (
    <NewWorkOpenerView
      mode={mode}
      error={error}
      onRetry={() => {
        started.current = true;
        void open();
      }}
    />
  );
}

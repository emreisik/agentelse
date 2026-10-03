import "server-only";

import { randomUUID } from "node:crypto";

import type { ChatAgentInput } from "./chat-agent";
import type { ChatModel, ChatStreamEvent } from "./types";

// Chat turns run DETACHED from the request that started them, like ChatGPT: a
// reload, a switch to another chat or a closed tab only drops a subscription,
// never the turn. Each turn is a run of this process, registered here while it
// works (and for a minute after it ends, so a late re-attach still replays it
// to the end). Only its own AbortController stops it: Stop (cancelRun) or the
// deadline below.
//
// The store lives on globalThis, not in module state: in dev Turbopack
// compiles this file into several layers (route handlers, pages) with module
// state of their own, and Server Fast Refresh re-creates edited modules. One
// process (one Railway instance) has one store. The DB marks the turn too
// (Command.replyStatus RUNNING), so a row that is RUNNING but has no run here
// was cut off by a restart or deploy.

// A turn nobody stops still ends: well past any real turn (a work session's
// message is capped at 10 minutes by its RunGuard).
export const RUN_DEADLINE_MS = 15 * 60_000;
// How long an ended run stays re-attachable (its log replays to `done`).
export const FINISHED_RUN_TTL_MS = 60_000;

// The agent a run drives (runChatAgent; tests pass a fake). Passed in by the
// chat route, so the page (which only asks whether a run is live) never loads
// the agent's module graph.
export type ChatRunAgent = (
  input: ChatAgentInput,
  deps?: { model?: ChatModel },
) => AsyncGenerator<ChatStreamEvent>;

export type ChatRunListener = {
  onEvent(event: ChatStreamEvent): void;
  onEnd(): void;
};

export type ChatRun = {
  runId: string;
  projectId: string;
  // The Work (chat) of the turn; null = the project's general chat.
  workId: string | null;
  userId: string;
  // Known once the agent stored the turn's Command row (its `start` event).
  commandId: string | null;
  startedAt: number;
  endedAt: number | null;
  // The ONLY thing that cancels the agent.
  controller: AbortController;
  cancelReason: "user" | "deadline" | null;
  // What the run sent so far, replayed to a late subscriber (compacted).
  events: ChatStreamEvent[];
  listeners: Set<ChatRunListener>;
};

export type ActiveChatRun = {
  commandId: string;
  workId: string | null;
  startedAt: number;
};

export type StartChatRunResult =
  | { ok: true; run: ChatRun }
  // This chat already has a turn running (`commandId` once it is known).
  | { ok: false; reason: "busy"; commandId: string | null };

type RunStore = {
  byRunId: Map<string, ChatRun>;
  byCommandId: Map<string, ChatRun>;
};

const STORE_KEY = Symbol.for("agentelse.chatRuns.v1");

function runStore(): RunStore {
  const holder = globalThis as unknown as Record<symbol, RunStore | undefined>;
  const existing = holder[STORE_KEY];
  if (existing) return existing;
  const created: RunStore = { byRunId: new Map(), byCommandId: new Map() };
  holder[STORE_KEY] = created;
  return created;
}

// A listener that throws must never break the run or the other listeners.
function safely(call: () => void): void {
  try {
    call();
  } catch (error) {
    console.error("[chat-run] listener failed:", error);
  }
}

// The replay log stays small: consecutive text deltas merge into one, and
// only the newest image preview is kept (each one is a full-size image, and
// the client shows only the latest anyway).
function compactInto(log: ChatStreamEvent[], event: ChatStreamEvent): void {
  const last = log.at(-1);
  if (event.type === "text.delta" && last?.type === "text.delta") {
    log[log.length - 1] = { type: "text.delta", text: last.text + event.text };
    return;
  }
  if (event.type === "image.partial") {
    for (let index = log.length - 1; index >= 0; index -= 1) {
      if (log[index]!.type === "image.partial") log.splice(index, 1);
    }
  }
  log.push(event);
}

// Logged compacted; every live listener still gets the original event.
function append(run: ChatRun, event: ChatStreamEvent): void {
  compactInto(run.events, event);
  for (const listener of [...run.listeners]) {
    safely(() => listener.onEvent(event));
  }
}

function forget(run: ChatRun): void {
  const store = runStore();
  if (store.byRunId.get(run.runId) === run) store.byRunId.delete(run.runId);
  if (run.commandId && store.byCommandId.get(run.commandId) === run) {
    store.byCommandId.delete(run.commandId);
  }
}

function end(run: ChatRun): void {
  run.endedAt = Date.now();
  const listeners = [...run.listeners];
  run.listeners.clear();
  for (const listener of listeners) safely(() => listener.onEnd());
  const removal = setTimeout(() => forget(run), FINISHED_RUN_TTL_MS);
  removal.unref?.();
}

async function drive(
  run: ChatRun,
  input: Omit<ChatAgentInput, "signal">,
  agent: ChatRunAgent,
  model: ChatModel | undefined,
  deadline: ReturnType<typeof setTimeout>,
): Promise<void> {
  try {
    const turn = { ...input, signal: run.controller.signal };
    const events = model ? agent(turn, { model }) : agent(turn);
    for await (const event of events) {
      if (event.type === "start" && run.commandId === null) {
        run.commandId = event.commandId;
        runStore().byCommandId.set(event.commandId, run);
      }
      append(run, event);
    }
  } catch (error) {
    // The agent settles its own failures; this is a crash it could not
    // (e.g. its row was deleted with the Work mid-turn).
    console.error("[chat-run] agent crashed:", error);
    append(run, {
      type: "error",
      code: "FAILED",
      message:
        error instanceof Error ? error.message : "Failed to send message",
    });
  } finally {
    clearTimeout(deadline);
    end(run);
  }
}

// The live run of one chat, if any.
export function findActiveRun(
  projectId: string,
  workId: string | null,
): ChatRun | undefined {
  for (const run of runStore().byRunId.values()) {
    if (
      run.endedAt === null &&
      run.projectId === projectId &&
      run.workId === workId
    ) {
      return run;
    }
  }
  return undefined;
}

// Starts a turn as a run, unless its chat already has one. The busy check and
// the registration are synchronous (no await in between), so two sends racing
// for the same chat can never both start. The agent then runs on its own; the
// caller only subscribes.
export function startChatRun(
  input: Omit<ChatAgentInput, "signal">,
  deps: { agent: ChatRunAgent; model?: ChatModel },
): StartChatRunResult {
  const workId = input.workId ?? null;
  const active = findActiveRun(input.projectId, workId);
  if (active) return { ok: false, reason: "busy", commandId: active.commandId };

  const run: ChatRun = {
    runId: randomUUID(),
    projectId: input.projectId,
    workId,
    userId: input.userId,
    commandId: null,
    startedAt: Date.now(),
    endedAt: null,
    controller: new AbortController(),
    cancelReason: null,
    events: [],
    listeners: new Set(),
  };
  runStore().byRunId.set(run.runId, run);

  const deadline = setTimeout(
    () => cancelRun(run, "deadline"),
    RUN_DEADLINE_MS,
  );
  deadline.unref?.();
  void drive(run, input, deps.agent, deps.model, deadline).catch((error: unknown) => {
    console.error("[chat-run] run failed:", error);
  });
  return { ok: true, run };
}

// Replays what the run sent so far, then follows it live. An ended run is
// replayed to its end and the listener ends at once. Returns the unsubscribe
// (it only detaches the listener: the run goes on).
export function subscribe(run: ChatRun, listener: ChatRunListener): () => void {
  for (const event of [...run.events]) {
    safely(() => listener.onEvent(event));
  }
  if (run.endedAt !== null) {
    safely(() => listener.onEnd());
    return () => undefined;
  }
  run.listeners.add(listener);
  return () => {
    run.listeners.delete(listener);
  };
}

// Stops a live run (idempotent): the agent ends the turn as STOPPED.
export function cancelRun(run: ChatRun, reason: "user" | "deadline"): void {
  if (run.endedAt !== null || run.cancelReason !== null) return;
  run.cancelReason = reason;
  run.controller.abort();
}

// The run of a turn, live or ended within FINISHED_RUN_TTL_MS.
export function findRunByCommandId(commandId: string): ChatRun | undefined {
  return runStore().byCommandId.get(commandId);
}

// Whether a turn is being written right now by a run of this process.
export function isRunLive(commandId: string): boolean {
  const run = runStore().byCommandId.get(commandId);
  return run !== undefined && run.endedAt === null;
}

// The live runs of a project whose turn row exists (the sidebar marks their
// chats as working).
export function listActiveRuns(projectId: string): ActiveChatRun[] {
  return [...runStore().byRunId.values()].flatMap((run) =>
    run.endedAt === null && run.projectId === projectId && run.commandId
      ? [
          {
            commandId: run.commandId,
            workId: run.workId,
            startedAt: run.startedAt,
          },
        ]
      : [],
  );
}

// Tests only: forget every run (live ones are cancelled first).
export function __resetChatRunsForTests(): void {
  const store = runStore();
  for (const run of store.byRunId.values()) {
    if (run.endedAt === null) run.controller.abort();
  }
  store.byRunId.clear();
  store.byCommandId.clear();
}

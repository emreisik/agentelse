import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { isRateLimited } from "@/lib/rate-limit";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { isWorksEnabled } from "@/server/works/flag";

// Shared guards of the Works actions and routes. A 'use server' file may only
// export async functions, so the helpers live here, once, instead of being
// copied into every action file with diverging messages and rate buckets.

export type GuardFail = {
  ok: false;
  code: "DISABLED" | "RATE" | "NOT_FOUND" | "FAILED" | "INVALID";
  message: string;
};

export const GUARD_MESSAGE = {
  failed: "That didn't work. Try again.",
  disabled: "Works aren't available.",
  rate: "Slow down for a moment.",
  completed: "This Work is completed. Reopen it to continue.",
} as const;

const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_BODY_MAX_BYTES = 8192;

// Every id in a request body is bounded the same way.
export const idSchema = z.string().min(1).max(64);

export function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64;
}

export type WorksAuth = {
  userId: string;
  workspaceId: string;
  defaultBrandId: string;
};

export async function authorizeWorks(
  projectId: unknown,
  opts: { bucket: string; limit: number; windowMs?: number },
): Promise<{ ok: true; auth: WorksAuth } | GuardFail> {
  if (!validId(projectId)) {
    return { ok: false, code: "INVALID", message: GUARD_MESSAGE.failed };
  }
  if (!isWorksEnabled()) {
    return { ok: false, code: "DISABLED", message: GUARD_MESSAGE.disabled };
  }
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);
  if (
    isRateLimited(
      `${opts.bucket}:${userId}`,
      opts.limit,
      opts.windowMs ?? DEFAULT_WINDOW_MS,
    )
  ) {
    return { ok: false, code: "RATE", message: GUARD_MESSAGE.rate };
  }
  return {
    ok: true,
    auth: {
      userId,
      workspaceId: access.workspaceId,
      defaultBrandId: access.defaultBrandId,
    },
  };
}

// Never leaks the error: only the label and the message reach the log.
export async function guardedAction<T extends { ok: boolean }>(
  label: string,
  run: () => Promise<T>,
): Promise<T | GuardFail> {
  try {
    return await run();
  } catch (error) {
    console.error(
      `[works] ${label} failed:`,
      error instanceof Error ? error.message : error,
    );
    return { ok: false, code: "FAILED", message: GUARD_MESSAGE.failed };
  }
}

export function refreshWorkPages(
  projectId: string,
  extra: readonly string[] = [],
): void {
  for (const path of [`/projects/${projectId}`, ...extra]) {
    try {
      revalidatePath(path);
    } catch (error) {
      console.error(
        "[works] revalidate failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

type WorkLookup = {
  where: { id: string; projectId: string };
  select: { status: true };
};

// A null workId is fine (legacy rows have no Work). The Work is looked up WITH
// the project id so an id from another project never matches.
export async function assertWorkActive(
  db: {
    work: { findFirst: (args: WorkLookup) => PromiseLike<{ status: string } | null> };
  },
  input: { workId: string | null | undefined; projectId: string },
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (input.workId === null || input.workId === undefined) return { ok: true };
  const work = await db.work.findFirst({
    where: { id: input.workId, projectId: input.projectId },
    select: { status: true },
  });
  if (!work || work.status !== "ACTIVE") {
    return { ok: false, message: GUARD_MESSAGE.completed };
  }
  return { ok: true };
}

export type BoundedJson =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413 | 415; message: string };

// Bounds and types a request body BEFORE it is parsed. Never throws.
export async function readBoundedJson(
  request: Request,
  options: { maxBytes?: number } = {},
): Promise<BoundedJson> {
  const maxBytes = options.maxBytes ?? DEFAULT_BODY_MAX_BYTES;
  const tooLarge: BoundedJson = {
    ok: false,
    status: 413,
    message: "Request body is too large.",
  };
  try {
    const type = request.headers.get("content-type") ?? "";
    if (!type.toLowerCase().includes("application/json")) {
      return {
        ok: false,
        status: 415,
        message: "Content-Type must be application/json.",
      };
    }
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;

    // Read as a stream and stop at the cap: a missing or lying
    // Content-Length must not let a huge body into memory.
    const reader = request.body?.getReader();
    if (!reader) return { ok: false, status: 400, message: "Invalid JSON." };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return tooLarge;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, status: 400, message: "Invalid JSON." };
  }
}

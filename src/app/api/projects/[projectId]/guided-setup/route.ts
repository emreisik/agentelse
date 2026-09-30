import { after, NextResponse } from "next/server";

import { CHANNEL_KEYS } from "@/lib/content-channels";
import {
  AUDIT,
  EMPTY_IDEA_OPTIONS,
  GuidedSetupRequestSchema,
  RATE,
  REQUEST_LIMITS,
  channelOptionId,
  type ApiError,
  type ApiErrorCode,
  type DraftPlanResult,
} from "@/lib/guided-setup/contract";
import { buildFirstPlanBrief } from "@/lib/guided-setup/first-plan";
import { buildApplyPlan } from "@/lib/guided-setup/plan";
import { getEnv } from "@/lib/env";
import { serializePlanBrief } from "@/lib/plan-brief";
import { isRateLimited } from "@/lib/rate-limit";
import {
  getProjectTimezone,
  todayInTimezone,
} from "@/server/chat/content-plan";
import { isGuidedSetupEnabled } from "@/server/guided-setup/flag";
import { GuidedSetupService } from "@/server/guided-setup/service";
import { isApplied, normalizeAnswers } from "@/server/guided-setup/session";
import { readIdeas, readSession } from "@/server/guided-setup/store";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// Guided setup, the JSON door (spec 7): GET polls the ideas run, POST starts
// the session, saves answers, asks for ideas and drafts the first plan. The
// one Server Action of the feature (Approve) lives in
// src/server/actions/guided-setup-actions.ts.
//
// This is the ONLY file that imports after(): discover hands the service a
// `schedule` so the service itself never touches next/server.
// Order of checks (mirrors chat/route.ts): session, project access, flag, rate
// limit, then for POST content type, body size, zod. Every answer is no-store
// and an unexpected throw is a generic 500 that never carries its message
// (Prisma texts leak table and column names).

const NO_STORE = { "Cache-Control": "no-store" } as const;

const MESSAGE = {
  unauthorized: "Unauthorized",
  notFound: "Not found",
  rate: "Too many requests. Please slow down for a moment.",
  invalid: "Invalid request.",
  busy: "Your setup is being saved. Give it a moment.",
  failed: "Something went wrong",
  legacy:
    "Plans are drafted by the agent chat, which is not switched on for this project yet.",
  notApplied: "Save your setup first.",
  noPlan:
    "Pick a goal and at least one channel (other than Ads) to draft a plan.",
} as const;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function fail(
  status: number,
  code: ApiErrorCode,
  error: string,
): NextResponse<ApiError> {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

type Params = { params: Promise<{ projectId: string }> };

type Access = {
  userId: string;
  workspaceId: string;
  projectId: string;
  defaultBrandId?: string;
};

// Session, project access, flag and the route-wide rate limit. Returns the
// caller's access, or the answer to send.
async function authorize(
  params: Params["params"],
): Promise<{ access: Access } | { response: NextResponse }> {
  const { projectId } = await params;

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return { response: fail(401, "SESSION", MESSAGE.unauthorized) };
  }

  let project: Awaited<ReturnType<typeof requireProjectAccess>>;
  try {
    project = await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (isAgentelseError(error)) {
      return { response: fail(404, "NOT_FOUND", MESSAGE.notFound) };
    }
    throw error;
  }

  // Off = the route answers exactly like a missing one.
  if (!isGuidedSetupEnabled()) {
    return { response: fail(404, "DISABLED", MESSAGE.notFound) };
  }

  if (
    isRateLimited(
      `guided-setup:${userId}:${projectId}`,
      RATE.routePerMinute,
      60_000,
    )
  ) {
    return { response: fail(429, "RATE", MESSAGE.rate) };
  }

  return {
    access: {
      userId,
      workspaceId: project.workspaceId,
      projectId,
      ...(project.defaultBrandId
        ? { defaultBrandId: project.defaultBrandId }
        : {}),
    },
  };
}

function internalError(error: unknown): NextResponse<ApiError> {
  // Server side only: the answer never carries the message.
  console.error(
    "[guided-setup] route failed:",
    error instanceof Error ? error.message : error,
  );
  return fail(500, "FAILED", MESSAGE.failed);
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const checked = await authorize(params);
    if ("response" in checked) return checked.response;

    // Two primary-key reads; nothing is started, claimed or written here.
    const poll = await GuidedSetupService.poll({ access: checked.access });
    if (!poll) return fail(404, "NOT_FOUND", MESSAGE.notFound);
    return json(poll);
  } catch (error) {
    return internalError(error);
  }
}

const isJsonContentType = (value: string | null) =>
  value !== null && /^application\/json\s*(;|$)/i.test(value.trim());

// Reads the body as UTF-8 text but gives up as soon as more than `maxBytes`
// bytes have arrived (the reader is cancelled), so a sender that leaves out or
// lies about Content-Length cannot make the server buffer the proxy's much
// larger limit first. Returns null when the body is over the cap.
async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function POST(request: Request, { params }: Params) {
  try {
    const checked = await authorize(params);
    if ("response" in checked) return checked.response;
    const { access } = checked;

    // Content type plus SameSite=Lax is the CSRF posture (same as the chat
    // routes).
    if (!isJsonContentType(request.headers.get("content-type"))) {
      return fail(415, "INVALID", MESSAGE.invalid);
    }

    // A Route Handler has no body cap of its own and this route is polled
    // every 2 s: refuse before parsing. The declared length saves reading an
    // honest oversized body; the measured length is the one that counts.
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > REQUEST_LIMITS.maxBodyBytes) {
      return fail(413, "INVALID", MESSAGE.invalid);
    }
    const text = await readBoundedText(request, REQUEST_LIMITS.maxBodyBytes);
    if (text === null) return fail(413, "INVALID", MESSAGE.invalid);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, "INVALID", MESSAGE.invalid);
    }
    const parsed = GuidedSetupRequestSchema.safeParse(body);
    if (!parsed.success) return fail(400, "INVALID", MESSAGE.invalid);
    const input = parsed.data;

    switch (input.action) {
      case "start": {
        const view = await GuidedSetupService.start({
          access,
          ...(input.seedCommandId
            ? { seedCommandId: input.seedCommandId }
            : {}),
        });
        return json(view);
      }

      case "save": {
        const result = await GuidedSetupService.save({
          access,
          step: input.step,
          more: input.more,
          answers: input.answers,
        });
        if (result.kind === "BUSY") return fail(409, "BUSY", MESSAGE.busy);
        if (result.kind === "NO_SESSION") {
          return fail(400, "INVALID", MESSAGE.invalid);
        }
        return json(result.response);
      }

      case "discover": {
        if (
          isRateLimited(
            `guided-discover:${access.userId}:${access.projectId}`,
            RATE.discoverPerMinute,
            60_000,
          )
        ) {
          return fail(429, "RATE", MESSAGE.rate);
        }
        // Never blocks on the run: the job continues after the answer is sent.
        const result = await GuidedSetupService.discover({
          access,
          schedule: (job) => after(job),
        });
        if (result.kind === "NO_SESSION") {
          return fail(400, "INVALID", MESSAGE.invalid);
        }
        if (result.kind === "FAILED")
          return fail(500, "FAILED", MESSAGE.failed);
        return json(result.response);
      }

      case "draft_plan": {
        if (
          isRateLimited(
            `guided-draft:${access.userId}:${access.projectId}`,
            RATE.draftPlanPerMinute,
            60_000,
          )
        ) {
          return fail(429, "RATE", MESSAGE.rate);
        }
        return json(await draftFirstPlan(access));
      }
    }
  } catch (error) {
    return internalError(error);
  }
}

function refused(
  code: Extract<DraftPlanResult, { ok: false }>["code"],
  message: string,
): DraftPlanResult {
  return { ok: false, code, message };
}

// The receipt's "Draft my first plan" (spec 9.8). Read-only apart from one
// audit row: the message it returns is built from closed vocabulary and numbers
// only, and the agent's own plan tools validate whatever comes back.
async function draftFirstPlan(access: Access): Promise<DraftPlanResult> {
  // On the legacy engine the same sentence could reach the weekly planner and
  // start image generation: refuse on the server, not only in the UI.
  if (getEnv().CHAT_ENGINE !== "agent") {
    return refused("LEGACY_ENGINE", MESSAGE.legacy);
  }

  const [session, ideas] = await Promise.all([
    readSession(access.projectId),
    readIdeas(access.projectId),
  ]);
  if (!session || !isApplied(session)) {
    return refused("NOT_APPLIED", MESSAGE.notApplied);
  }

  const options = ideas?.options ?? EMPTY_IDEA_OPTIONS;
  const plan = buildApplyPlan({
    answers: normalizeAnswers(session.answers, {
      channelIds: CHANNEL_KEYS.map(channelOptionId),
      ideas: options,
    }),
    ideas: options,
    goalMode: session.applied?.goalMode ?? "proposed",
  });

  const today = todayInTimezone(await getProjectTimezone(access.projectId));
  const brief = buildFirstPlanBrief({
    goal: plan.goal?.key,
    channels: plan.channels?.keys ?? [],
    today,
  });
  if (!brief) return refused("NO_PLAN", MESSAGE.noPlan);

  // The trail must never turn a draft into a failure; counts only.
  try {
    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId: access.projectId,
      ...(access.defaultBrandId ? { brandId: access.defaultBrandId } : {}),
      actorType: "USER",
      actorId: access.userId,
      action: AUDIT.firstPlanRequested,
      entityType: "Project",
      entityId: access.projectId,
      metadata: { channels: brief.channels.length },
    });
  } catch (error) {
    console.error(
      "[guided-setup] first plan audit failed:",
      error instanceof Error ? error.message : error,
    );
  }

  return { ok: true, message: serializePlanBrief(brief) };
}

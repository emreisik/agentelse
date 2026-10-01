import { after, NextResponse } from "next/server";

import { DiscoveryRequestSchema } from "@/lib/guided-discovery/contract";
import { isRateLimited } from "@/lib/rate-limit";
import { retryDiscovery } from "@/server/guided-discovery/flow";
import {
  addCandidate,
  confirmDiscovery,
  readView,
} from "@/server/guided-discovery/service";
import { isGuidedSetupEnabled } from "@/server/guided-setup/flag";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// Guided discovery, the JSON door (spec 7): GET reads the discovery row, POST
// adds one "also found" chip, confirms the profile or retries a failed run.
// Nothing paid starts from a GET: only the create tap (intake-start) and an
// explicit Try again tap reach the research.
//
// With intake-start this is the only place that imports after(): retry hands
// the flow a `schedule`, so the flow itself never touches next/server.
// Order of checks (mirrors the guided-setup route): session, project access,
// flag, rate limit, then for POST content type, body size, zod. Every answer is
// no-store and an unexpected throw is a generic 500 that never carries its
// message (Prisma texts leak table and column names).

const NO_STORE = { "Cache-Control": "no-store" } as const;

// Local on purpose: the guided-setup contract belongs to another increment.
const MAX_BODY_BYTES = 16_384;
const RATE = { routePerMinute: 90, retryPerMinute: 6 } as const;

type ErrorCode =
  "SESSION" | "NOT_FOUND" | "DISABLED" | "RATE" | "INVALID" | "FAILED";

const MESSAGE = {
  unauthorized: "Unauthorized",
  notFound: "Not found",
  rate: "Too many requests. Please slow down for a moment.",
  invalid: "Invalid request.",
  failed: "Something went wrong",
} as const;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function fail(status: number, code: ErrorCode, error: string): NextResponse {
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
      `guided-discovery:${userId}:${projectId}`,
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

function internalError(error: unknown): NextResponse {
  // Server side only: the answer never carries the message.
  console.error(
    "[guided-discovery] route failed:",
    error instanceof Error ? error.message : error,
  );
  return fail(500, "FAILED", MESSAGE.failed);
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const checked = await authorize(params);
    if ("response" in checked) return checked.response;

    // Reads only; nothing is started, claimed or written here.
    const view = await readView({ access: checked.access });
    return json({ view });
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

    // The declared length saves reading an honest oversized body; the measured
    // length is the one that counts.
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return fail(413, "INVALID", MESSAGE.invalid);
    }
    const text = await readBoundedText(request, MAX_BODY_BYTES);
    if (text === null) return fail(413, "INVALID", MESSAGE.invalid);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, "INVALID", MESSAGE.invalid);
    }
    const parsed = DiscoveryRequestSchema.safeParse(body);
    if (!parsed.success) return fail(400, "INVALID", MESSAGE.invalid);
    const input = parsed.data;

    switch (input.action) {
      case "add": {
        const result = await addCandidate({
          access,
          candidateId: input.candidateId,
        });
        // No row (or no brand): there is nothing to add to.
        if (result.kind === "NONE")
          return fail(400, "INVALID", MESSAGE.invalid);
        return json({ view: result.view });
      }

      case "confirm": {
        const result = await confirmDiscovery({ access });
        if (result.kind === "NONE")
          return fail(400, "INVALID", MESSAGE.invalid);
        // A refused confirm (still running, failed) answers with the row as it
        // is, so the screen catches up instead of showing an error.
        return json({ view: result.view });
      }

      case "retry": {
        if (
          isRateLimited(
            `guided-discovery-retry:${access.userId}:${access.projectId}`,
            RATE.retryPerMinute,
            60_000,
          )
        ) {
          return fail(429, "RATE", MESSAGE.rate);
        }
        // Never blocks on the run: the job continues after the answer is sent.
        const result = await retryDiscovery({
          access,
          schedule: (job) => after(job),
        });
        if (!result) return fail(400, "INVALID", MESSAGE.invalid);
        return json({ view: result.view });
      }
    }
  } catch (error) {
    return internalError(error);
  }
}

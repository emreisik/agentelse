// Client-side fetch wrapper and poll schedule for the guided setup sheet.
// Plain TypeScript: fetch is injected and nothing here imports React or next/*.
import {
  POLL,
  type ApiErrorCode,
  type DiscoverResponse,
  type DraftPlanResult,
  type GuidedSetupPoll,
  type GuidedSetupRequest,
  type GuidedSetupView,
  type IdeasStatus,
  type SaveResponse,
} from "@/lib/guided-setup/contract";

export type ApiFailureKind = ApiErrorCode | "HTTP" | "NETWORK" | "TIMEOUT" | "FAILED";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: ApiFailureKind; status?: number };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const KNOWN_CODES: readonly ApiFailureKind[] = [
  "SESSION",
  "NOT_FOUND",
  "RATE",
  "INVALID",
  "BUSY",
  "DISABLED",
  "FAILED",
];

function readCode(body: unknown): ApiFailureKind | null {
  if (typeof body !== "object" || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return KNOWN_CODES.find((known) => known === code) ?? null;
}

async function readJson(response: Response): Promise<{ json: unknown } | null> {
  try {
    return { json: await response.json() };
  } catch {
    return null;
  }
}

// Mapping order matters: a redirect or an OK non-JSON answer is the proxy's
// login page (SESSION); a NOT ok answer is judged by its JSON code, and a
// non-JSON one (a 502 page during a deploy) is HTTP, never SESSION.
export async function requestJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (response.redirected) return { ok: false, kind: "SESSION", status: response.status };
    const parsed = await readJson(response);
    if (response.ok) {
      if (!parsed) return { ok: false, kind: "SESSION", status: response.status };
      return { ok: true, data: parsed.json as T };
    }
    // A 3xx that fetch did not follow (opaque manual redirect) is a session bounce too.
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, kind: "SESSION", status: response.status };
    }
    const code = parsed ? readCode(parsed.json) : null;
    if (code) return { ok: false, kind: code, status: response.status };
    return { ok: false, kind: "HTTP", status: response.status };
  } catch {
    return { ok: false, kind: timedOut ? "TIMEOUT" : "NETWORK" };
  } finally {
    clearTimeout(timer);
  }
}

export function api(projectId: string, fetchImpl: FetchLike) {
  const url = `/api/projects/${encodeURIComponent(projectId)}/guided-setup`;
  const post = <T>(body: GuidedSetupRequest) =>
    requestJson<T>(
      fetchImpl,
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      },
      POLL.requestTimeoutMs,
    );
  return {
    start: (seedCommandId?: string) =>
      post<GuidedSetupView>(seedCommandId ? { action: "start", seedCommandId } : { action: "start" }),
    save: (input: Omit<Extract<GuidedSetupRequest, { action: "save" }>, "action">) =>
      post<SaveResponse>({ action: "save", ...input }),
    discover: () => post<DiscoverResponse>({ action: "discover" }),
    draftPlan: () => post<DraftPlanResult>({ action: "draft_plan" }),
    poll: () =>
      requestJson<GuidedSetupPoll>(
        fetchImpl,
        url,
        { method: "GET", cache: "no-store" },
        POLL.requestTimeoutMs,
      ),
  };
}

export type PollState = {
  elapsedMs: number;
  status: IdeasStatus;
  hidden: boolean;
  // Consecutive failed polls (RATE, 5xx, network): a silent backoff, never a notice.
  failures: number;
};

// Delay before the next poll, or null to stop polling.
export function nextPollDelay({ elapsedMs, status, hidden, failures }: PollState): number | null {
  if (status !== "RUNNING" || hidden) return null;
  if (elapsedMs >= POLL.maxMs) return null;
  if (failures >= POLL.maxConsecutiveFailures) return null;
  if (failures <= 0) return POLL.intervalMs;
  return Math.min(POLL.intervalMs * 2 ** failures, POLL.maxDelayMs);
}

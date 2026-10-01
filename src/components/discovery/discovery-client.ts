// Client-side fetch wrapper and poll schedule for the discovery sheet.
// Plain TypeScript: fetch is injected and nothing here imports React or next/*.
import {
  STATUSES,
  type DiscoveryRequest,
  type DiscoveryView,
} from "@/lib/guided-discovery/contract";

export const DISCOVERY_POLL = {
  requestTimeoutMs: 15_000,
  intervalMs: 2_000,
  backoffMs: 10_000,
  maxMs: 300_000,
  maxConsecutiveFailures: 3,
} as const;

export type DiscoveryFailureCode =
  "SESSION" | "NETWORK" | "TIMEOUT" | "HTTP" | "DISABLED";

export type DiscoveryResult =
  // `view` is null only when the project has no discovery row.
  | { ok: true; view: DiscoveryView | null }
  | { ok: false; code: DiscoveryFailureCode; status?: number };

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

async function readJson(response: Response): Promise<{ json: unknown } | null> {
  try {
    return { json: await response.json() };
  } catch {
    return null;
  }
}

// A cheap shape check: the route is ours, but a proxy page or a deploy-skew
// answer must never reach the reducer as a view.
function isView(value: unknown): value is DiscoveryView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<Record<keyof DiscoveryView, unknown>>;
  return (
    typeof v.rev === "string" &&
    typeof v.status === "string" &&
    (STATUSES as readonly string[]).includes(v.status) &&
    typeof v.stages === "object" &&
    v.stages !== null &&
    Array.isArray(v.rows) &&
    typeof v.canRetry === "boolean"
  );
}

// Mapping order matters: a redirect or an OK non-JSON answer is the proxy's
// login page (SESSION); a 404 is the flag being off (the route is gone); any
// other non-OK answer, JSON or not (a 502 page during a deploy), is HTTP.
export async function requestView(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number = DISCOVERY_POLL.requestTimeoutMs,
): Promise<DiscoveryResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.redirected) {
      return { ok: false, code: "SESSION", status: response.status };
    }
    if (response.status === 401) {
      return { ok: false, code: "SESSION", status: response.status };
    }
    // A 3xx that fetch did not follow (opaque manual redirect) is a bounce too.
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, code: "SESSION", status: response.status };
    }
    if (response.status === 404) {
      return { ok: false, code: "DISABLED", status: response.status };
    }
    const parsed = await readJson(response);
    if (response.ok) {
      if (!parsed)
        return { ok: false, code: "SESSION", status: response.status };
      const body = parsed.json;
      const view =
        typeof body === "object" && body !== null
          ? (body as { view?: unknown }).view
          : undefined;
      if (view === null) return { ok: true, view: null };
      if (isView(view)) return { ok: true, view };
      return { ok: false, code: "HTTP", status: response.status };
    }
    return { ok: false, code: "HTTP", status: response.status };
  } catch {
    return { ok: false, code: timedOut ? "TIMEOUT" : "NETWORK" };
  } finally {
    clearTimeout(timer);
  }
}

export type DiscoveryApi = ReturnType<typeof discoveryApi>;

export function discoveryApi(projectId: string, fetchImpl: FetchLike) {
  const url = `/api/projects/${encodeURIComponent(projectId)}/guided-discovery`;
  const post = (body: DiscoveryRequest) =>
    requestView(fetchImpl, url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    get: () => requestView(fetchImpl, url, { method: "GET" }),
    add: (candidateId: string) => post({ action: "add", candidateId }),
    confirm: () => post({ action: "confirm" }),
    retry: () => post({ action: "retry" }),
  };
}

// Delay before the next poll, or null to stop polling. `attempt` is the number
// of consecutive failed polls (0 while everything works). The caller only asks
// while the run is RUNNING; hidden tabs stop and poll once on becoming visible.
export function nextPollDelay(
  attempt: number,
  hidden: boolean,
  elapsedMs: number,
): number | null {
  if (hidden) return null;
  if (elapsedMs >= DISCOVERY_POLL.maxMs) return null;
  if (attempt >= DISCOVERY_POLL.maxConsecutiveFailures) return null;
  return attempt <= 0 ? DISCOVERY_POLL.intervalMs : DISCOVERY_POLL.backoffMs;
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscoveryView } from "@/lib/guided-discovery/contract";

// The discovery route's checks and dispatch, DB-less: the flow and the service
// are stubs (they have their own tests), so what is pinned here is the order of
// the checks, the strict body, that a GET only reads and that the retry is the
// one door that schedules work, through after().

const env = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/server/guided-setup/flag", () => ({
  isGuidedSetupEnabled: () => env.enabled,
}));

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));

const isRateLimited = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({ isRateLimited }));

const service = vi.hoisted(() => ({
  readView: vi.fn(),
  addCandidate: vi.fn(),
  confirmDiscovery: vi.fn(),
}));
vi.mock("@/server/guided-discovery/service", () => service);

const flow = vi.hoisted(() => ({
  retryDiscovery: vi.fn(),
  startDiscovery: vi.fn(),
}));
vi.mock("@/server/guided-discovery/flow", () => flow);

const after = vi.hoisted(() => vi.fn());
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after };
});

const { GET, POST } = await import("./route");
const { AgentelseError } = await import("@/server/security/errors");

const PROJECT = "proj-1";
const params = { params: Promise.resolve({ projectId: PROJECT }) };
const URL_ = `http://localhost/api/projects/${PROJECT}/guided-discovery`;
const CANDIDATE = "c_0123456789";

const VIEW: DiscoveryView = {
  rev: "abcdef012345",
  status: "READY",
  stages: {
    site: "done",
    identity: "done",
    research: "done",
    profile: "done",
  },
  identity: null,
  rows: [],
  host: "acme.example",
  failure: null,
  canRetry: false,
  brandName: "Acme",
};

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  env.enabled = true;
  requireUser.mockResolvedValue({ userId: "user-1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: PROJECT,
    defaultBrandId: "brand-1",
  });
  isRateLimited.mockReturnValue(false);
  service.readView.mockResolvedValue(VIEW);
  service.addCandidate.mockResolvedValue({ kind: "ADDED", view: VIEW });
  service.confirmDiscovery.mockResolvedValue({ kind: "CONFIRMED", view: VIEW });
  flow.retryDiscovery.mockResolvedValue({ started: true, view: VIEW });
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function nothingRan() {
  expect(service.readView).not.toHaveBeenCalled();
  expect(service.addCandidate).not.toHaveBeenCalled();
  expect(service.confirmDiscovery).not.toHaveBeenCalled();
  expect(flow.retryDiscovery).not.toHaveBeenCalled();
  expect(flow.startDiscovery).not.toHaveBeenCalled();
  expect(after).not.toHaveBeenCalled();
}

describe("route checks: session, access, flag, rate", () => {
  it("answers 401 SESSION without a session, before anything else", async () => {
    requireUser.mockRejectedValue(
      new AgentelseError("LOGIN_REQUIRED", "Authentication required"),
    );
    for (const response of [
      await GET(new Request(URL_), params),
      await POST(post({ action: "confirm" }), params),
    ]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "SESSION" });
    }
    expect(requireProjectAccess).not.toHaveBeenCalled();
    expect(isRateLimited).not.toHaveBeenCalled();
    nothingRan();
  });

  it("answers 404 NOT_FOUND for a project the user cannot reach", async () => {
    requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    for (const response of [
      await GET(new Request(URL_), params),
      await POST(post({ action: "confirm" }), params),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    }
    nothingRan();
  });

  it("answers 404 DISABLED when the flag is off, after access and before the rate limit", async () => {
    env.enabled = false;
    for (const response of [
      await GET(new Request(URL_), params),
      await POST(post({ action: "retry" }), params),
    ]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ code: "DISABLED" });
    }
    expect(requireProjectAccess).toHaveBeenCalled();
    expect(isRateLimited).not.toHaveBeenCalled();
    nothingRan();

    // A foreign project with the flag off is still the plain 404.
    requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    const foreign = await GET(new Request(URL_), params);
    expect(await foreign.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers 429 RATE from the per user and project key", async () => {
    isRateLimited.mockReturnValue(true);
    for (const response of [
      await GET(new Request(URL_), params),
      await POST(post({ action: "confirm" }), params),
    ]) {
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ code: "RATE" });
    }
    expect(isRateLimited).toHaveBeenCalledWith(
      `guided-discovery:user-1:${PROJECT}`,
      expect.any(Number),
      60_000,
    );
    nothingRan();
  });

  it("gives the retry its own, tighter limit", async () => {
    isRateLimited.mockImplementation((key: string) =>
      key.startsWith("guided-discovery-retry:"),
    );
    const response = await POST(post({ action: "retry" }), params);
    expect(response.status).toBe(429);
    expect(flow.retryDiscovery).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("hands the service the caller's access, never ids from the client", async () => {
    await GET(new Request(URL_), params);
    expect(service.readView).toHaveBeenCalledWith({
      access: {
        userId: "user-1",
        workspaceId: "ws-1",
        projectId: PROJECT,
        defaultBrandId: "brand-1",
      },
    });
  });
});

describe("GET", () => {
  it("returns the view, no-store, and starts nothing", async () => {
    const response = await GET(new Request(URL_), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ view: VIEW });
    expect(flow.retryDiscovery).not.toHaveBeenCalled();
    expect(flow.startDiscovery).not.toHaveBeenCalled();
    expect(service.addCandidate).not.toHaveBeenCalled();
    expect(service.confirmDiscovery).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("returns a null view when there is no row", async () => {
    service.readView.mockResolvedValue(null);
    const response = await GET(new Request(URL_), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ view: null });
  });
});

describe("POST body rules", () => {
  it("refuses a body that is not JSON with 415", async () => {
    const response = await POST(
      post({ action: "confirm" }, { "content-type": "text/plain" }),
      params,
    );
    expect(response.status).toBe(415);
    nothingRan();
  });

  it("refuses text that does not parse with 400", async () => {
    const response = await POST(post("{not json"), params);
    expect(response.status).toBe(400);
    nothingRan();
  });

  it("refuses extra keys and unknown actions with 400", async () => {
    for (const body of [
      { action: "confirm", extra: 1 },
      { action: "add", candidateId: CANDIDATE, text: "Families" },
      { action: "add", candidateId: CANDIDATE, field: "audience" },
      { action: "retry", projectId: "other" },
      { action: "start" },
      { action: "add" },
      { action: "add", candidateId: "families" },
      {},
      [],
    ]) {
      const response = await POST(post(body), params);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID" });
    }
    nothingRan();
  });

  it("refuses a body over 16 KB with 413, declared or measured", async () => {
    const big = JSON.stringify({ action: "confirm", pad: "x".repeat(20_000) });
    const declared = await POST(
      post(big, { "content-length": String(big.length) }),
      params,
    );
    expect(declared.status).toBe(413);

    // A sender that lies about the length is caught by the bounded read.
    const lying = await POST(post(big, { "content-length": "10" }), params);
    expect(lying.status).toBe(413);
    nothingRan();
  });
});

describe("POST dispatch", () => {
  it("add passes the id only and answers with the view", async () => {
    const response = await POST(
      post({ action: "add", candidateId: CANDIDATE }),
      params,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ view: VIEW });
    expect(service.addCandidate).toHaveBeenCalledWith({
      access: expect.objectContaining({ projectId: PROJECT }),
      candidateId: CANDIDATE,
    });
    expect(flow.retryDiscovery).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("add answers 200 with the row as it is when nothing changed", async () => {
    service.addCandidate.mockResolvedValue({ kind: "NOOP", view: VIEW });
    const response = await POST(
      post({ action: "add", candidateId: CANDIDATE }),
      params,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ view: VIEW });
  });

  it("add and confirm answer 400 when there is no row", async () => {
    service.addCandidate.mockResolvedValue({ kind: "NONE" });
    service.confirmDiscovery.mockResolvedValue({ kind: "NONE" });
    const add = await POST(
      post({ action: "add", candidateId: CANDIDATE }),
      params,
    );
    const confirm = await POST(post({ action: "confirm" }), params);
    expect(add.status).toBe(400);
    expect(confirm.status).toBe(400);
  });

  it("confirm answers with the view, also when it was refused or repeated", async () => {
    for (const kind of ["CONFIRMED", "UNCHANGED", "NOT_READY"]) {
      service.confirmDiscovery.mockResolvedValue({ kind, view: VIEW });
      const response = await POST(post({ action: "confirm" }), params);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ view: VIEW });
    }
    expect(flow.retryDiscovery).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("retry schedules the job through after() and answers at once", async () => {
    const job = vi.fn(async () => undefined);
    flow.retryDiscovery.mockImplementation(
      async (input: { schedule: (job: () => Promise<void>) => void }) => {
        input.schedule(job);
        return { started: true, view: VIEW };
      },
    );
    const response = await POST(post({ action: "retry" }), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ view: VIEW });
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith(job);
    // The job itself never ran inside the request.
    expect(job).not.toHaveBeenCalled();
    expect(flow.retryDiscovery).toHaveBeenCalledWith({
      access: expect.objectContaining({ projectId: PROJECT }),
      schedule: expect.any(Function),
    });
  });

  it("retry answers with the row as it is when nothing was started", async () => {
    flow.retryDiscovery.mockResolvedValue({ started: false, view: VIEW });
    const response = await POST(post({ action: "retry" }), params);
    expect(response.status).toBe(200);
    expect(after).not.toHaveBeenCalled();
  });

  it("retry answers 400 when the flow finds no row", async () => {
    flow.retryDiscovery.mockResolvedValue(null);
    const response = await POST(post({ action: "retry" }), params);
    expect(response.status).toBe(400);
  });
});

describe("errors", () => {
  it("answers a generic 500 that never carries the message", async () => {
    const secret = "Invalid `prisma.command.findUnique()` invocation: table X";
    service.readView.mockRejectedValue(new Error(secret));
    service.confirmDiscovery.mockRejectedValue(new Error(secret));
    for (const response of [
      await GET(new Request(URL_), params),
      await POST(post({ action: "confirm" }), params),
    ]) {
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain("prisma");
      expect(text).not.toContain(secret);
      expect(JSON.parse(text)).toMatchObject({ code: "FAILED" });
    }
    expect(errorLog).toHaveBeenCalled();
  });

  it("does not turn an unexpected access error into a 404", async () => {
    requireProjectAccess.mockRejectedValue(new Error("db down"));
    const response = await GET(new Request(URL_), params);
    expect(response.status).toBe(500);
  });
});

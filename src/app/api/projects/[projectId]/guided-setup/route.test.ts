import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHANNELS } from "@/lib/content-channels";
import {
  AUDIT,
  IDEAS_TOPIC,
  RATE,
  REQUEST_LIMITS,
  SESSION_TOPIC,
  ideasRowId,
  parseDiscoveryCaps,
  sessionRowId,
  type IdeasRecord,
  type SessionRecord,
} from "@/lib/guided-setup/contract";
import { serializePlanBrief } from "@/lib/plan-brief";
import { makeAuditFake, type AuditFake } from "@/test-support/audit-fake";
import { makeCommandFake, type CommandFake } from "@/test-support/command-fake";

// Guards G01 (GET and start-on-existing write nothing), G37 (the route's
// checks and their order, row ids from the project, seed scoping), G47
// (draft_plan) and G66 (413 before parsing, 500 without the message, the 4th
// draft_plan in a minute). The REAL service runs on the in-memory command and
// audit fakes, so a write placed directly in route.ts is caught by the
// snapshots, not only one that goes through a service method. Quick Discovery,
// the env and the session are stubs; the shared database is never touched.

type Row = Record<string, unknown>;

type World = {
  command: CommandFake;
  audit: AuditFake;
  project: {
    name: string;
    domain: string | null;
    language: string;
    status: string;
  };
};

const world = vi.hoisted(() => ({ current: null as unknown as World }));
const env = vi.hoisted(() => ({
  enabled: true,
  chatEngine: "agent" as "agent" | "legacy",
  gates: { enabled: true, mock: false, providerOk: true },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    get command() {
      return world.current.command;
    },
    get auditLog() {
      return world.current.audit;
    },
    project: {
      findUnique: async () => ({ ...world.current.project }),
    },
    brandConstitution: { findFirst: async () => null },
    projectGoal: { findFirst: async () => null },
    reasoningCall: { findUnique: async () => null },
  },
}));

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));

// The real limiter by default (its buckets are per user and project, and every
// test signs in as a new user); a test overrides it to force a 429.
const isRateLimited = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({ isRateLimited }));
const { isRateLimited: realIsRateLimited } = await vi.importActual<
  typeof import("@/lib/rate-limit")
>("@/lib/rate-limit");

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    getEnv: () => ({ CHAT_ENGINE: env.chatEngine }),
  };
});

vi.mock("@/server/guided-setup/flag", () => ({
  isGuidedSetupEnabled: () => env.enabled,
  discoveryGates: () => env.gates,
  discoveryCaps: () => parseDiscoveryCaps(""),
}));

const qd = vi.hoisted(() => ({ claim: vi.fn(), run: vi.fn() }));
vi.mock("@/server/brand/quick-discovery", () => ({
  QuickDiscoveryService: qd,
}));
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections: vi.fn(async () => ({})),
}));
vi.mock("@/server/projects/activation", () => ({
  ensureProjectActive: vi.fn(async () => ({ status: "ACTIVE", usable: true })),
}));
vi.mock("@/server/guided-setup/goal-mode", () => ({
  resolveGoalMode: vi.fn(async () => ({
    mode: "active",
    handsOn: "AUTOPILOT",
  })),
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: vi.fn(async () => "UTC"),
  todayInTimezone: () => "2026-09-30",
}));

const after = vi.hoisted(() => vi.fn());
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after };
});

const { GET, POST } = await import("./route");
const { GuidedSetupService } = await import("@/server/guided-setup/service");
const { AgentelseError } = await import("@/server/security/errors");

const PROJECT = "proj-1";
const params = { params: Promise.resolve({ projectId: PROJECT }) };
const URL_ = `http://localhost/api/projects/${PROJECT}/guided-setup`;

const TARGET = {
  workspaceId: "ws-1",
  projectId: PROJECT,
  brandId: "brand-1",
  brandName: "Acme",
  domain: "acme.example",
  language: "en",
  country: "GB",
  guided: true,
};

let userCounter = 0;

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    v: 1,
    rev: "sessionrev01",
    editRev: "editrev00001",
    status: "OPEN",
    step: "goal",
    more: false,
    seedFirst: false,
    staticFirst: true,
    answers: {},
    seed: null,
    applyingSinceMs: null,
    applyToken: null,
    goalId: null,
    applied: null,
    lastFailure: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    updatedByUserId: "u",
    ...overrides,
  };
}

function ideasRecord(overrides: Partial<IdeasRecord> = {}): IdeasRecord {
  return {
    v: 1,
    rev: "ideasrev0001",
    status: "RUNNING",
    source: "discovery",
    runId: "oldrun01",
    attempts: 1,
    startedAtMs: Date.now() - 10_000,
    options: { business: [], audience: [], angle: [] },
    stats: { kept: 0, dropped: 0 },
    updatedAtMs: Date.now() - 10_000,
    ...overrides,
  };
}

const commandRow = (
  id: string,
  topic: string | null,
  parsedIntent: unknown,
  extra: Row = {},
): Row => ({
  id,
  workspaceId: "ws-1",
  projectId: PROJECT,
  topic,
  source: "SYSTEM",
  rawText: topic ?? "",
  parsedIntent,
  ...extra,
});

const sessionRow = (record: SessionRecord) =>
  commandRow(sessionRowId(PROJECT), SESSION_TOPIC, { guidedSetup: record });
const ideasRow = (record: IdeasRecord) =>
  commandRow(ideasRowId(PROJECT), IDEAS_TOPIC, { guidedIdeas: record });

const APPLIED: NonNullable<SessionRecord["applied"]> = {
  atMs: 5_000,
  editRev: "editrev00001",
  parts: ["goal", "channels"],
  goalMode: "active",
  receiptId: "gsa_x",
};

function build(seed: Row[] = []) {
  world.current = {
    command: makeCommandFake({ seed }),
    audit: makeAuditFake({ now: () => new Date(Date.UTC(2026, 8, 30, 12)) }),
    project: {
      name: "Acme",
      domain: "acme.example",
      language: "en",
      status: "ACTIVE",
    },
  };
  return world.current;
}

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  userCounter += 1;
  env.enabled = true;
  env.chatEngine = "agent";
  env.gates = { enabled: true, mock: false, providerOk: true };
  requireUser.mockResolvedValue({ userId: `user-${userCounter}`, email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: PROJECT,
    defaultBrandId: "brand-1",
  });
  qd.claim.mockResolvedValue(TARGET);
  qd.run.mockResolvedValue({
    status: "DONE",
    version: 2,
    pages: 3,
    reasoningCallId: "rc1",
  });
  isRateLimited.mockImplementation(realIsRateLimited);
  build();
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("route checks: session, access, flag, rate (G37)", () => {
  it("answers 401 SESSION without a session, before anything else", async () => {
    requireUser.mockRejectedValue(
      new AgentelseError("LOGIN_REQUIRED", "Authentication required"),
    );
    for (const response of [
      await GET(new Request(URL_), params),
      await POST(post({ action: "start" }), params),
    ]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "SESSION" });
    }
    expect(requireProjectAccess).not.toHaveBeenCalled();
  });

  it("answers 404 NOT_FOUND for a project the user cannot reach", async () => {
    requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    for (const response of [
      await GET(new Request(URL_), params),
      await POST(post({ action: "start" }), params),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(world.current.command.snapshot()).toEqual([]);
  });

  it("answers 404 DISABLED when the flag is off, after the access check and before the rate limit", async () => {
    env.enabled = false;
    const start = vi.spyOn(GuidedSetupService, "start");
    for (const response of [
      await GET(new Request(URL_), params),
      await POST(post({ action: "start" }), params),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "DISABLED" });
    }
    expect(requireProjectAccess).toHaveBeenCalled();
    expect(isRateLimited).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(world.current.command.snapshot()).toEqual([]);

    // A foreign project with the flag off is still the plain 404.
    requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    const foreign = await GET(new Request(URL_), params);
    expect(await foreign.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers 429 RATE from the per user and project key", async () => {
    isRateLimited.mockReturnValue(true);
    const poll = vi.spyOn(GuidedSetupService, "poll");
    const start = vi.spyOn(GuidedSetupService, "start");
    for (const response of [
      await GET(new Request(URL_), params),
      await POST(post({ action: "start" }), params),
    ]) {
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ code: "RATE" });
    }
    expect(isRateLimited).toHaveBeenCalledWith(
      `guided-setup:user-${userCounter}:${PROJECT}`,
      RATE.routePerMinute,
      60_000,
    );
    expect(poll).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("every JSON answer carries Cache-Control: no-store", async () => {
    build([sessionRow(sessionRecord())]);
    const answers = [
      await GET(new Request(URL_), params),
      await POST(post({ action: "start" }), params),
      await POST(post({ action: "nope" }), params),
      await POST(post("{}", { "content-type": "text/plain" }), params),
      await POST(post("x".repeat(20_000)), params),
    ];
    requireUser.mockRejectedValue(new Error("no"));
    answers.push(await GET(new Request(URL_), params));
    env.enabled = false;
    requireUser.mockResolvedValue({ userId: "u-x", email: null });
    answers.push(await GET(new Request(URL_), params));
    env.enabled = true;
    isRateLimited.mockReturnValue(true);
    answers.push(await GET(new Request(URL_), params));
    expect(answers.map((r) => r.status)).toEqual([
      200, 200, 400, 415, 413, 401, 404, 429,
    ]);
    for (const response of answers) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("GET poll (G01)", () => {
  it("returns the poll and changes nothing: no row, no audit, no Quick Discovery", async () => {
    const { command, audit } = build([
      sessionRow(sessionRecord()),
      ideasRow(ideasRecord()),
    ]);
    const commandBefore = command.snapshot();
    const auditBefore = audit.snapshot();
    const discover = vi.spyOn(GuidedSetupService, "discover");
    const start = vi.spyOn(GuidedSetupService, "start");
    const save = vi.spyOn(GuidedSetupService, "save");

    for (let i = 0; i < 3; i += 1) {
      const response = await GET(new Request(URL_), params);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ rev: "editrev00001", status: "OPEN" });
      expect(body.ideas.status).toBe("RUNNING");
    }

    expect(command.snapshot()).toEqual(commandBefore);
    expect(audit.snapshot()).toEqual(auditBefore);
    expect(qd.claim).not.toHaveBeenCalled();
    expect(qd.run).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("answers 404 NOT_FOUND when no session exists, still writing nothing", async () => {
    const { command, audit } = build();
    const response = await GET(new Request(URL_), params);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(command.snapshot()).toEqual([]);
    expect(audit.snapshot()).toEqual([]);
  });
});

describe("POST body checks (G37, G66)", () => {
  it("answers 415 unless the content type is application/json", async () => {
    const start = vi.spyOn(GuidedSetupService, "start");
    for (const headers of [
      { "content-type": "text/plain" },
      { "content-type": "application/x-www-form-urlencoded" },
      { "content-type": "application/jsonp" },
      { "content-type": "" },
    ]) {
      const response = await POST(
        new Request(URL_, {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "start" }),
        }),
        params,
      );
      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({ code: "INVALID" });
    }
    expect(start).not.toHaveBeenCalled();

    const ok = await POST(
      post(
        { action: "start" },
        { "content-type": "Application/JSON; charset=utf-8" },
      ),
      params,
    );
    expect(ok.status).toBe(200);
  });

  it("refuses a 20 KB body with 413 before it is parsed", async () => {
    const start = vi.spyOn(GuidedSetupService, "start");
    const parse = vi.spyOn(JSON, "parse");
    // Not JSON at all: parsing first would answer 400, not 413.
    const garbage = await POST(post("x".repeat(20_000)), params);
    expect(garbage.status).toBe(413);
    expect(await garbage.json()).toMatchObject({ code: "INVALID" });

    // Valid JSON, just too long.
    const padded = await POST(
      post({ action: "start", seedCommandId: "c".repeat(20_000) }),
      params,
    );
    expect(padded.status).toBe(413);
    expect(start).not.toHaveBeenCalled();
    // Nothing the client sent was handed to JSON.parse (the spy also sees
    // the answers' own serialization, so look at the arguments).
    const parsed = parse.mock.calls.map(([text]) => String(text));
    expect(parsed.some((text) => text.includes("xxxx"))).toBe(false);
    expect(parsed.some((text) => text.includes("cccc"))).toBe(false);
  });

  it("measures bytes, not characters", async () => {
    // 6,000 three-byte characters are 18,000 bytes but only 6,000 characters.
    const response = await POST(post(`"${"€".repeat(6_000)}"`), params);
    expect(response.status).toBe(413);
  });

  it("accepts a body at the limit and refuses one byte over", async () => {
    const pad = (size: number) => {
      const head = '{"action":"start","seedCommandId":"';
      const tail = '"}';
      return head + "a".repeat(size - head.length - tail.length) + tail;
    };
    const atLimit = await POST(post(pad(REQUEST_LIMITS.maxBodyBytes)), params);
    // Past the size check: the long id fails zod (max 64), which is a 400.
    expect(atLimit.status).toBe(400);
    const over = await POST(post(pad(REQUEST_LIMITS.maxBodyBytes + 1)), params);
    expect(over.status).toBe(413);
  });

  it("stops reading a streamed body without Content-Length once it passes the cap", async () => {
    const chunk = new TextEncoder().encode("a".repeat(4_096));
    const chunksAvailable = 2_000; // about 8 MB if it were all read
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > chunksAvailable) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    const start = vi.spyOn(GuidedSetupService, "start");
    const response = await POST(request, params);
    expect(response.status).toBe(413);
    expect(start).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
    // Far fewer than the 2,000 chunks the sender had ready.
    expect(pulls).toBeLessThan(50);
  });

  it("refuses a declared length over the limit without reading the body", async () => {
    const request = post({ action: "start" }, { "content-length": "99999" });
    const text = vi.spyOn(request, "text");
    const response = await POST(request, params);
    expect(response.status).toBe(413);
    expect(text).not.toHaveBeenCalled();
  });

  it("answers 400 INVALID for broken JSON and for a failing schema", async () => {
    const start = vi.spyOn(GuidedSetupService, "start");
    for (const body of [
      "{not json",
      "null",
      "[]",
      JSON.stringify({}),
      JSON.stringify({ action: "explode" }),
      // strict objects: an unknown key is an error
      JSON.stringify({ action: "start", extra: 1 }),
      JSON.stringify({ action: "discover", seedCommandId: "c1" }),
      JSON.stringify({
        action: "save",
        step: "nope",
        more: false,
        answers: {},
      }),
      JSON.stringify({
        action: "save",
        step: "goal",
        more: false,
        answers: { goal: { picked: [], text: "x" } },
      }),
    ]) {
      const response = await POST(post(body), params);
      expect(response.status, body).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID" });
    }
    expect(start).not.toHaveBeenCalled();
    expect(world.current.command.snapshot()).toEqual([]);
  });
});

describe("start and save", () => {
  it("start returns the view and creates the session row under the derived id", async () => {
    const { command } = build();
    const response = await POST(post({ action: "start" }), params);
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view).toMatchObject({
      status: "OPEN",
      brand: { name: "Acme", host: "acme.example" },
      projectActive: true,
    });
    expect(typeof view.rev).toBe("string");
    const rows = command.snapshot();
    expect(rows.map((row) => row.id)).toContain(sessionRowId(PROJECT));
    expect(qd.claim).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("start on an existing session writes nothing", async () => {
    const { command, audit } = build([sessionRow(sessionRecord())]);
    const commandBefore = command.snapshot();
    const auditBefore = audit.snapshot();
    const response = await POST(post({ action: "start" }), params);
    expect(response.status).toBe(200);
    expect((await response.json()).rev).toBe("editrev00001");
    expect(command.snapshot()).toEqual(commandBefore);
    expect(audit.snapshot()).toEqual(auditBefore);
    expect(qd.claim).not.toHaveBeenCalled();
  });

  it("row ids come from the project of the route, never from the body", async () => {
    build();
    await POST(
      post({ action: "start", seedCommandId: sessionRowId("other") }),
      params,
    );
    const ids = world.current.command.snapshot().map((row) => row.id);
    expect(ids).toEqual([sessionRowId(PROJECT)]);
  });

  it("hands seedCommandId to the service, which scopes it to this project", async () => {
    const start = vi.spyOn(GuidedSetupService, "start");
    build([
      commandRow("cmd-own", null, null, {
        source: "WEB",
        rawText: "Skopje sushi delivery",
      }),
      commandRow("cmd-foreign", null, null, {
        projectId: "other-project",
        source: "WEB",
        rawText: "Somebody else's words",
      }),
    ]);

    const own = await POST(
      post({ action: "start", seedCommandId: "cmd-own" }),
      params,
    );
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({ seedCommandId: "cmd-own" }),
    );
    expect((await own.json()).seed).toContain("sushi");

    build([
      commandRow("cmd-foreign", null, null, {
        projectId: "other-project",
        source: "WEB",
        rawText: "Somebody else's words",
      }),
    ]);
    const foreign = await POST(
      post({ action: "start", seedCommandId: "cmd-foreign" }),
      params,
    );
    const view = await foreign.json();
    expect(view.seed).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("Somebody else");
  });

  it("the service gets the caller's access from the project check", async () => {
    const start = vi.spyOn(GuidedSetupService, "start");
    await POST(post({ action: "start" }), params);
    expect(start).toHaveBeenCalledWith({
      access: {
        userId: `user-${userCounter}`,
        workspaceId: "ws-1",
        projectId: PROJECT,
        defaultBrandId: "brand-1",
      },
    });
  });

  it("save returns the new rev, status and ideas view", async () => {
    build([sessionRow(sessionRecord())]);
    const response = await POST(
      post({
        action: "save",
        step: "channels",
        more: false,
        answers: { goal: { picked: ["goal.leads"] } },
      }),
      params,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("OPEN");
    expect(body.rev).not.toBe("editrev00001");
    expect(body.ideas).toBeDefined();
  });

  it("save answers 409 BUSY while the session is applying and 400 when there is none", async () => {
    build([
      sessionRow(
        sessionRecord({
          status: "APPLYING",
          applyingSinceMs: Date.now(),
          applyToken: "tok-000001",
        }),
      ),
    ]);
    const busy = await POST(
      post({ action: "save", step: "goal", more: false, answers: {} }),
      params,
    );
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "BUSY" });

    build();
    const none = await POST(
      post({ action: "save", step: "goal", more: false, answers: {} }),
      params,
    );
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ code: "INVALID" });
  });
});

describe("discover", () => {
  it("schedules the run with after() exactly once, and a second tap schedules nothing", async () => {
    build([sessionRow(sessionRecord())]);
    const first = await POST(post({ action: "discover" }), params);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: "STARTED" });
    expect(after).toHaveBeenCalledTimes(1);
    expect(typeof after.mock.calls[0]?.[0]).toBe("function");
    expect(qd.claim).toHaveBeenCalledTimes(1);

    const second = await POST(post({ action: "discover" }), params);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ outcome: "ALREADY_RUNNING" });
    expect(after).toHaveBeenCalledTimes(1);
    expect(qd.claim).toHaveBeenCalledTimes(1);
    // Nothing ran inline: the job is only scheduled.
    expect(qd.run).not.toHaveBeenCalled();
  });

  it("the scheduled job is the one handed to after()", async () => {
    build([sessionRow(sessionRecord())]);
    await POST(post({ action: "discover" }), params);
    const job = after.mock.calls[0]?.[0] as () => Promise<void>;
    await job();
    expect(qd.run).toHaveBeenCalledTimes(1);
  });

  it("answers UNAVAILABLE without scheduling when the gates are closed", async () => {
    env.gates = { enabled: false, mock: false, providerOk: true };
    build([sessionRow(sessionRecord())]);
    const response = await POST(post({ action: "discover" }), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "UNAVAILABLE" });
    expect(after).not.toHaveBeenCalled();
    expect(qd.claim).not.toHaveBeenCalled();
    expect(world.current.audit.snapshot()).toEqual([]);
  });

  it("answers 400 INVALID when start has not run", async () => {
    const response = await POST(post({ action: "discover" }), params);
    expect(response.status).toBe(400);
    expect(after).not.toHaveBeenCalled();
  });

  it("has its own rate limit per user and project", async () => {
    build([sessionRow(sessionRecord())]);
    const discover = vi.spyOn(GuidedSetupService, "discover");
    const statuses: number[] = [];
    for (let i = 0; i < RATE.discoverPerMinute + 1; i += 1) {
      statuses.push((await POST(post({ action: "discover" }), params)).status);
    }
    expect(statuses.slice(0, RATE.discoverPerMinute)).toEqual(
      Array(RATE.discoverPerMinute).fill(200),
    );
    expect(statuses.at(-1)).toBe(429);
    expect(discover).toHaveBeenCalledTimes(RATE.discoverPerMinute);
    expect(isRateLimited).toHaveBeenCalledWith(
      `guided-discover:user-${userCounter}:${PROJECT}`,
      RATE.discoverPerMinute,
      60_000,
    );
  });

  it("answers a generic 500 FAILED when the service reports a failure", async () => {
    vi.spyOn(GuidedSetupService, "discover").mockResolvedValue({
      kind: "FAILED",
    });
    const response = await POST(post({ action: "discover" }), params);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Something went wrong",
      code: "FAILED",
    });
  });
});

describe("a throw becomes a generic 500 (G66)", () => {
  const SECRET =
    'Invalid `prisma.command.update()` invocation: column "parsedIntent" of table "Command"';

  it.each([
    [
      "GET",
      () => vi.spyOn(GuidedSetupService, "poll"),
      () => GET(new Request(URL_), params),
    ],
    [
      "start",
      () => vi.spyOn(GuidedSetupService, "start"),
      () => POST(post({ action: "start" }), params),
    ],
    [
      "save",
      () => vi.spyOn(GuidedSetupService, "save"),
      () =>
        POST(
          post({ action: "save", step: "goal", more: false, answers: {} }),
          params,
        ),
    ],
    [
      "discover",
      () => vi.spyOn(GuidedSetupService, "discover"),
      () => POST(post({ action: "discover" }), params),
    ],
  ])("%s", async (_name, spy, call) => {
    spy().mockRejectedValue(new Error(SECRET));
    const response = await call();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: "Something went wrong",
      code: "FAILED",
    });
    expect(text).not.toContain("prisma");
    expect(text).not.toContain("parsedIntent");
    expect(text).not.toContain("Command");
    // The message goes to the server log only.
    expect(errorLog).toHaveBeenCalledWith(
      "[guided-setup] route failed:",
      SECRET,
    );
  });

  it("covers an unexpected throw of the access check itself", async () => {
    requireProjectAccess.mockRejectedValue(new Error(SECRET));
    const response = await GET(new Request(URL_), params);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("prisma");
  });

  it("covers a throw that is not an Error", async () => {
    vi.spyOn(GuidedSetupService, "poll").mockRejectedValue("table Command");
    const response = await GET(new Request(URL_), params);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("Command");
  });
});

describe("draft_plan (G47, G66)", () => {
  const appliedSession = (answers: SessionRecord["answers"]) =>
    sessionRow(
      sessionRecord({ status: "DONE", answers, applied: { ...APPLIED } }),
    );
  const draft = () => POST(post({ action: "draft_plan" }), params);
  const firstPlanRows = () =>
    world.current.audit
      .snapshot()
      .filter((row) => row.action === AUDIT.firstPlanRequested);

  it("is refused on the legacy engine, reading and writing nothing", async () => {
    env.chatEngine = "legacy";
    const { command, audit } = build([
      appliedSession({
        goal: { picked: ["goal.leads"] },
        channels: { picked: ["channel.instagram"] },
      }),
    ]);
    const findUnique = vi.spyOn(command, "findUnique");
    const auditBefore = audit.snapshot();
    const response = await draft();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "LEGACY_ENGINE",
    });
    expect(findUnique).not.toHaveBeenCalled();
    expect(audit.snapshot()).toEqual(auditBefore);
  });

  it("needs an applied session (NOT_APPLIED)", async () => {
    for (const seed of [
      [] as Row[],
      [
        sessionRow(
          sessionRecord({
            answers: {
              goal: { picked: ["goal.leads"] },
              channels: { picked: ["channel.instagram"] },
            },
          }),
        ),
      ],
    ]) {
      build(seed);
      const response = await draft();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: false,
        code: "NOT_APPLIED",
      });
      expect(firstPlanRows()).toEqual([]);
    }
  });

  it("answers NO_PLAN without a goal, without a channel or with only Ads", async () => {
    for (const answers of [
      { channels: { picked: ["channel.instagram"] } },
      { goal: { picked: ["goal.leads"] } },
      {
        goal: { picked: ["goal.leads"] },
        channels: { picked: ["channel.ads"] },
      },
      {
        goal: { picked: [], skipped: true as const },
        channels: { picked: ["channel.instagram"] },
      },
    ]) {
      // A fresh user per case: four drafts a minute would hit the limit.
      userCounter += 1;
      requireUser.mockResolvedValue({
        userId: `user-${userCounter}`,
        email: null,
      });
      build([appliedSession(answers)]);
      const response = await draft();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: false,
        code: "NO_PLAN",
      });
      expect(firstPlanRows()).toEqual([]);
    }
  });

  it("returns the serialized brief and writes one audit row with counts only", async () => {
    build([
      appliedSession({
        goal: { picked: ["goal.leads"] },
        channels: { picked: ["channel.instagram", "channel.ads"] },
      }),
    ]);
    const before = world.current.command.snapshot();
    const response = await draft();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);

    const expected = serializePlanBrief({
      goal: "leads",
      channels: [
        {
          channel: "instagram",
          formats: [CHANNELS.instagram.formats[0]!.key],
        },
      ],
      perWeek: 3,
      weeks: 2,
      start: "2026-10-01",
    });
    expect(body.message).toBe(expected);

    const rows = firstPlanRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: AUDIT.firstPlanRequested,
      actorId: `user-${userCounter}`,
      projectId: PROJECT,
      metadata: { channels: 1 },
    });
    expect(Object.keys(rows[0]?.metadata as object)).toEqual(["channels"]);
    // Read-only apart from the audit row.
    expect(world.current.command.snapshot()).toEqual(before);
    expect(qd.claim).not.toHaveBeenCalled();
  });

  it("starts the brief tomorrow in the project's timezone and keeps at most three channels", async () => {
    build([
      appliedSession({
        goal: { picked: ["goal.sales"] },
        channels: {
          picked: [
            "channel.instagram",
            "channel.x",
            "channel.tiktok",
            "channel.linkedin",
          ],
        },
      }),
    ]);
    const body = await (await draft()).json();
    expect(body.ok).toBe(true);
    expect(body.message).toContain("2026-10-01");
    expect(firstPlanRows()[0]?.metadata).toEqual({ channels: 3 });
  });

  it("still answers when the audit write fails", async () => {
    build([
      appliedSession({
        goal: { picked: ["goal.leads"] },
        channels: { picked: ["channel.instagram"] },
      }),
    ]);
    vi.spyOn(world.current.audit, "create").mockRejectedValue(
      new Error("db down"),
    );
    const body = await (await draft()).json();
    expect(body.ok).toBe(true);
  });

  it("the 4th call in a minute is a 429, and calls 1-3 are not", async () => {
    build([
      appliedSession({
        goal: { picked: ["goal.leads"] },
        channels: { picked: ["channel.instagram"] },
      }),
    ]);
    const statuses: number[] = [];
    for (let i = 0; i < RATE.draftPlanPerMinute + 1; i += 1) {
      statuses.push((await draft()).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(isRateLimited).toHaveBeenCalledWith(
      `guided-draft:user-${userCounter}:${PROJECT}`,
      RATE.draftPlanPerMinute,
      60_000,
    );
    // The refused call wrote nothing.
    expect(firstPlanRows()).toHaveLength(3);
  });
});

describe("static guards", () => {
  const root = join(__dirname, "..", "..", "..", "..", "..", "..");
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const featureFiles = [
    ...["src/lib/guided-setup", "src/server/guided-setup"].flatMap((dir) =>
      readdirSync(join(root, dir))
        .filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name))
        .map((name) => `${dir}/${name}`),
    ),
    "src/server/actions/guided-setup-actions.ts",
  ];

  it("route.ts is the only file of the feature that imports after()", () => {
    expect(featureFiles.length).toBeGreaterThan(10);
    for (const file of featureFiles) {
      expect(read(file), file).not.toMatch(/from\s+["']next\/server["']/);
    }
    expect(
      read("src/app/api/projects/[projectId]/guided-setup/route.ts"),
    ).toMatch(/import\s*\{[^}]*\bafter\b[^}]*\}\s*from\s*"next\/server"/);
  });

  it("the route is not a public path", () => {
    expect(read("src/lib/public-paths.ts")).not.toMatch(/guided-setup/);
  });

  it("the route file has no Server Action directive", () => {
    expect(
      read("src/app/api/projects/[projectId]/guided-setup/route.ts"),
    ).not.toMatch(/["']use server["']/);
  });
});

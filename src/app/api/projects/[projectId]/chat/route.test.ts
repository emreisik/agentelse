import { beforeEach, describe, expect, it, vi } from "vitest";

// The route's own job (everything model-related is covered by
// chat-agent.test.ts): reject unauthenticated / foreign-project / oversized /
// empty requests BEFORE any work happens, and otherwise relay the agent's
// events as well-formed SSE frames with buffering-off headers.

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const isRateLimited = vi.fn().mockReturnValue(false);
vi.mock("@/lib/rate-limit", () => ({ isRateLimited }));

const runChatAgent = vi.fn();
vi.mock("@/server/chat/chat-agent", () => ({ runChatAgent }));

const commands = vi.hoisted(() => ({
  runningTurnIds: vi.fn(),
  markInterrupted: vi.fn(),
  supersedeFrom: vi.fn(),
}));
vi.mock("@/server/repositories/command.repository", () => ({
  CommandRepository: commands,
}));
const loadAttachmentBodies = vi.hoisted(() => vi.fn());
vi.mock("@/server/chat/history-files", () => ({ loadAttachmentBodies }));

const storeChatFiles = vi
  .fn()
  .mockResolvedValue({ attachments: [], attachmentBodies: [] });
vi.mock("@/server/chat/attachments", () => ({
  validateChatFiles: (files: File[]) =>
    files.length > 4 ? "You can attach at most 4 files." : null,
  storeChatFiles,
}));

const worksEnabled = vi.hoisted(() => vi.fn().mockReturnValue(false));
vi.mock("@/server/works/flag", () => ({ isWorksEnabled: worksEnabled }));
const getWork = vi.hoisted(() => vi.fn());
vi.mock("@/server/repositories/work.repository", () => ({
  WorkRepository: { get: getWork },
}));
const applyDefaults = vi.hoisted(() => vi.fn());
vi.mock("@/server/works/channel-defaults", () => ({
  applyDefaultChannels: applyDefaults,
}));

const { POST } = await import("./route");
const { __resetChatRunsForTests } = await import("@/server/chat/run-registry");
const { AgentelseError } = await import("@/server/security/errors");
const { createSseParser } = await import("@/server/chat/sse");

const params = { params: Promise.resolve({ projectId: "proj-1" }) };

function request(fields: Record<string, string | string[] | File | File[]>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      formData.append(key, item);
    }
  }
  return new Request("http://localhost/api/projects/proj-1/chat", {
    method: "POST",
    body: formData,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetChatRunsForTests();
  commands.runningTurnIds.mockResolvedValue([]);
  commands.markInterrupted.mockResolvedValue(0);
  loadAttachmentBodies.mockResolvedValue([]);
  requireUser.mockResolvedValue({ userId: "user-1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  isRateLimited.mockReturnValue(false);
  worksEnabled.mockReturnValue(false);
  applyDefaults.mockResolvedValue(true);
});

describe("POST /api/projects/[projectId]/chat", () => {
  it("returns 401 without a session", async () => {
    requireUser.mockRejectedValue(
      new AgentelseError("LOGIN_REQUIRED", "Authentication required"),
    );
    const response = await POST(request({ text: "hi" }), params);
    expect(response.status).toBe(401);
    expect(runChatAgent).not.toHaveBeenCalled();
  });

  it("returns 404 for a project the user cannot access", async () => {
    requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    const response = await POST(request({ text: "hi" }), params);
    expect(response.status).toBe(404);
    expect(runChatAgent).not.toHaveBeenCalled();
  });

  it("returns 429 when the user is rate limited", async () => {
    isRateLimited.mockReturnValue(true);
    const response = await POST(request({ text: "hi" }), params);
    expect(response.status).toBe(429);
    expect(runChatAgent).not.toHaveBeenCalled();
  });

  it("rejects an empty message", async () => {
    const response = await POST(request({ text: "   " }), params);
    expect(response.status).toBe(400);
    expect(runChatAgent).not.toHaveBeenCalled();
  });

  it("rejects too many files before storing anything", async () => {
    const files = Array.from(
      { length: 5 },
      (_, i) => new File(["x"], `f${i}.txt`, { type: "text/plain" }),
    );
    const response = await POST(request({ text: "hi", files }), params);
    expect(response.status).toBe(400);
    expect(storeChatFiles).not.toHaveBeenCalled();
  });

  it("streams the agent's events as SSE frames", async () => {
    runChatAgent.mockImplementation(async function* () {
      yield { type: "start", commandId: "cmd-1" };
      yield { type: "text.delta", text: "Merhaba" };
      yield {
        type: "done",
        commandId: "cmd-1",
        status: "ANSWERED",
        reply: "Merhaba",
      };
    });

    const response = await POST(
      request({ text: "selam", ideaId: "idea-9" }),
      params,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("cache-control")).toContain("no-transform");

    const body = await response.text();
    const events = createSseParser()(body);
    expect(events.map((e) => e.type)).toEqual(["start", "text.delta", "done"]);
    expect(runChatAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "proj-1",
        userId: "user-1",
        message: "selam",
        ideaId: "idea-9",
      }),
    );
  });

  it("reports an agent crash as an error frame instead of dropping the stream", async () => {
    runChatAgent.mockImplementation(async function* () {
      yield { type: "start", commandId: "cmd-1" };
      throw new Error("kaboom");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(request({ text: "selam" }), params);
    const events = createSseParser()(await response.text());
    expect(events.at(-1)).toMatchObject({ type: "error", message: "kaboom" });
  });
});

describe("POST /api/projects/[projectId]/chat with Works on", () => {
  beforeEach(() => {
    worksEnabled.mockReturnValue(true);
    runChatAgent.mockImplementation(async function* () {
      yield { type: "start", commandId: "cmd-1" };
      yield { type: "done", status: "ANSWERED" };
    });
  });

  it("rejects a turn without a Work", async () => {
    const response = await POST(request({ text: "hi" }), params);
    expect(response.status).toBe(400);
    expect(runChatAgent).not.toHaveBeenCalled();
  });

  it("rejects a Work that is not this project's (or not active)", async () => {
    getWork.mockResolvedValue(null);
    const foreign = await POST(request({ text: "hi", workId: "w-x" }), params);
    expect(foreign.status).toBe(400);
    expect(getWork).toHaveBeenCalledWith("proj-1", "w-x");

    getWork.mockResolvedValue({ id: "w-1", status: "DONE", channels: [] });
    const done = await POST(request({ text: "hi", workId: "w-1" }), params);
    expect(done.status).toBe(400);
    expect(runChatAgent).not.toHaveBeenCalled();
  });

  it("passes the verified Work id to the agent", async () => {
    getWork.mockResolvedValue({ id: "w-1", status: "ACTIVE", channels: [] });
    const response = await POST(request({ text: "hi", workId: "w-1" }), params);
    await response.text();
    expect(runChatAgent).toHaveBeenCalledWith(
      expect.objectContaining({ workId: "w-1" }),
    );
  });
});

// A chat is free, but its tools default pieces to the connected channels: a
// message that finds a chat with none has the defaults stored first, before the
// message becomes a Command (the screen sends nothing about channels).
describe("POST /api/projects/[projectId]/chat: a chat's default channels", () => {
  const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
    mock.mock.invocationCallOrder[0] ?? 0;

  beforeEach(() => {
    worksEnabled.mockReturnValue(true);
    getWork.mockResolvedValue({ id: "w-1", status: "ACTIVE", channels: [] });
    runChatAgent.mockImplementation(async function* () {
      yield { type: "start", commandId: "cmd-1" };
      yield { type: "done", status: "ANSWERED" };
    });
  });

  it("stores the defaults of a chat that has no channel, before the agent runs", async () => {
    const response = await POST(request({ text: "plan my week", workId: "w-1" }), params);
    await response.text();
    expect(applyDefaults).toHaveBeenCalledTimes(1);
    expect(applyDefaults).toHaveBeenCalledWith({ projectId: "proj-1", workId: "w-1" });
    expect(order(applyDefaults)).toBeLessThan(order(runChatAgent));
  });

  it("stores nothing for a chat that already has channels", async () => {
    getWork.mockResolvedValue({ id: "w-1", status: "ACTIVE", channels: ["tiktok"] });
    const response = await POST(request({ text: "hi", workId: "w-1" }), params);
    await response.text();
    expect(applyDefaults).not.toHaveBeenCalled();
    expect(runChatAgent).toHaveBeenCalledTimes(1);
  });

  it("stores nothing for a message that is turned away", async () => {
    const empty = await POST(request({ text: "  ", workId: "w-1" }), params);
    expect(empty.status).toBe(400);
    const manyFiles = await POST(
      request({
        text: "hi",
        workId: "w-1",
        files: Array.from({ length: 5 }, (_, i) => new File(["x"], `${i}.txt`)),
      }),
      params,
    );
    expect(manyFiles.status).toBe(400);
    expect(applyDefaults).not.toHaveBeenCalled();
    expect(runChatAgent).not.toHaveBeenCalled();
  });

  it("a failed store does not stop the turn: the pieces fall back to Instagram", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    applyDefaults.mockRejectedValue(new Error("db down"));
    const response = await POST(request({ text: "hi", workId: "w-1" }), params);
    const events = createSseParser()(await response.text());
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(runChatAgent).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
  });

  it("Works off: nothing is stored", async () => {
    worksEnabled.mockReturnValue(false);
    const response = await POST(request({ text: "hi", workId: "w-1" }), params);
    await response.text();
    expect(applyDefaults).not.toHaveBeenCalled();
    expect(runChatAgent).toHaveBeenCalledWith(
      expect.objectContaining({ workId: undefined }),
    );
  });
});

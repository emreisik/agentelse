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

const storeChatFiles = vi
  .fn()
  .mockResolvedValue({ attachments: [], attachmentBodies: [] });
vi.mock("@/server/chat/attachments", () => ({
  validateChatFiles: (files: File[]) =>
    files.length > 4 ? "You can attach at most 4 files." : null,
  storeChatFiles,
}));

const { POST } = await import("./route");
const { AgentelseError } = await import("@/server/security/errors");
const { createSseParser } = await import("@/server/chat/sse");

const params = { params: Promise.resolve({ projectId: "proj-1" }) };

function request(fields: Record<string, string | File | File[]>) {
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
  requireUser.mockResolvedValue({ userId: "user-1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  isRateLimited.mockReturnValue(false);
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

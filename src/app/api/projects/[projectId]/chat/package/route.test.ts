import { beforeEach, describe, expect, it, vi } from "vitest";

// The route's own job (the run itself is covered by content-package-run.test.ts):
// reject unauthenticated / foreign-project / malformed requests BEFORE any work
// happens, and otherwise relay the run's events as well-formed SSE frames with
// buffering-off headers.

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const isRateLimited = vi.fn().mockReturnValue(false);
vi.mock("@/lib/rate-limit", () => ({ isRateLimited }));

const runContentPackage = vi.fn();
vi.mock("@/server/chat/content-package-run", () => ({ runContentPackage }));

const { POST } = await import("./route");
const { AgentelseError } = await import("@/server/security/errors");
const { createSseParser } = await import("@/server/chat/sse");

const params = { params: Promise.resolve({ projectId: "proj-1" }) };

function request(body: unknown) {
  return new Request("http://localhost/api/projects/proj-1/chat/package", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const valid = {
  commandId: "cmd-1",
  selections: [{ id: "post", contentFormat: "STORY" }, { id: "seo" }],
};

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

describe("POST /api/projects/[projectId]/chat/package", () => {
  it("returns 401 without a session", async () => {
    requireUser.mockRejectedValue(
      new AgentelseError("LOGIN_REQUIRED", "Authentication required"),
    );
    const response = await POST(request(valid), params);
    expect(response.status).toBe(401);
    expect(runContentPackage).not.toHaveBeenCalled();
  });

  it("returns 404 for a project the user cannot access", async () => {
    requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    const response = await POST(request(valid), params);
    expect(response.status).toBe(404);
    expect(runContentPackage).not.toHaveBeenCalled();
  });

  it("returns 429 when the user is rate limited", async () => {
    isRateLimited.mockReturnValue(true);
    const response = await POST(request(valid), params);
    expect(response.status).toBe(429);
    expect(runContentPackage).not.toHaveBeenCalled();
  });

  it("rejects a malformed or empty request before running anything", async () => {
    for (const body of [
      "not json",
      {},
      { commandId: "cmd-1", selections: [] },
      { commandId: "", selections: [{ id: "post" }] },
      {
        commandId: "cmd-1",
        selections: Array.from({ length: 6 }, (_, i) => ({ id: `i${i}` })),
      },
    ]) {
      const response = await POST(request(body), params);
      expect(response.status).toBe(400);
    }
    expect(runContentPackage).not.toHaveBeenCalled();
  });

  it("streams the run's events as SSE frames", async () => {
    runContentPackage.mockImplementation(async function* () {
      yield { type: "item.start", itemId: "seo", taskId: "task-1" };
      yield { type: "item.done", itemId: "seo", ok: true, reply: "Ready" };
      yield { type: "package.done", started: 1, failed: 0 };
    });

    const response = await POST(request(valid), params);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("cache-control")).toContain("no-transform");

    const events = createSseParser()(await response.text());
    expect(events.map((e) => e.type)).toEqual([
      "item.start",
      "item.done",
      "package.done",
    ]);
    expect(runContentPackage).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      userId: "user-1",
      commandId: "cmd-1",
      selections: valid.selections,
    });
  });

  it("reports a crash as an error frame instead of dropping the stream", async () => {
    runContentPackage.mockImplementation(async function* () {
      yield { type: "item.start", itemId: "seo", taskId: "task-1" };
      throw new Error("kaboom");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(request(valid), params);
    const events = createSseParser()(await response.text());
    expect(events.at(-1)).toMatchObject({ type: "error", message: "kaboom" });
  });
});

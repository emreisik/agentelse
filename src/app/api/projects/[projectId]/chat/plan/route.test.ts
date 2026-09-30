import { beforeEach, describe, expect, it, vi } from "vitest";

// The route's own job (the run itself is covered by plan-run.test.ts): reject
// unauthenticated / foreign-project / malformed requests BEFORE any work
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

const runContentPlan = vi.fn();
vi.mock("@/server/chat/plan-run", () => ({ runContentPlan }));

const { POST } = await import("./route");
const { AgentelseError } = await import("@/server/security/errors");
const { createSseParser } = await import("@/server/chat/sse");

const params = { params: Promise.resolve({ projectId: "proj-1" }) };

function request(body: unknown) {
  return new Request("http://localhost/api/projects/proj-1/chat/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const valid = { commandId: "plan-1" };

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

describe("POST /api/projects/[projectId]/chat/plan", () => {
  it("returns 401 without a session", async () => {
    requireUser.mockRejectedValue(
      new AgentelseError("LOGIN_REQUIRED", "Authentication required"),
    );
    const response = await POST(request(valid), params);
    expect(response.status).toBe(401);
    expect(runContentPlan).not.toHaveBeenCalled();
  });

  it("returns 404 for a project the user cannot access", async () => {
    requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    const response = await POST(request(valid), params);
    expect(response.status).toBe(404);
    expect(runContentPlan).not.toHaveBeenCalled();
  });

  it("returns 429 when the user is rate limited", async () => {
    isRateLimited.mockReturnValue(true);
    const response = await POST(request(valid), params);
    expect(response.status).toBe(429);
    expect(runContentPlan).not.toHaveBeenCalled();
  });

  it("rejects a malformed request before running anything", async () => {
    for (const body of ["not json", {}, { commandId: "" }, { commandId: 5 }]) {
      const response = await POST(request(body), params);
      expect(response.status).toBe(400);
    }
    expect(runContentPlan).not.toHaveBeenCalled();
  });

  it("streams the run's events as SSE frames and scopes the run to the caller", async () => {
    runContentPlan.mockImplementation(async function* () {
      yield {
        type: "run.items",
        items: [
          { id: "a", title: "T", label: "Instagram post", image: true },
        ],
      };
      yield { type: "item.start", itemId: "a", taskId: "task-1" };
      yield { type: "item.done", itemId: "a", ok: true, reply: "Ready" };
      yield { type: "package.done", started: 1, failed: 0 };
    });

    const response = await POST(request(valid), params);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("cache-control")).toContain("no-transform");

    const events = createSseParser()(await response.text());
    expect(events.map((e) => e.type)).toEqual([
      "run.items",
      "item.start",
      "item.done",
      "package.done",
    ]);
    // The workspace and brand come from the verified access, never the body.
    expect(runContentPlan).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      userId: "user-1",
      commandId: "plan-1",
    });
  });

  it("reports a crash as an error frame instead of dropping the stream", async () => {
    runContentPlan.mockImplementation(async function* () {
      yield { type: "item.start", itemId: "a", taskId: "task-1" };
      throw new Error("kaboom");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(request(valid), params);
    const events = createSseParser()(await response.text());
    expect(events.at(-1)).toMatchObject({ type: "error", message: "kaboom" });
  });
});

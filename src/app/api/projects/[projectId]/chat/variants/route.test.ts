import { beforeEach, describe, expect, it, vi } from "vitest";

// The retired "Make 3 visuals" / "Make 3 more" route: a post has one picture,
// so it answers 410 and never reads, reserves or makes anything (no database,
// budget or task module is even imported by it).

const requireUser = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({ requireUser }));

const { POST } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ userId: "user-1" });
});

describe("the retired variants route", () => {
  it("answers 410 with the reason to a signed-in caller", async () => {
    const res = await POST();
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: "This option was retired: a post has one picture.",
    });
  });

  it("401 without a user", async () => {
    requireUser.mockRejectedValue(new Error("no session"));
    const res = await POST();
    expect(res.status).toBe(401);
  });
});

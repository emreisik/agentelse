import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// With the LLM Council wound down, a new idea is shortlisted directly so the
// Ideas panel's approve action and the weekly planner (which only draws from
// SHORTLISTED ideas) keep having something to work with.

const promoteToShortlist = vi.fn();
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: { promoteToShortlist },
}));

const { shortlistIfCouncilOff } = await import("./council-lite");

beforeEach(() => {
  vi.clearAllMocks();
  promoteToShortlist.mockResolvedValue("SHORTLISTED");
  delete process.env.LEGACY_AGENCY_LOOP;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shortlistIfCouncilOff", () => {
  it("does nothing while the legacy loop is fully on: the Council will pick the idea up", async () => {
    await expect(shortlistIfCouncilOff("idea-1", "proj-1")).resolves.toBe(false);
    expect(promoteToShortlist).not.toHaveBeenCalled();
  });

  it.each(["drain", "off"])("shortlists the idea in %s mode", async (mode) => {
    vi.stubEnv("LEGACY_AGENCY_LOOP", mode);

    await expect(shortlistIfCouncilOff("idea-1", "proj-1")).resolves.toBe(true);
    expect(promoteToShortlist).toHaveBeenCalledWith("idea-1", "proj-1");
  });

  it("never fails idea creation over a failed promotion", async () => {
    vi.stubEnv("LEGACY_AGENCY_LOOP", "off");
    promoteToShortlist.mockRejectedValue(new Error("db blip"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(shortlistIfCouncilOff("idea-1", "proj-1")).resolves.toBe(false);
  });
});

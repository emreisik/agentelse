import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({ requireUser }));

const getOpenAiCredit = vi.fn();
vi.mock("@/server/billing/openai-credit", () => ({ getOpenAiCredit }));

const { GET } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ userId: "u1" });
});

describe("GET /api/openai-credit", () => {
  it("rejects a signed-out caller without touching the balance", async () => {
    requireUser.mockRejectedValue(new Error("no session"));

    const res = await GET();

    expect(res.status).toBe(401);
    expect(getOpenAiCredit).not.toHaveBeenCalled();
  });

  it("returns the current balance, uncached, for the header poll", async () => {
    const credit = {
      balance: 9.12,
      spent: 0.76,
      snapshot: 9.88,
      asOf: "2026-09-29T16:17:00.000Z",
    };
    getOpenAiCredit.mockResolvedValue(credit);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ credit });
  });

  it("answers null (not an error) when no balance snapshot is configured", async () => {
    getOpenAiCredit.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ credit: null });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorksEnabled: vi.fn(),
  isRateLimited: vi.fn(),
  get: vi.fn(),
  loadSuggestedSlots: vi.fn(),
  getProjectTimezone: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/works/flag", () => ({ isWorksEnabled: mocks.isWorksEnabled }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/server/repositories/work.repository", () => ({
  WorkRepository: { get: mocks.get },
}));
vi.mock("@/server/works/free-slot-loader", () => ({
  loadSuggestedSlots: mocks.loadSuggestedSlots,
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: mocks.getProjectTimezone,
}));

import { suggestSlotsAction } from "@/server/actions/slot-suggest-actions";

const ALL = ["instagram", "linkedin", "x", "tiktok", "seo", "ads"];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isWorksEnabled.mockReturnValue(true);
  mocks.isRateLimited.mockReturnValue(false);
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "w1",
    defaultBrandId: "b1",
  });
  mocks.get.mockResolvedValue({ id: "wk1", channels: ALL });
  mocks.getProjectTimezone.mockResolvedValue("Europe/Istanbul");
  mocks.loadSuggestedSlots.mockResolvedValue({
    timezone: "Europe/Istanbul",
    slots: [{ date: "2026-10-05", time: "10:00" }],
  });
});

describe("suggestSlotsAction", () => {
  it("is disabled when Works is off", async () => {
    mocks.isWorksEnabled.mockReturnValue(false);
    const r = await suggestSlotsAction("p1", "wk1", { channels: ["instagram"] });
    expect(r).toMatchObject({ ok: false, code: "DISABLED" });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("looks the Work up with the project id; a foreign Work is NOT_FOUND", async () => {
    mocks.get.mockResolvedValue(null);
    const r = await suggestSlotsAction("p1", "other", { channels: ["instagram"] });
    expect(mocks.get).toHaveBeenCalledWith("p1", "other");
    expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mocks.loadSuggestedSlots).not.toHaveBeenCalled();
  });

  it("caps channels at 6 so a fourth still gets suggestions", async () => {
    // The Work really has a 7th channel, so only the slice can drop it.
    mocks.get.mockResolvedValue({ id: "wk1", channels: [...ALL, "extra"] });
    const r = await suggestSlotsAction("p1", "wk1", {
      channels: [...ALL, "extra"],
    });
    expect(r.ok && Object.keys(r.byChannel)).toEqual(ALL);
    expect(r.ok && "extra" in r.byChannel).toBe(false);
    expect(mocks.loadSuggestedSlots).toHaveBeenCalledTimes(6);
    expect(r.ok && r.byChannel.tiktok).toHaveLength(1);
  });

  it("returns the project timezone, also with no channel", async () => {
    const r = await suggestSlotsAction("p1", "wk1", { channels: [] });
    expect(r).toMatchObject({ ok: true, timezone: "Europe/Istanbul", byChannel: {} });
  });

  it("is rate limited on its own bucket, not the one the slot edits use", async () => {
    mocks.isRateLimited.mockReturnValue(true);
    const r = await suggestSlotsAction("p1", "wk1", { channels: ["instagram"] });
    expect(r).toMatchObject({ ok: false, code: "RATE" });
    expect(mocks.isRateLimited.mock.calls[0]![0]).toBe("slots-suggest:u1");
    expect(mocks.isRateLimited.mock.calls[0]![1]).toBe(60);
  });

  it("passes a valid startFrom only", async () => {
    await suggestSlotsAction("p1", "wk1", { channels: ["x"], startFrom: "nope" });
    expect(mocks.loadSuggestedSlots.mock.calls[0]![1].startFrom).toBeUndefined();
    await suggestSlotsAction("p1", "wk1", { channels: ["x"], startFrom: "2026-10-09" });
    expect(mocks.loadSuggestedSlots.mock.calls[1]![1].startFrom).toBe("2026-10-09");
  });
});

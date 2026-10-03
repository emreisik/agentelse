import { beforeEach, describe, expect, it, vi } from "vitest";

const getConnections = vi.hoisted(() => vi.fn());
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections: getConnections,
}));
const setInitial = vi.hoisted(() => vi.fn());
vi.mock("@/server/repositories/work.repository", () => ({
  WorkRepository: { setInitialChannels: setInitial },
}));

const { applyDefaultChannels, unconnectedOf } =
  await import("./channel-defaults");

beforeEach(() => {
  vi.clearAllMocks();
  getConnections.mockResolvedValue({
    instagram: { connected: true },
    linkedin: { connected: false },
  });
  setInitial.mockResolvedValue(true);
});

describe("unconnectedOf", () => {
  it("lists the chosen channels that need an account and have none connected", async () => {
    expect(await unconnectedOf("p1", ["instagram", "linkedin", "tiktok"])).toEqual(
      ["linkedin", "tiktok"],
    );
  });

  it("a failing connection read counts every account as not connected", async () => {
    getConnections.mockRejectedValue(new Error("down"));
    expect(await unconnectedOf("p1", ["instagram"])).toEqual(["instagram"]);
  });
});

describe("applyDefaultChannels", () => {
  it("stores the connected publishing channels as the chat's defaults", async () => {
    getConnections.mockResolvedValue({
      instagram: { connected: true },
      linkedin: { connected: true },
    });
    expect(await applyDefaultChannels({ projectId: "p1", workId: "w1" })).toBe(
      true,
    );
    expect(setInitial).toHaveBeenCalledWith(
      "p1",
      "w1",
      ["instagram", "linkedin"],
      [],
    );
  });

  it("with nothing connected the default is Instagram, marked as not connected yet", async () => {
    getConnections.mockResolvedValue({});
    await applyDefaultChannels({ projectId: "p1", workId: "w1" });
    expect(setInitial).toHaveBeenCalledWith("p1", "w1", ["instagram"], ["instagram"]);
  });

  it("a failing connection read still stores Instagram", async () => {
    getConnections.mockRejectedValue(new Error("down"));
    await applyDefaultChannels({ projectId: "p1", workId: "w1" });
    expect(setInitial).toHaveBeenCalledWith("p1", "w1", ["instagram"], ["instagram"]);
  });

  it("answers what the repository answers: false when the chat already has channels", async () => {
    setInitial.mockResolvedValue(false);
    expect(await applyDefaultChannels({ projectId: "p1", workId: "w1" })).toBe(
      false,
    );
  });
});

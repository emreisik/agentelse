import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelConnections } from "@/lib/content-channels";
import { HANDS_ON_MODES, type HandsOn } from "@/lib/guided-setup/contract";

// Guard G59 (resolver half): a saved goal may start autonomous work only when
// the legacy loop is on AND the project runs on autopilot AND a channel is
// connected; then it is saved as a proposal. Any unknown state is a proposal.

const mocks = vi.hoisted(() => ({
  getForProject: vi.fn(),
  getChannelConnections: vi.fn(),
}));

vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: { getForProject: mocks.getForProject },
}));
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections: mocks.getChannelConnections,
}));

const { resolveGoalMode } = await import("./goal-mode");

const CONNECTED: ChannelConnections = {
  instagram: { connected: true, accountLabel: "@brand" },
  tiktok: { connected: false },
};
const NOT_CONNECTED: ChannelConnections = {
  instagram: { connected: false },
  ads: { connected: false },
};

const previousLoop = process.env.LEGACY_AGENCY_LOOP;

function setLoop(value: "on" | "drain" | "off" | undefined) {
  if (value === undefined) delete process.env.LEGACY_AGENCY_LOOP;
  else process.env.LEGACY_AGENCY_LOOP = value;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousLoop === undefined) delete process.env.LEGACY_AGENCY_LOOP;
  else process.env.LEGACY_AGENCY_LOOP = previousLoop;
});

describe("truth table", () => {
  const loops = ["on", "drain", "off"] as const;
  const connectedStates = [true, false] as const;

  for (const loop of loops) {
    for (const mode of HANDS_ON_MODES) {
      for (const connected of connectedStates) {
        // Only the risky combination is proposed.
        const expected =
          loop === "on" && mode === "AUTOPILOT" && connected
            ? "proposed"
            : "active";
        it(`loop ${loop} / ${mode} / ${connected ? "connected" : "not connected"} -> ${expected}`, async () => {
          setLoop(loop);
          mocks.getForProject.mockResolvedValue({ autopilotMode: mode });
          mocks.getChannelConnections.mockResolvedValue(
            connected ? CONNECTED : NOT_CONNECTED,
          );
          const result = await resolveGoalMode("p1");
          expect(result.mode).toBe(expected);
          expect(result.handsOn).toBe(mode);
        });
      }
    }
  }

  it("an unset LEGACY_AGENCY_LOOP counts as on (the default of legacyAgencyLoopMode)", async () => {
    setLoop(undefined);
    mocks.getForProject.mockResolvedValue({ autopilotMode: "AUTOPILOT" });
    mocks.getChannelConnections.mockResolvedValue(CONNECTED);
    expect((await resolveGoalMode("p1")).mode).toBe("proposed");
  });

  it("any single connected channel is enough", async () => {
    setLoop("on");
    mocks.getForProject.mockResolvedValue({ autopilotMode: "AUTOPILOT" });
    mocks.getChannelConnections.mockResolvedValue({
      instagram: { connected: false },
      ads: { connected: true },
    });
    expect((await resolveGoalMode("p1")).mode).toBe("proposed");
  });

  it("no channel entries at all is not connected", async () => {
    setLoop("on");
    mocks.getForProject.mockResolvedValue({ autopilotMode: "AUTOPILOT" });
    mocks.getChannelConnections.mockResolvedValue({});
    expect((await resolveGoalMode("p1")).mode).toBe("active");
  });
});

describe("a missing policy row", () => {
  it("counts as AUTOPILOT (the schema default), so a connected project is proposed", async () => {
    setLoop("on");
    mocks.getForProject.mockResolvedValue(null);
    mocks.getChannelConnections.mockResolvedValue(CONNECTED);
    expect(await resolveGoalMode("p1")).toEqual({
      mode: "proposed",
      handsOn: "AUTOPILOT",
    });
  });

  it("stays active while nothing is connected", async () => {
    setLoop("on");
    mocks.getForProject.mockResolvedValue(null);
    mocks.getChannelConnections.mockResolvedValue(NOT_CONNECTED);
    expect(await resolveGoalMode("p1")).toEqual({
      mode: "active",
      handsOn: "AUTOPILOT",
    });
  });
});

describe("fail safe", () => {
  it("a throwing policy read yields proposed with an unknown hands-on level", async () => {
    setLoop("off");
    mocks.getForProject.mockRejectedValue(new Error("db down"));
    mocks.getChannelConnections.mockResolvedValue(NOT_CONNECTED);
    expect(await resolveGoalMode("p1")).toEqual({
      mode: "proposed",
      handsOn: null,
    });
  });

  it("a throwing connections read yields proposed", async () => {
    setLoop("off");
    mocks.getForProject.mockResolvedValue({ autopilotMode: "AUTOPILOT" });
    mocks.getChannelConnections.mockRejectedValue(new Error("meta down"));
    expect(await resolveGoalMode("p1")).toEqual({
      mode: "proposed",
      handsOn: null,
    });
  });

  it("logs the failure without throwing", async () => {
    mocks.getForProject.mockRejectedValue(new Error("boom"));
    mocks.getChannelConnections.mockResolvedValue({});
    await expect(resolveGoalMode("p1")).resolves.toBeDefined();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe("injected connections", () => {
  it("are used as given and never read again", async () => {
    setLoop("on");
    mocks.getForProject.mockResolvedValue({ autopilotMode: "AUTOPILOT" });
    const result = await resolveGoalMode("p1", { connections: CONNECTED });
    expect(result.mode).toBe("proposed");
    expect(mocks.getChannelConnections).not.toHaveBeenCalled();
  });

  it("an injected empty map means nothing is connected", async () => {
    setLoop("on");
    mocks.getForProject.mockResolvedValue({ autopilotMode: "AUTOPILOT" });
    const result = await resolveGoalMode("p1", { connections: {} });
    expect(result.mode).toBe("active");
  });
});

describe("handsOn", () => {
  it("passes the policy value through unchanged", async () => {
    setLoop("drain");
    for (const mode of HANDS_ON_MODES satisfies readonly HandsOn[]) {
      mocks.getForProject.mockResolvedValue({ autopilotMode: mode });
      mocks.getChannelConnections.mockResolvedValue(NOT_CONNECTED);
      expect((await resolveGoalMode("p1")).handsOn).toBe(mode);
    }
  });

  it("reads the policy of the given project only", async () => {
    setLoop("off");
    mocks.getForProject.mockResolvedValue(null);
    mocks.getChannelConnections.mockResolvedValue({});
    await resolveGoalMode("proj_42");
    expect(mocks.getForProject).toHaveBeenCalledWith("proj_42");
    expect(mocks.getChannelConnections).toHaveBeenCalledWith("proj_42");
  });
});

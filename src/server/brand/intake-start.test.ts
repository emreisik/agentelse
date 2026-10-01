import { beforeEach, describe, expect, it, vi } from "vitest";

// The create tap hands the discovery flow the server's own offer and ids; the
// flow's jobs go to after(). Nothing here may throw into the creation action.

const after = vi.fn();
vi.mock("next/server", () => ({ after }));

const intakeOfferFor = vi.fn();
vi.mock("@/server/brand/intake-offer", () => ({ intakeOfferFor }));

const startDiscovery = vi.fn();
vi.mock("@/server/guided-discovery/flow", () => ({ startDiscovery }));

const { startIntakeAtCreate } = await import("./intake-start");

const INPUT = {
  userId: "u1",
  workspaceId: "ws-1",
  projectId: "p-1",
  brandId: "b-1",
  domain: "acme.mk",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  intakeOfferFor.mockReturnValue({ scan: true, research: true });
  startDiscovery.mockResolvedValue({ started: true });
});

describe("startIntakeAtCreate", () => {
  it("calls the flow once with the server's offer and the caller's ids", async () => {
    await startIntakeAtCreate(INPUT);

    expect(intakeOfferFor).toHaveBeenCalledWith("ws-1");
    expect(startDiscovery).toHaveBeenCalledTimes(1);
    const arg = startDiscovery.mock.calls[0]![0] as {
      access: unknown;
      offer: unknown;
    };
    expect(arg.access).toEqual({
      userId: "u1",
      workspaceId: "ws-1",
      projectId: "p-1",
      defaultBrandId: "b-1",
    });
    expect(arg.offer).toEqual({ scan: true, research: true });
  });

  it("hands the flow's jobs to after()", async () => {
    await startIntakeAtCreate(INPUT);

    const arg = startDiscovery.mock.calls[0]![0] as {
      schedule: (job: () => Promise<void>) => void;
    };
    const job = vi.fn(async () => undefined);
    arg.schedule(job);
    expect(after).toHaveBeenCalledWith(job);
  });

  it("still starts the flow without a website when research is offered", async () => {
    intakeOfferFor.mockReturnValue({ scan: false, research: true });
    await startIntakeAtCreate({ ...INPUT, domain: undefined });
    expect(startDiscovery).toHaveBeenCalledTimes(1);
  });

  it("starts nothing when nothing is offered", async () => {
    intakeOfferFor.mockReturnValue({ scan: false, research: false });
    await startIntakeAtCreate(INPUT);
    expect(startDiscovery).not.toHaveBeenCalled();
  });

  it("never throws into the creation action, whatever fails", async () => {
    startDiscovery.mockRejectedValue(new Error("store down"));
    await expect(startIntakeAtCreate(INPUT)).resolves.toBeUndefined();

    intakeOfferFor.mockImplementation(() => {
      throw new Error("env unreadable");
    });
    await expect(startIntakeAtCreate(INPUT)).resolves.toBeUndefined();
  });
});

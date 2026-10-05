import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const findMany = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: { task: { findMany } } }));

import { taskFingerprint } from "@/server/agency/fingerprint";

import { moduleFlowTaskIds } from "./flow-tasks";

type Row = {
  id: string;
  projectId: string;
  capability: string;
  commandId: string | null;
  fingerprint: string | null;
};

const fp = (capability: string, subject: string) =>
  taskFingerprint({
    capability,
    department: "PERFORMANCE_MARKETING",
    subject,
  });

// A small Task table the mocked findMany filters like Prisma would.
function useTasks(rows: Row[]) {
  findMany.mockImplementation(
    async (args: {
      where: {
        projectId: string;
        commandId?: { in: string[] };
        fingerprint?: { in: string[] };
      };
    }) =>
      rows
        .filter((row) => row.projectId === args.where.projectId)
        .filter(
          (row) =>
            !args.where.commandId ||
            (row.commandId !== null &&
              args.where.commandId.in.includes(row.commandId)),
        )
        .filter(
          (row) =>
            !args.where.fingerprint ||
            (row.fingerprint !== null &&
              args.where.fingerprint.in.includes(row.fingerprint)),
        )
        .map(({ id, capability }) => ({ id, capability })),
  );
}

const task = (over: Partial<Row> & { id: string }): Row => ({
  projectId: "p1",
  capability: "META_CAMPAIGN_CREATE",
  commandId: null,
  fingerprint: null,
  ...over,
});

beforeEach(() => {
  findMany.mockReset();
});

describe("moduleFlowTaskIds", () => {
  it("no card: nothing is read", async () => {
    expect(await moduleFlowTaskIds("p1", [])).toEqual(new Set());
    expect(findMany).not.toHaveBeenCalled();
  });

  it("follows the launch chain: the card's campaign, then the relays' ad set and ad", async () => {
    useTasks([
      task({ id: "camp", commandId: "card" }),
      task({
        id: "set",
        capability: "META_ADSET_CREATE",
        fingerprint: fp("META_ADSET_CREATE", "camp"),
      }),
      task({
        id: "ad",
        capability: "META_AD_CREATE",
        fingerprint: fp("META_AD_CREATE", "set"),
      }),
      // Another campaign's chain, and a task of another chat's Command.
      task({
        id: "other-set",
        capability: "META_ADSET_CREATE",
        fingerprint: fp("META_ADSET_CREATE", "other-camp"),
      }),
      task({ id: "plan-task", capability: "CONTENT", commandId: "plan" }),
    ]);
    expect(await moduleFlowTaskIds("p1", ["card"])).toEqual(
      new Set(["camp", "set", "ad"]),
    );
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("a relaunch keeps every campaign of the card; a chain that has not moved on stops early", async () => {
    useTasks([
      task({ id: "camp-1", commandId: "card" }),
      task({ id: "camp-2", commandId: "card" }),
      task({
        id: "set-2",
        capability: "META_ADSET_CREATE",
        fingerprint: fp("META_ADSET_CREATE", "camp-2"),
      }),
    ]);
    expect(await moduleFlowTaskIds("p1", ["card"])).toEqual(
      new Set(["camp-1", "camp-2", "set-2"]),
    );
  });

  it("stays inside the project", async () => {
    useTasks([task({ id: "camp", projectId: "p2", commandId: "card" })]);
    expect(await moduleFlowTaskIds("p1", ["card"])).toEqual(new Set());
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { projectId: "p1", commandId: { in: ["card"] } },
    });
  });

  it("a card's task that starts no chain is still its own", async () => {
    useTasks([task({ id: "t", capability: "CONTENT", commandId: "card" })]);
    expect(await moduleFlowTaskIds("p1", ["card"])).toEqual(new Set(["t"]));
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

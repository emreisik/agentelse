import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const findMany = vi.fn();
const count = vi.fn();
const commandFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative: { findMany: (...a: unknown[]) => findMany(...a) },
    command: { findMany: (...a: unknown[]) => commandFindMany(...a) },
    projectSchedule: { count: (...a: unknown[]) => count(...a) },
  },
}));
const getConnections = vi.fn();
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections: (...a: unknown[]) => getConnections(...a),
}));
const getTz = vi.fn();
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: (...a: unknown[]) => getTz(...a),
}));

import type { CreativeCardData } from "@/types/creative-card";
import type { IdeaEventCardData } from "@/types/idea-event-card";
import {
  loadLiveCreativeRows,
  loadLiveInputs,
  withLiveConnections,
  withLiveCreativeState,
  type LiveCreativeRow,
  type LiveInputs,
} from "./live-creative-state";

const NOW = new Date("2026-10-01T10:00:00Z");
const inputs: LiveInputs = {
  projectId: "p1",
  now: NOW,
  timezone: "Europe/Istanbul",
  connections: {},
  connectedPlatforms: new Set(["instagram"]),
  scheduleEnabled: true,
};

type Ready = Extract<CreativeCardData, { kind: "creative-ready" }>;
const card: Ready = {
  kind: "creative-ready",
  creativeId: "c1",
  title: "T",
  status: "IN_REVIEW",
  assetId: "old-asset",
  versionNumber: 1,
  approveIntent: "publish",
};
const row = (over: Partial<LiveCreativeRow> = {}): LiveCreativeRow => ({
  id: "c1",
  status: "IN_REVIEW",
  platform: "INSTAGRAM",
  channel: "instagram",
  formatKey: "instagram.post",
  scheduledFor: new Date("2026-10-02T09:00:00Z"),
  planId: null,
  version: { version: 3, assetId: "new-asset" },
  ...over,
});
const rowsOf = (r: LiveCreativeRow) => new Map([[r.id, r]]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("withLiveCreativeState (live-overlay)", () => {
  it("DB wins over the stored status, asset and version", () => {
    const out = withLiveCreativeState(
      card,
      rowsOf(row({ status: "APPROVED" })),
      inputs,
    ) as Ready;
    expect(out.status).toBe("APPROVED");
    expect(out.assetId).toBe("new-asset");
    expect(out.versionNumber).toBe(3);
    expect(out.plannedFor).toBe("2026-10-02T09:00:00.000Z");
  });

  it("carries the plan id of an owned piece for Make 3 more, and never a legacy one", () => {
    const owned = withLiveCreativeState(
      card,
      rowsOf(row({ planId: "plan-1", owned: true })),
      inputs,
    ) as Ready;
    expect(owned.planId).toBe("plan-1");
    const legacy = withLiveCreativeState(
      card,
      rowsOf(row({ planId: "plan-1", owned: false })),
      inputs,
    ) as Ready;
    expect(legacy.planId).toBeUndefined();
    const none = withLiveCreativeState(card, rowsOf(row()), inputs) as Ready;
    expect(none.planId).toBeUndefined();
  });

  it("never repeats the live current picture in the alternatives and keeps the displaced one", () => {
    // The stored card lags the live row: stale current "old-asset", the live
    // current picture "new-asset" is still listed among the alternatives.
    const stale: Ready = {
      ...card,
      alternatives: [{ assetId: "new-asset" }, { assetId: "other" }],
    };
    const out = withLiveCreativeState(stale, rowsOf(row()), inputs) as Ready;
    expect(out.assetId).toBe("new-asset");
    expect(out.alternatives?.map((a) => a.assetId)).toEqual([
      "old-asset",
      "other",
    ]);
  });

  it("derives the publish line per stage", () => {
    const review = withLiveCreativeState(card, rowsOf(row()), inputs) as Ready;
    expect(review.publishLine?.kind).toBe("review");
    const approved = withLiveCreativeState(
      card,
      rowsOf(row({ status: "APPROVED" })),
      inputs,
    ) as Ready;
    expect(approved.publishLine?.kind).toBe("scheduled");
    const published = withLiveCreativeState(
      card,
      rowsOf(row({ status: "PUBLISHED" })),
      inputs,
    ) as Ready;
    expect(published.publishLine?.kind).toBe("published");
    const rejected = withLiveCreativeState(
      card,
      rowsOf(row({ status: "REJECTED" })),
      inputs,
    ) as Ready;
    expect(rejected.publishLine).toBeUndefined();
  });

  it("gives a failed line to an approved card whose publishState failed", () => {
    const out = withLiveCreativeState(
      { ...card, publishState: "failed", publishError: "boom" },
      rowsOf(row({ status: "APPROVED" })),
      inputs,
    ) as Ready;
    expect(out.publishLine).toEqual({ kind: "failed", reason: "boom" });
  });

  it("clears approveIntent when a publish line exists, keeps it otherwise", () => {
    const out = withLiveCreativeState(card, rowsOf(row()), inputs) as Ready;
    expect(out.approveIntent).toBeUndefined();
    const none = withLiveCreativeState(
      card,
      rowsOf(row({ status: "REJECTED" })),
      inputs,
    ) as Ready;
    expect(none.approveIntent).toBe("publish");
  });

  it("gives a legacy (not Work-owned) piece no hold line and keeps approveIntent", () => {
    // planId null, a plan Command without a Work: the server publishes these by
    // the legacy rule, so a hold promise would be false consent.
    const out = withLiveCreativeState(
      card,
      rowsOf(row({ owned: false, scheduledFor: null })),
      inputs,
    ) as Ready;
    expect(out.publishLine).toBeUndefined();
    expect(out.approveIntent).toBe("publish");
    // The live row still refreshes status, asset and version.
    expect(out.assetId).toBe("new-asset");
    expect(out.versionNumber).toBe(3);
  });

  it("keeps the hold line for a Work-owned piece with no time", () => {
    const out = withLiveCreativeState(
      card,
      rowsOf(row({ owned: true, scheduledFor: null })),
      { ...inputs, scheduleEnabled: false },
    ) as Ready;
    expect(out.publishLine).toMatchObject({
      kind: "review",
      consequence: "held",
    });
    expect(out.approveIntent).toBeUndefined();
  });

  it("returns an older (archived) card unchanged when isNewestCard is false", () => {
    const archived: Ready = { ...card, status: "ARCHIVED" };
    const out = withLiveCreativeState(archived, rowsOf(row()), inputs, {
      isNewestCard: false,
    });
    expect(out).toBe(archived);
  });

  it("returns the card unchanged without a row or for other kinds", () => {
    expect(withLiveCreativeState(card, new Map(), inputs)).toBe(card);
    const loading: CreativeCardData = {
      kind: "creative-loading",
      taskId: "t",
      title: "x",
    };
    expect(withLiveCreativeState(loading, rowsOf(row()), inputs)).toBe(loading);
  });

  it("keeps the stored asset when the row has no version", () => {
    const out = withLiveCreativeState(
      card,
      rowsOf(row({ version: null })),
      inputs,
    ) as Ready;
    expect(out.assetId).toBe("old-asset");
    expect(out.versionNumber).toBe(1);
  });
});

describe("withLiveConnections", () => {
  const plan = {
    kind: "content-plan-draft",
    title: "P",
    timezone: "UTC",
    state: "draft",
    items: [],
    connections: { instagram: { connected: false } },
  } as unknown as IdeaEventCardData;

  it("overrides plan-card connections with live ones", () => {
    const live = { instagram: { connected: true } };
    const out = withLiveConnections(plan, live);
    expect(out).toMatchObject({ connections: live });
  });

  it("leaves other kinds unchanged", () => {
    const other = { kind: "plan-brief" } as unknown as IdeaEventCardData;
    expect(withLiveConnections(other, {})).toBe(other);
  });
});

describe("loaders", () => {
  it("runs no query for empty ids", async () => {
    const out = await loadLiveCreativeRows("p1", []);
    expect(out.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("scopes the single query to the project and maps the latest version", async () => {
    findMany.mockResolvedValue([
      {
        id: "c1",
        status: "APPROVED",
        platform: null,
        channel: null,
        formatKey: null,
        scheduledFor: null,
        planId: null,
        versions: [{ version: 2, assetId: "a" }],
      },
    ]);
    const out = await loadLiveCreativeRows("p1", ["c1"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        id: { in: ["c1"] },
        projectId: "p1",
      },
    });
    expect(out.get("c1")?.version).toEqual({ version: 2, assetId: "a" });
  });

  it("marks ownership from the plan Command (null planId, legacy plan, Work plan, missing plan)", async () => {
    const base = {
      status: "IN_REVIEW",
      platform: null,
      channel: null,
      formatKey: null,
      scheduledFor: null,
      versions: [],
    };
    findMany.mockResolvedValue([
      { ...base, id: "c-null", planId: null },
      { ...base, id: "c-legacy", planId: "plan-legacy" },
      { ...base, id: "c-work", planId: "plan-work" },
      { ...base, id: "c-gone", planId: "plan-gone" },
    ]);
    commandFindMany.mockResolvedValue([
      { id: "plan-legacy", workId: null },
      { id: "plan-work", workId: "w1" },
    ]);
    const out = await loadLiveCreativeRows("p1", [
      "c-null",
      "c-legacy",
      "c-work",
      "c-gone",
    ]);
    expect(out.get("c-null")?.owned).toBe(false);
    expect(out.get("c-legacy")?.owned).toBe(false);
    expect(out.get("c-work")?.owned).toBe(true);
    // A deleted plan Command fails closed: still under the Works rules.
    expect(out.get("c-gone")?.owned).toBe(true);
  });

  it("returns an empty map on error", async () => {
    findMany.mockRejectedValue(new Error("db"));
    expect((await loadLiveCreativeRows("p1", ["c1"])).size).toBe(0);
  });

  it("loadLiveInputs falls back and never throws", async () => {
    getConnections.mockRejectedValue(new Error("x"));
    count.mockRejectedValue(new Error("x"));
    getTz.mockRejectedValue(new Error("x"));
    const out = await loadLiveInputs("p1");
    expect(out.connections).toEqual({});
    expect(out.scheduleEnabled).toBe(false);
    expect(out.connectedPlatforms.size).toBe(0);
  });

  it("loadLiveInputs derives connected platforms and schedule", async () => {
    getConnections.mockResolvedValue({
      instagram: { connected: true },
      tiktok: { connected: false },
    });
    count.mockResolvedValue(1);
    getTz.mockResolvedValue("UTC");
    const out = await loadLiveInputs("p1");
    expect([...out.connectedPlatforms]).toEqual(["instagram"]);
    expect(out.scheduleEnabled).toBe(true);
    expect(out.timezone).toBe("UTC");
  });
});

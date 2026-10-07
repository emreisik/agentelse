import { beforeEach, describe, expect, it, vi } from "vitest";

import { MetaApiError } from "@/server/integrations/meta/errors";

type Op = {
  id: string;
  tag: string;
  kind: string;
  launchId: string;
  stepKey: string;
  status: string;
  resultExternalId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  attempts: number;
};

const state = vi.hoisted(() => ({
  launch: null as null | Record<string, unknown>,
  ops: [] as Op[],
  calls: [] as string[],
  clock: 0,
}));

const meta = vi.hoisted(() => ({
  postCampaign: vi.fn(),
  postAdSet: vi.fn(),
  postCreative: vi.fn(),
  postAd: vi.fn(),
  readBack: vi.fn(),
  setObjectStatus: vi.fn(),
  lifetimeImpressions: vi.fn(),
  uploadMetaAdImage: vi.fn(),
  uploadMetaAdVideo: vi.fn(),
  checkMetaVideoStatus: vi.fn(),
  findMetaObjectsByTag: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    asset: { findFirst: vi.fn(async () => ({ storageKey: "local://a.png" })) },
    adsAccount: { updateMany: vi.fn(async () => ({ count: 1 })) },
    adsObject: { updateMany: vi.fn(async () => ({ count: 1 })) },
    adsOperation: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
        const op = state.ops.find((row) => row.id === where.id)!;
        op.status = data.status;
        return op;
      }),
    },
  },
}));
vi.mock("@/server/storage/asset-storage", () => ({
  readAsset: vi.fn(async () => Buffer.from("img")),
  resolveDirectPublicUrl: vi.fn((key: string) => `https://cdn.test/${key.replace("local://", "")}`),
}));
vi.mock("@/server/ads/accounts", () => ({
  AdsAccounts: {
    resolveWithToken: vi.fn(async () => ({ status: "ready", adAccountId: "act_1", accessToken: "token", credentialId: "c" })),
  },
}));
vi.mock("@/server/integrations/meta/call-context", () => ({
  withMetaCallContext: (_ctx: unknown, run: () => unknown) => run(),
}));
vi.mock("@/server/integrations/meta-client", async () => {
  const errors = await import("@/server/integrations/meta/errors");
  return {
    MetaApiError: errors.MetaApiError,
    uploadMetaAdImage: (...args: unknown[]) => meta.uploadMetaAdImage(...args),
    uploadMetaAdVideo: (...args: unknown[]) => meta.uploadMetaAdVideo(...args),
    checkMetaVideoStatus: (...args: unknown[]) => meta.checkMetaVideoStatus(...args),
    findMetaObjectsByTag: (...args: unknown[]) => meta.findMetaObjectsByTag(...args),
  };
});
vi.mock("@/server/integrations/meta/launch-writes", () => ({
  postCampaign: (...args: unknown[]) => meta.postCampaign(...args),
  postAdSet: (...args: unknown[]) => meta.postAdSet(...args),
  postCreative: (...args: unknown[]) => meta.postCreative(...args),
  postAd: (...args: unknown[]) => meta.postAd(...args),
  readBack: (...args: unknown[]) => meta.readBack(...args),
  setObjectStatus: (...args: unknown[]) => meta.setObjectStatus(...args),
  lifetimeImpressions: (...args: unknown[]) => meta.lifetimeImpressions(...args),
}));
vi.mock("./store", () => ({
  progressOf: (launch: { progress?: unknown }) => (launch.progress ?? {}) as Record<string, unknown>,
  AdsLaunches: {
    get: vi.fn(async () => state.launch),
    claim: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
    saveProgress: vi.fn(async (_id: string, progress: unknown, extra: Record<string, unknown> = {}) => {
      state.launch = { ...state.launch!, ...extra, progress: JSON.parse(JSON.stringify(progress)) };
      return state.launch;
    }),
    transition: vi.fn(async (_id: string, from: string[], to: string, data: Record<string, unknown> = {}) => {
      if (!from.includes(state.launch!.status as string)) return false;
      state.launch = { ...state.launch!, ...data, status: to };
      return true;
    }),
    fail: vi.fn(async (_id: string, error: unknown) => {
      state.launch = { ...state.launch!, status: "FAILED", error };
    }),
  },
}));
vi.mock("@/server/ads/operations", () => ({
  AdsOperations: {
    beginStep: vi.fn(async (input: { launchId: string; kind: string; stepKey: string }) => {
      const existing = [...state.ops]
        .reverse()
        .find((op) => op.launchId === input.launchId && op.kind === input.kind && op.stepKey === input.stepKey);
      if (existing && existing.status !== "FAILED") return { op: existing, resumed: true };
      const op: Op = {
        id: `op${state.ops.length + 1}`,
        tag: `agx:t${String(state.ops.length + 1).padStart(5, "0")}`,
        kind: input.kind,
        launchId: input.launchId,
        stepKey: input.stepKey,
        status: "PENDING",
        resultExternalId: null,
        sentAt: null,
        createdAt: new Date(state.clock),
        attempts: 0,
      };
      state.ops.push(op);
      return { op, resumed: false };
    }),
    markSent: vi.fn(async (id: string) => {
      const op = state.ops.find((row) => row.id === id)!;
      op.status = "SENT";
      op.sentAt = new Date(state.clock);
    }),
    succeed: vi.fn(async (id: string, external: string) => {
      const op = state.ops.find((row) => row.id === id)!;
      op.status = "SUCCEEDED";
      op.resultExternalId = external;
    }),
    reconciled: vi.fn(async (id: string, external: string) => {
      const op = state.ops.find((row) => row.id === id)!;
      op.status = "RECONCILED";
      op.resultExternalId = external;
    }),
    unknown: vi.fn(async (id: string) => {
      state.ops.find((row) => row.id === id)!.status = "UNKNOWN";
    }),
    fail: vi.fn(async (id: string) => {
      state.ops.find((row) => row.id === id)!.status = "FAILED";
    }),
    failedAttempts: vi.fn(async (launchId: string, kind: string, stepKey: string) =>
      state.ops.filter((op) => op.launchId === launchId && op.kind === kind && op.stepKey === stepKey && op.status === "FAILED").length,
    ),
  },
}));

import { LaunchExecutor } from "./executor";

const spec = {
  version: 1,
  adAccountId: "act_1",
  currency: "TRY",
  timezone: "Europe/Istanbul",
  pageId: "9",
  objective: "OUTCOME_TRAFFIC",
  recipe: "traffic_link_clicks",
  specialAdCategories: [],
  campaignName: "Spring",
  budget: { mode: "DAILY", dailyMinor: 20_000, durationDays: 7 },
  adSets: [
    {
      name: "TR",
      optimizationGoal: "LINK_CLICKS",
      billingEvent: "IMPRESSIONS",
      targeting: { countries: ["TR"] },
      advantageAudience: 0,
    },
  ],
  ads: [
    {
      name: "Ad",
      adSetIndex: 0,
      creative: { imageAssetId: "a1", message: "Hi", link: "https://example.com", callToAction: "LEARN_MORE" },
      urlTags: "utm_source=meta",
    },
  ],
  guards: { campaignSpendCapMinor: 154_000 },
  creativeFeatures: { send: true, multiAdvertiser: "OPT_OUT" },
  activate: true,
};

function freshLaunch(overrides: Record<string, unknown> = {}) {
  state.launch = {
    id: "l1",
    projectId: "p1",
    workspaceId: "w1",
    status: "AWAITING_APPROVAL",
    adAccountExternalId: "act_1",
    spec,
    progress: {},
    campaignExternalId: null,
    ...overrides,
  };
}

async function runToEnd(mode: "create" | "activate" | "discard" = "create") {
  const writesPerTurn: number[] = [];
  for (let turn = 0; turn < 20; turn++) {
    const before = state.calls.length;
    state.clock += 1_000;
    const result = await LaunchExecutor.advance("l1", mode, { now: new Date(state.clock) });
    writesPerTurn.push(state.calls.filter((call) => call !== "readBack").length - before);
    if (result.status !== "RUNNING") return { result, writesPerTurn };
  }
  throw new Error("did not finish");
}

describe("LaunchExecutor.advance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.ops = [];
    state.calls = [];
    state.clock = Date.parse("2026-10-06T10:00:00Z");
    freshLaunch();
    meta.uploadMetaAdImage.mockImplementation(async () => (state.calls.push("upload"), { imageHash: "h1" }));
    meta.postCreative.mockImplementation(async () => (state.calls.push("creative"), { id: "cr1" }));
    meta.postCampaign.mockImplementation(async () => (state.calls.push("campaign"), { id: "c1" }));
    meta.postAdSet.mockImplementation(async () => (state.calls.push("adset"), { id: "s1" }));
    meta.postAd.mockImplementation(async () => (state.calls.push("ad"), { id: "a1" }));
    meta.readBack.mockImplementation(async (id: string) => {
      state.calls.push("readBack");
      return id === "c1" ? { spend_cap: "154000", status: "PAUSED" } : { end_time: "2026-10-13T23:59:00+0300" };
    });
    meta.setObjectStatus.mockImplementation(async (_id: string, _t: string, status: string) => {
      state.calls.push(`status:${status}`);
    });
    meta.findMetaObjectsByTag.mockResolvedValue([]);
  });

  it("creates in order, at most three writes a turn, then turns the campaign on", async () => {
    const { result, writesPerTurn } = await runToEnd();
    expect(result.status).toBe("COMPLETED");
    expect(state.calls.filter((call) => call !== "readBack")).toEqual([
      "upload",
      "creative",
      "campaign",
      "adset",
      "ad",
      "status:ACTIVE",
    ]);
    expect(Math.max(...writesPerTurn)).toBeLessThanOrEqual(3);
    expect(state.launch?.status).toBe("ACTIVE");
    // The brakes went out with the writes.
    expect(meta.postCampaign.mock.calls[0]![0]).toMatchObject({ spendCapMinor: 154_000 });
    expect(meta.postAdSet.mock.calls[0]![0]).toMatchObject({ status: "ACTIVE", dailyBudgetMinor: 20_000 });
    expect(meta.postAdSet.mock.calls[0]![0].endTime).toBeGreaterThan(meta.postAdSet.mock.calls[0]![0].startTime);
  });

  it("uploads every carousel card once and sends them as child attachments", async () => {
    let hashes = 0;
    meta.uploadMetaAdImage.mockImplementation(async () => {
      hashes += 1;
      state.calls.push("upload");
      return { imageHash: `h${hashes}` };
    });
    freshLaunch({
      spec: {
        ...spec,
        ads: [
          {
            ...spec.ads[0]!,
            creative: {
              ...spec.ads[0]!.creative,
              cards: [
                { imageAssetId: "a1", headline: "One", link: "https://example.com" },
                { imageAssetId: "a2", link: "https://example.com" },
                { imageAssetId: "a3", headline: "Three", link: "https://example.com" },
              ],
            },
          },
        ],
      },
    });
    const { result } = await runToEnd();
    expect(result.status).toBe("COMPLETED");
    expect(state.calls.filter((call) => call === "upload")).toHaveLength(3);
    expect(meta.postCreative).toHaveBeenCalledTimes(1);
    expect(meta.postCreative.mock.calls[0]![0].cards).toEqual([
      { imageHash: "h1", link: "https://example.com", headline: "One" },
      { imageHash: "h2", link: "https://example.com" },
      { imageHash: "h3", link: "https://example.com", headline: "Three" },
    ]);
    // Re-running a finished launch uploads nothing again.
    state.launch = { ...state.launch!, status: "FAILED" };
    await runToEnd();
    expect(state.calls.filter((call) => call === "upload")).toHaveLength(3);
  });

  it("sends the business hours with the total budget to the ad set", async () => {
    freshLaunch({
      spec: {
        ...spec,
        budget: { mode: "FIXED", lifetimeMinor: 140_000, durationDays: 7 },
        adSets: [
          {
            ...spec.adSets[0]!,
            schedule: { days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080 },
          },
        ],
      },
    });
    const { result } = await runToEnd();
    expect(result.status).toBe("COMPLETED");
    expect(meta.postAdSet.mock.calls[0]![0]).toMatchObject({
      lifetimeBudgetMinor: 140_000,
      schedule: { days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080 },
    });
  });

  it("uploads a video once, waits for Meta to process it, then builds the video creative", async () => {
    meta.uploadMetaAdVideo.mockImplementation(async () => (state.calls.push("video-upload"), { videoId: "v1" }));
    let polls = 0;
    meta.checkMetaVideoStatus.mockImplementation(async () => {
      polls += 1;
      state.calls.push("video-status");
      return polls >= 3;
    });
    freshLaunch({
      spec: {
        ...spec,
        ads: [
          {
            ...spec.ads[0]!,
            creative: { ...spec.ads[0]!.creative, video: { assetId: "vid1" } },
          },
        ],
      },
    });
    const { result } = await runToEnd();
    expect(result.status).toBe("COMPLETED");
    // One upload however many turns Meta needed to process it.
    expect(state.calls.filter((call) => call === "video-upload")).toHaveLength(1);
    expect(polls).toBe(3);
    // No creative before the video is ready.
    const order = state.calls.filter((call) => ["video-status", "creative"].includes(call));
    expect(order.lastIndexOf("video-status")).toBeLessThan(order.indexOf("creative"));
    expect(meta.postCreative.mock.calls[0]![0].video).toEqual({
      videoId: "v1",
      thumbnailUrl: "https://cdn.test/a.png",
    });
  });

  it("stops with Meta's words when the video can't be processed", async () => {
    meta.uploadMetaAdVideo.mockResolvedValue({ videoId: "v1" });
    meta.checkMetaVideoStatus.mockRejectedValue(
      new MetaApiError("Meta video could not be processed (video_status: error)"),
    );
    freshLaunch({
      spec: {
        ...spec,
        ads: [
          {
            ...spec.ads[0]!,
            creative: { ...spec.ads[0]!.creative, video: { assetId: "vid1" } },
          },
        ],
      },
    });
    const { result } = await runToEnd();
    expect(result.status).toBe("FAILED");
    expect(meta.postCreative).not.toHaveBeenCalled();
    expect(meta.postCampaign).not.toHaveBeenCalled();
  });

  it("never sends a finished step again", async () => {
    await runToEnd();
    state.launch = { ...state.launch!, status: "FAILED" };
    await runToEnd();
    expect(meta.postCampaign).toHaveBeenCalledTimes(1);
    expect(meta.postAdSet).toHaveBeenCalledTimes(1);
  });

  it("finds a lost write by its tag instead of sending it twice", async () => {
    let first = true;
    meta.postAdSet.mockImplementation(async () => {
      state.calls.push("adset");
      if (first) {
        first = false;
        throw new MetaApiError("socket hang up");
      }
      return { id: "s2" };
    });
    meta.findMetaObjectsByTag.mockResolvedValue(["s1"]);
    const { result } = await runToEnd();
    expect(result.status).toBe("COMPLETED");
    expect(meta.postAdSet).toHaveBeenCalledTimes(1);
    expect((state.launch?.progress as { adSets: Record<string, string> }).adSets["0"]).toBe("s1");
  });

  it("stops on a Meta validation error with the step and Meta's words", async () => {
    meta.postAd.mockImplementation(async () => {
      state.calls.push("ad");
      throw new MetaApiError("Invalid parameter", 100, 1885272, { userMessage: "Budget too low" });
    });
    const { result } = await runToEnd();
    expect(result.status).toBe("FAILED");
    expect(state.launch?.status).toBe("FAILED");
    expect(state.launch?.error).toMatchObject({ step: "ad:0", message: "Budget too low" });
    expect(state.calls).not.toContain("status:ACTIVE");
  });

  it("creates paused only when asked", async () => {
    freshLaunch({ spec: { ...spec, activate: false } });
    const { result } = await runToEnd();
    expect(result.status).toBe("COMPLETED");
    expect(state.launch?.status).toBe("CREATED_PAUSED");
    expect(state.calls).not.toContain("status:ACTIVE");
  });

  it("refuses to turn on when Meta lost the end date", async () => {
    meta.readBack.mockImplementation(async (id: string) =>
      id === "c1" ? { spend_cap: "154000", status: "PAUSED" } : {},
    );
    const { result } = await runToEnd();
    expect(result.status).toBe("FAILED");
    expect(state.launch?.error).toMatchObject({ step: "verify" });
    expect(state.calls).not.toContain("status:ACTIVE");
  });

  it("adds ads to an existing ad set without a campaign or an ad set write", async () => {
    freshLaunch({ spec: { ...spec, existingAdSetId: "777" } });
    meta.readBack.mockImplementation(async (id: string, _t: string, fields: string) => {
      state.calls.push(`readBack:${fields}`);
      return id === "777" ? { campaign_id: "c9" } : {};
    });
    const { result } = await runToEnd();
    expect(result.status).toBe("COMPLETED");
    expect(meta.postCampaign).not.toHaveBeenCalled();
    expect(meta.postAdSet).not.toHaveBeenCalled();
    expect(meta.postAd.mock.calls[0]![0]).toMatchObject({ adSetId: "777", status: "ACTIVE" });
    expect(state.calls).not.toContain("status:ACTIVE");
    expect(state.launch?.status).toBe("ACTIVE");
  });

  it("discards a never-delivered campaign by deleting it", async () => {
    freshLaunch({ status: "FAILED", progress: { campaign: "c1" }, campaignExternalId: "c1" });
    meta.lifetimeImpressions.mockResolvedValue(0);
    const { result } = await runToEnd("discard");
    expect(result.status).toBe("COMPLETED");
    expect(state.calls).toEqual(["status:DELETED"]);
    expect(state.launch?.status).toBe("DISCARDED");
  });
});

import { ExecutionJobStatus } from "@prisma/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NoPlanError } from "@/server/billing/quota-errors";
import {
  limitNoticeReplyText,
  type LimitNoticeCard,
} from "@/server/commands/limit-notice";

import type { SettledJob } from "./inline-job";

// What this suite proves about the parked-job helpers the chat uses when the
// plan allowance could not pay for a job (docs/billing-tasks.md, "Park"):
// isParked tells a parked job from every other status, describePause says WHY it
// waits and which allowance it waits for (the limit-notice card), and
// PAUSED_NOTE is what the model is told so it never claims a result. The five
// places that branch on them have their own suites (tools.parked,
// slot-first.parked, production-run.parked).

const findUnique = vi.hoisted(() => vi.fn());
const balanceFindUnique = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({
  prisma: {
    executionJob: { findUnique },
    usageBalance: { findUnique: balanceFindUnique },
  },
}));

const { PAUSED_NOTE, describePause, isParked } = await import("./parked-job");

// describePause sizes the job through a lazy import of the provider-backed
// sizing module (about a second on a cold start). Load it up front so that cost
// never counts against one test's own timeout.
beforeAll(async () => {
  await import("@/server/execution/usage-need");
}, 30_000);

beforeEach(() => {
  findUnique.mockReset();
  balanceFindUnique.mockReset();
  // No allowance window known unless a test says so.
  balanceFindUnique.mockResolvedValue(null);
});

describe("isParked", () => {
  it("sees WAITING_BUDGET in the generated status list", () => {
    // The it.each below is built from this list: a status missing from the
    // generated client would silently shrink the check.
    expect(Object.values(ExecutionJobStatus)).toContain("WAITING_BUDGET");
  });

  it("is true for a job waiting for budget", () => {
    expect(isParked({ status: "WAITING_BUDGET" })).toBe(true);
    // The shape driveJobInline settles to.
    const settled: SettledJob = {
      status: "WAITING_BUDGET",
      errorMessage: null,
    };
    expect(isParked(settled)).toBe(true);
  });

  it.each(
    Object.values(ExecutionJobStatus).filter(
      (status) => status !== "WAITING_BUDGET",
    ),
  )("is false for %s", (status) => {
    expect(isParked({ status })).toBe(false);
  });

  it("matches the status exactly", () => {
    expect(isParked({ status: "waiting_budget" })).toBe(false);
    expect(isParked({ status: "WAITING" })).toBe(false);
    expect(isParked({ status: "" })).toBe(false);
  });
});

describe("describePause", () => {
  const parkedJob = (overrides: Record<string, unknown> = {}) => ({
    workspaceId: "w-1",
    errorCode: "QUOTA_EXCEEDED",
    capability: "CREATE_SOCIAL_CREATIVE",
    requestPayload: { request: "A post about the autumn menu" },
    ...overrides,
  });

  it("reads the parked job it is asked about", async () => {
    findUnique.mockResolvedValue(parkedJob());

    await describePause("job-7");

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-7" },
        select: expect.objectContaining({
          errorCode: true,
          capability: true,
          requestPayload: true,
        }),
      }),
    );
  });

  it("names the image allowance for a picture job parked on QUOTA_EXCEEDED", async () => {
    findUnique.mockResolvedValue(parkedJob());

    await expect(describePause("job-1")).resolves.toMatchObject({
      reason: "allowance-used",
      unit: "IMAGE",
    });
  });

  it("names the AI allowance for a text job parked on QUOTA_EXCEEDED", async () => {
    findUnique.mockResolvedValue(
      parkedJob({
        capability: "CREATE_COPY",
        requestPayload: { request: "Write a LinkedIn post" },
      }),
    );

    await expect(describePause("job-1")).resolves.toMatchObject({
      reason: "allowance-used",
      unit: "AI_MICROS",
    });
  });

  it("says there is no plan for a job parked on NO_PLAN", async () => {
    findUnique.mockResolvedValue(parkedJob({ errorCode: "NO_PLAN" }));

    const notice = await describePause("job-1");

    expect(notice.reason).toBe("no-plan");
    // Not mistaken for the allowance story.
    expect(notice.reason).not.toBe("allowance-used");
  });

  it.each([null, "SOMETHING_ELSE"])(
    "falls back to the allowance story for error code %s",
    async (errorCode) => {
      findUnique.mockResolvedValue(parkedJob({ errorCode }));

      await expect(describePause("job-1")).resolves.toMatchObject({
        reason: "allowance-used",
        unit: "IMAGE",
      });
    },
  );

  it("reads the code the park step stores for a job without a plan", async () => {
    // parkJob writes `errorCode: error.code` of the error that parked the job.
    const noPlan = new NoPlanError("UNIT_NOT_SOLD");
    findUnique.mockResolvedValue(parkedJob({ errorCode: noPlan.code }));

    await expect(describePause("job-1")).resolves.toMatchObject({
      reason: "no-plan",
    });
  });

  it("sizes a picture job that has no stored payload", async () => {
    findUnique.mockResolvedValue(parkedJob({ requestPayload: null }));

    await expect(describePause("job-1")).resolves.toMatchObject({
      reason: "allowance-used",
      unit: "IMAGE",
    });
  });

  // describePause sizes the job's OWN stored payload. A picture job that only cuts
  // the brand's photo, or re-lays out a picture that already exists, draws nothing:
  // it waits on the plan itself and must not tell the client their image credits
  // ran out.
  it.each([
    ["the brand's own photo is the picture", { photoAssetIds: ["asset-1"] }],
    [
      "another format of a post that already has its picture",
      { adaptFromAssetId: "asset-9" },
    ],
  ])(
    "sizes the job's own payload: a picture job that draws nothing (%s) names no allowance",
    async (_what, requestPayload) => {
      findUnique.mockResolvedValue(
        parkedJob({ errorCode: "NO_PLAN", requestPayload }),
      );

      const notice = await describePause("job-1");

      expect(notice.reason).toBe("no-plan");
      expect(notice.unit).toBeUndefined();
    },
  );

  it("names no allowance for a job that spends none", async () => {
    findUnique.mockResolvedValue(
      parkedJob({
        capability: "INSTAGRAM_PUBLISH",
        requestPayload: { creativeId: "c-1" },
      }),
    );

    const notice = await describePause("job-1");

    expect(notice.reason).toBe("allowance-used");
    expect(notice.unit).toBeUndefined();
  });

  // The card says when the allowance renews: the end of the workspace's window for
  // the unit the job waits on (the moment the resume sweep wakes it).
  describe("the renewal date", () => {
    const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

    it("is the end of the window of the allowance the job waits on", async () => {
      const endsAt = inDays(12);
      balanceFindUnique.mockResolvedValue({ periodEnd: endsAt });
      findUnique.mockResolvedValue(parkedJob());

      await expect(describePause("job-1")).resolves.toEqual({
        reason: "allowance-used",
        unit: "IMAGE",
        resetsAt: endsAt.toISOString(),
      });
      expect(balanceFindUnique).toHaveBeenCalledWith({
        where: { workspaceId_unit: { workspaceId: "w-1", unit: "IMAGE" } },
        select: { periodEnd: true },
      });
    });

    it("looks at the AI window for a text job", async () => {
      balanceFindUnique.mockResolvedValue({ periodEnd: inDays(3) });
      findUnique.mockResolvedValue(
        parkedJob({
          capability: "CREATE_COPY",
          requestPayload: { request: "Write a LinkedIn post" },
        }),
      );

      await describePause("job-1");

      expect(balanceFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId_unit: { workspaceId: "w-1", unit: "AI_MICROS" } },
        }),
      );
    });

    it("reaches the card, which tells the client when it renews", async () => {
      const endsAt = new Date("2099-11-01T00:00:00.000Z");
      balanceFindUnique.mockResolvedValue({ periodEnd: endsAt });
      findUnique.mockResolvedValue(parkedJob());

      const notice = await describePause("job-1");

      expect(limitNoticeReplyText({ kind: "limit-notice", ...notice })).toContain(
        "Nov 1",
      );
    });

    it("is left out when the window has already ended (the next sweep renews it)", async () => {
      balanceFindUnique.mockResolvedValue({ periodEnd: inDays(-1) });
      findUnique.mockResolvedValue(parkedJob());

      const notice = await describePause("job-1");

      expect(notice).toEqual({ reason: "allowance-used", unit: "IMAGE" });
    });

    it("is left out when the workspace has no window", async () => {
      balanceFindUnique.mockResolvedValue(null);
      findUnique.mockResolvedValue(parkedJob());

      expect(await describePause("job-1")).not.toHaveProperty("resetsAt");
    });

    it("is not looked up for a workspace that has no plan: there is nothing to renew", async () => {
      balanceFindUnique.mockResolvedValue({ periodEnd: inDays(12) });
      findUnique.mockResolvedValue(parkedJob({ errorCode: "NO_PLAN" }));

      const notice = await describePause("job-1");

      expect(notice).toEqual({ reason: "no-plan", unit: "IMAGE" });
      expect(balanceFindUnique).not.toHaveBeenCalled();
    });
  });

  // A job that is correctly parked must never be reported as failed because the
  // explanation could not be looked up: the client would be told to retry and the
  // same work would be made twice.
  describe("when the lookup itself fails", () => {
    it("answers with the allowance story instead of throwing (job read)", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      findUnique.mockRejectedValue(new Error("connection reset"));

      await expect(describePause("job-1")).resolves.toEqual({
        reason: "allowance-used",
      });
      spy.mockRestore();
    });

    it("answers with what it knows when only the window lookup fails", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      findUnique.mockResolvedValue(parkedJob());
      balanceFindUnique.mockRejectedValue(new Error("connection reset"));

      await expect(describePause("job-1")).resolves.toMatchObject({
        reason: "allowance-used",
      });
      spy.mockRestore();
    });
  });

  it("still answers when the job is gone: allowance story, no allowance named", async () => {
    findUnique.mockResolvedValue(null);

    const notice = await describePause("job-gone");

    expect(notice.reason).toBe("allowance-used");
    expect(notice.unit).toBeUndefined();
  });
});

describe("the limit-notice card built from describePause", () => {
  // The chat spreads the result into { kind: "limit-notice", ... }.
  const cardFor = async (
    overrides: Record<string, unknown>,
  ): Promise<LimitNoticeCard> => {
    findUnique.mockResolvedValue({
      errorCode: "QUOTA_EXCEEDED",
      capability: "CREATE_SOCIAL_CREATIVE",
      requestPayload: { request: "A post" },
      ...overrides,
    });
    return { kind: "limit-notice", ...(await describePause("job-1")) };
  };

  it("tells the client their image credits are used up, with the unit on the card", async () => {
    const card = await cardFor({});

    expect(card).toMatchObject({
      kind: "limit-notice",
      reason: "allowance-used",
      unit: "IMAGE",
    });
    const text = limitNoticeReplyText(card);
    expect(text).toContain("image credits");
    expect(text).toContain("continues by itself");
  });

  it("tells the client their AI allowance is used up for a text job", async () => {
    const card = await cardFor({
      capability: "CREATE_CAPTION",
      requestPayload: { request: "A caption" },
    });

    expect(card).toMatchObject({ reason: "allowance-used", unit: "AI_MICROS" });
    expect(limitNoticeReplyText(card)).toContain("AI allowance");
  });

  it("tells the client there is no active plan for a job parked on NO_PLAN", async () => {
    const card = await cardFor({ errorCode: "NO_PLAN" });

    expect(card.reason).toBe("no-plan");
    expect(limitNoticeReplyText(card)).toContain("no active plan");
  });

  it("never shows the client a dollar or token figure", async () => {
    for (const overrides of [
      {},
      { capability: "CREATE_COPY", requestPayload: { request: "x" } },
      { errorCode: "NO_PLAN" },
    ]) {
      const card = await cardFor(overrides);
      expect(limitNoticeReplyText(card)).not.toMatch(
        /\$|dollar|\busd\b|token|micro/i,
      );
    }
  });
});

describe("PAUSED_NOTE", () => {
  it("is a real sentence for the model", () => {
    expect(typeof PAUSED_NOTE).toBe("string");
    expect(PAUSED_NOTE.trim().length).toBeGreaterThan(0);
  });

  it("tells the model nothing was made and forbids claiming a result", () => {
    expect(PAUSED_NOTE).toMatch(/^NOT made yet/);
    expect(PAUSED_NOTE).toMatch(
      /never say it is ready, made or still rendering/i,
    );
    expect(PAUSED_NOTE).toMatch(/goes on by itself/i);
  });

  it("carries no dollar or token wording: the client sees what they can do, not what it costs", () => {
    expect(PAUSED_NOTE).not.toMatch(/\$|dollar|\busd\b|token|micro/i);
  });
});

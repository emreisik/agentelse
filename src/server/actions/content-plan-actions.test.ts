import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const auditRecord = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

const tx = {
  command: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
  creative: { create: vi.fn() },
};
const commandFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: { findUnique: commandFindUnique },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  },
}));

const { saveContentPlanAction } = await import("./content-plan-actions");

const draft = (state: string) => ({
  card: {
    kind: "content-plan-draft",
    title: "Plan",
    timezone: "Europe/Istanbul",
    state,
    items: [
      {
        date: "2026-10-01",
        time: "10:00",
        platform: "INSTAGRAM",
        format: "Reel",
        topic: "Launch teaser",
        captionIdea: "Behind the scenes",
      },
      {
        date: "2026-10-03",
        time: "18:30",
        platform: "LINKEDIN",
        topic: "Founder story",
        captionIdea: "Why we started",
      },
    ],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ userId: "u1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  commandFindUnique.mockResolvedValue({ projectId: "proj-1" });
  tx.command.findUnique.mockResolvedValue({
    projectId: "proj-1",
    parsedIntent: draft("draft"),
  });
  let n = 0;
  tx.creative.create.mockImplementation(async () => ({ id: `cr-${++n}` }));
});

describe("saveContentPlanAction", () => {
  it("stores each slot as a dated DRAFT creative in the project's timezone", async () => {
    const result = await saveContentPlanAction("cmd-1");

    expect(result).toEqual({ ok: true, saved: 2 });
    const first = tx.creative.create.mock.calls[0]![0].data;
    expect(first).toMatchObject({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      type: "SOCIAL_POST",
      platform: "INSTAGRAM",
      status: "DRAFT",
      title: "Launch teaser",
      // A legacy "Reel" resolves to the catalog: the format is structured now
      // instead of a "[Reel]" prefix on the brief.
      brief: "Behind the scenes",
      channel: "instagram",
      formatKey: "instagram.reel",
      planId: "cmd-1",
    });
    // 10:00 in Istanbul (UTC+3) is 07:00 UTC.
    expect((first.scheduledFor as Date).toISOString()).toBe(
      "2026-10-01T07:00:00.000Z",
    );
    expect(tx.creative.create.mock.calls[1]![0].data.brief).toBe("Why we started");

    const saved = tx.command.update.mock.calls[0]![0].data.parsedIntent.card;
    expect(saved).toMatchObject({
      state: "saved",
      savedCreativeIds: ["cr-1", "cr-2"],
    });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "content_plan.saved" }),
    );
  });

  it("saves channel, format and goal for a catalog plan (blog and ads are not social posts)", async () => {
    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: {
        card: {
          kind: "content-plan-draft",
          title: "Plan",
          timezone: "Europe/Istanbul",
          state: "draft",
          goal: "leads",
          items: [
            {
              date: "2026-10-01",
              time: "10:00",
              platform: "INSTAGRAM",
              channel: "instagram",
              formatKey: "instagram.carousel",
              topic: "Carousel topic",
              captionIdea: "Slides",
            },
            {
              date: "2026-10-02",
              time: "10:00",
              channel: "seo",
              formatKey: "seo.article",
              topic: "Article topic",
              captionIdea: "Target keyword",
            },
            {
              date: "2026-10-03",
              time: "10:00",
              channel: "ads",
              formatKey: "ads.campaign",
              topic: "Offer",
              captionIdea: "Audience",
            },
          ],
        },
      },
    });

    expect(await saveContentPlanAction("cmd-1")).toEqual({ ok: true, saved: 3 });
    const [carousel, article, ads] = tx.creative.create.mock.calls.map(
      (call) => call[0].data,
    );
    expect(carousel).toMatchObject({
      type: "SOCIAL_POST",
      platform: "INSTAGRAM",
      channel: "instagram",
      formatKey: "instagram.carousel",
      goal: "leads",
      planId: "cmd-1",
      brief: "Slides",
    });
    expect(article).toMatchObject({
      type: "COPY",
      platform: undefined,
      channel: "seo",
      formatKey: "seo.article",
    });
    expect(ads).toMatchObject({
      type: "CAMPAIGN_BRIEF",
      platform: undefined,
      channel: "ads",
      formatKey: "ads.campaign",
    });
  });

  it("keeps the old shape for a platform the catalog does not cover", async () => {
    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: {
        card: {
          kind: "content-plan-draft",
          title: "Plan",
          timezone: "Europe/Istanbul",
          state: "draft",
          items: [
            {
              date: "2026-10-01",
              time: "10:00",
              platform: "FACEBOOK",
              format: "Live",
              topic: "Q&A",
              captionIdea: "Ask us",
            },
          ],
        },
      },
    });

    await saveContentPlanAction("cmd-1");
    expect(tx.creative.create.mock.calls[0]![0].data).toMatchObject({
      type: "SOCIAL_POST",
      platform: "FACEBOOK",
      brief: "[Live] Ask us",
      channel: undefined,
      formatKey: undefined,
    });
  });

  it("refuses to save twice or to save a replaced plan", async () => {
    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: draft("saved"),
    });
    expect(await saveContentPlanAction("cmd-1")).toMatchObject({
      ok: false,
      message: expect.stringContaining("already saved"),
    });

    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: draft("superseded"),
    });
    expect(await saveContentPlanAction("cmd-1")).toMatchObject({
      ok: false,
      message: expect.stringContaining("newer version"),
    });
    expect(tx.creative.create).not.toHaveBeenCalled();
  });

  it("checks project access before touching anything", async () => {
    requireProjectAccess.mockRejectedValue(new Error("Project not found"));
    expect(await saveContentPlanAction("cmd-1")).toMatchObject({ ok: false });
    expect(tx.creative.create).not.toHaveBeenCalled();
  });

  it("does not treat a non-plan command as a plan", async () => {
    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: { card: { kind: "question", questions: [] } },
    });
    expect(await saveContentPlanAction("cmd-1")).toMatchObject({
      ok: false,
      message: "Plan not found.",
    });
  });
});

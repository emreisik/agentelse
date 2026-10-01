import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { Prisma } from "@prisma/client";

const tx = {
  command: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
  creative: { create: vi.fn() },
};

const { savePlanSlotsInTx } = await import("./save-plan-core");

const scope = { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" };
const run = (id = "cmd-1") =>
  savePlanSlotsInTx(tx as unknown as Prisma.TransactionClient, scope, id);

const card = (state: string, items: unknown[]) => ({
  card: {
    kind: "content-plan-draft",
    title: "Plan",
    timezone: "Europe/Istanbul",
    state,
    goal: "leads",
    items,
  },
});

const legacy = {
  date: "2026-10-01",
  time: "10:00",
  platform: "FACEBOOK",
  format: "Live",
  topic: "Q&A",
  captionIdea: "Ask us",
};
const catalog = {
  date: "2026-10-02",
  time: "18:30",
  channel: "seo",
  formatKey: "seo.article",
  topic: "Article",
  captionIdea: "Keyword",
};

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  tx.creative.create.mockImplementation(async () => ({ id: `cr-${++n}` }));
  tx.command.findUnique.mockResolvedValue({
    projectId: "proj-1",
    parsedIntent: card("draft", [legacy, catalog]),
  });
});

describe("savePlanSlotsInTx", () => {
  it("writes aligned ids, card timezone dates and the saved card", async () => {
    const out = await run();
    expect(out).toEqual({ ok: true, count: 2, creativeIds: ["cr-1", "cr-2"] });

    const [a, b] = tx.creative.create.mock.calls.map((c) => c[0].data);
    expect(a).toMatchObject({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      type: "SOCIAL_POST",
      platform: "FACEBOOK",
      goal: "leads",
      planId: "cmd-1",
      title: "Q&A",
      brief: "[Live] Ask us",
      status: "DRAFT",
    });
    expect((a.scheduledFor as Date).toISOString()).toBe("2026-10-01T07:00:00.000Z");
    expect(b).toMatchObject({ type: "COPY", channel: "seo", formatKey: "seo.article" });
    expect((b.scheduledFor as Date).toISOString()).toBe("2026-10-02T15:30:00.000Z");

    expect(tx.command.update.mock.calls[0]![0].data.parsedIntent.card).toMatchObject({
      state: "saved",
      savedCreativeIds: ["cr-1", "cr-2"],
    });
  });

  it("returns the three error strings and writes nothing", async () => {
    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: card("saved", [catalog]),
    });
    expect(await run()).toEqual({ ok: false, error: "This plan is already saved." });

    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: card("superseded", [catalog]),
    });
    expect(await run()).toEqual({
      ok: false,
      error: "A newer version of this plan exists. Save that one instead.",
    });

    tx.command.findUnique.mockResolvedValue({
      projectId: "other",
      parsedIntent: card("draft", [catalog]),
    });
    expect(await run()).toEqual({ ok: false, error: "Plan not found." });

    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: { card: { kind: "question", questions: [] } },
    });
    expect(await run()).toEqual({ ok: false, error: "Plan not found." });

    expect(tx.creative.create).not.toHaveBeenCalled();
    expect(tx.command.update).not.toHaveBeenCalled();
  });
});

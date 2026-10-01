import { beforeEach, describe, expect, it, vi } from "vitest";

const commandFindMany = vi.fn();
const commandUpdate = vi.fn().mockResolvedValue(undefined);
const scheduleFindFirst = vi.fn();
const updateCommandCard = vi.fn();
vi.mock("./card-store", () => ({ updateCommandCard }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: { findMany: commandFindMany, update: commandUpdate },
    projectSchedule: { findFirst: scheduleFindFirst },
  },
}));

const {
  buildPlanCard,
  getProjectTimezone,
  supersedeOpenDrafts,
  supersedeOpenPlanCards,
  todayInTimezone,
  validatePlanChannels,
  validatePlanDates,
  ContentPlanArgsSchema,
} = await import("./content-plan");

beforeEach(() => vi.clearAllMocks());

describe("validatePlanDates", () => {
  const today = "2026-09-29";

  it("accepts today and future dates within the horizon", () => {
    expect(
      validatePlanDates([{ date: "2026-09-29" }, { date: "2026-11-20" }], today),
    ).toBeNull();
  });

  it("rejects past dates, far-future dates and impossible dates", () => {
    expect(validatePlanDates([{ date: "2026-09-28" }], today)).toMatch(/past/);
    expect(validatePlanDates([{ date: "2027-09-29" }], today)).toMatch(
      /days away/,
    );
    expect(validatePlanDates([{ date: "2026-02-30" }], today)).toMatch(
      /not a real/,
    );
  });
});

describe("buildPlanCard", () => {
  it("defaults the time, trims text and orders slots chronologically", () => {
    const card = buildPlanCard(
      {
        title: " October push ",
        items: [
          {
            date: "2026-10-02",
            platform: "INSTAGRAM",
            topic: " Later ",
            captionIdea: "b",
          },
          {
            date: "2026-10-01",
            time: "18:30",
            platform: "LINKEDIN",
            format: "  ",
            topic: "Earlier",
            captionIdea: "a",
          },
        ],
      },
      "Europe/Istanbul",
    );

    expect(card).toMatchObject({
      kind: "content-plan-draft",
      title: "October push",
      timezone: "Europe/Istanbul",
      state: "draft",
    });
    expect(card.items.map((i) => i.topic)).toEqual(["Earlier", "Later"]);
    expect(card.items[1]!.time).toBe("10:00");
    expect(card.items[0]!.format).toBeUndefined();
  });
});

describe("catalog plan items", () => {
  const args = ContentPlanArgsSchema.parse({
    title: "Leads push",
    goal: "leads",
    items: [
      {
        date: "2026-10-02",
        channel: "seo",
        formatKey: "seo.article",
        topic: "Article",
        captionIdea: "Keyword",
      },
      {
        date: "2026-10-01",
        time: "09:30",
        channel: "instagram",
        formatKey: "instagram.carousel",
        topic: "Carousel",
        captionIdea: "Slides",
      },
    ],
  });

  it("carries goal, connections, channel and format; derives the platform", () => {
    const connections = { instagram: { connected: true, accountLabel: "@acme" } };
    const card = buildPlanCard(args, "Europe/Istanbul", connections);

    expect(card).toMatchObject({ goal: "leads", connections });
    expect(card.items[0]).toMatchObject({
      channel: "instagram",
      formatKey: "instagram.carousel",
      platform: "INSTAGRAM",
      time: "09:30",
      format: undefined,
    });
    // Blog/SEO has no social platform.
    expect(card.items[1]).toMatchObject({
      channel: "seo",
      formatKey: "seo.article",
      platform: undefined,
    });
  });

  it("normalizes a legacy platform + free-text format onto the catalog", () => {
    const card = buildPlanCard(
      ContentPlanArgsSchema.parse({
        title: "Old",
        items: [
          {
            date: "2026-10-01",
            platform: "INSTAGRAM",
            format: "Reel",
            topic: "t",
            captionIdea: "c",
          },
          {
            date: "2026-10-02",
            platform: "FACEBOOK",
            topic: "t",
            captionIdea: "c",
          },
        ],
      }),
      "Europe/Istanbul",
    );
    expect(card.items[0]).toMatchObject({
      channel: "instagram",
      formatKey: "instagram.reel",
      format: "Reel",
    });
    // Facebook is outside the catalog: only the platform survives.
    expect(card.items[1]).toMatchObject({
      platform: "FACEBOOK",
      channel: undefined,
    });
  });

  it("requires a channel + format or a legacy platform", () => {
    expect(
      ContentPlanArgsSchema.safeParse({
        title: "x",
        items: [{ date: "2026-10-01", topic: "t", captionIdea: "c" }],
      }).success,
    ).toBe(false);
  });

  it("hands a format that does not belong to its channel back to the model", () => {
    expect(
      validatePlanChannels([{ channel: "instagram", formatKey: "instagram.thread" }]),
    ).toMatch(/not a format of instagram.*instagram\.post/);
    expect(
      validatePlanChannels([{ channel: "x", formatKey: "x.thread" }]),
    ).toBeNull();
    expect(validatePlanChannels([{}])).toBeNull();
  });
});

describe("getProjectTimezone / todayInTimezone", () => {
  it("falls back to Europe/Istanbul like the calendar does", async () => {
    scheduleFindFirst.mockResolvedValue(null);
    expect(await getProjectTimezone("p")).toBe("Europe/Istanbul");
    scheduleFindFirst.mockResolvedValue({ timezone: "America/New_York" });
    expect(await getProjectTimezone("p")).toBe("America/New_York");
  });

  it("reads 'today' in the project's timezone, not UTC", () => {
    // 23:30 UTC on the 29th is already the 30th in Istanbul (UTC+3).
    const now = new Date("2026-09-29T23:30:00Z");
    expect(todayInTimezone("Europe/Istanbul", now)).toBe("2026-09-30");
    expect(todayInTimezone("UTC", now)).toBe("2026-09-29");
  });
});

describe("supersedeOpenDrafts", () => {
  it("marks only other, still-open drafts as superseded", async () => {
    commandFindMany.mockResolvedValue([
      { id: "old-open", parsedIntent: { card: { kind: "content-plan-draft", state: "draft" } } },
      { id: "old-saved", parsedIntent: { card: { kind: "content-plan-draft", state: "saved" } } },
    ]);
    await supersedeOpenDrafts("proj-1", "cmd-new");

    expect(commandFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "proj-1",
          id: { not: "cmd-new" },
        }),
      }),
    );
    expect(commandUpdate).toHaveBeenCalledTimes(1);
    expect(commandUpdate).toHaveBeenCalledWith({
      where: { id: "old-open" },
      data: {
        parsedIntent: {
          card: { kind: "content-plan-draft", state: "superseded" },
        },
      },
    });
  });
});

describe("supersedeOpenDrafts (Works scope)", () => {
  // W08: without a workId the statements are exactly the old ones.
  it("flag-off call shape: exact where, no OR, no atomic writer", async () => {
    commandFindMany.mockResolvedValue([]);
    await supersedeOpenDrafts("proj-1", "cmd-new");
    // Strict equality: an `undefined` workId key must not sneak in.
    expect(commandFindMany.mock.calls.at(0)?.[0]).toStrictEqual({
      where: {
        projectId: "proj-1",
        id: { not: "cmd-new" },
        parsedIntent: { path: ["card", "kind"], equals: "content-plan-draft" },
      },
      select: { id: true, parsedIntent: true },
    });
    expect(updateCommandCard).not.toHaveBeenCalled();
  });

  it("with a workId adds the filter and flips through the atomic writer", async () => {
    commandFindMany.mockResolvedValue([{ id: "d1" }]);
    await supersedeOpenDrafts("proj-1", "cmd-new", "work-1");
    const arg = commandFindMany.mock.calls.at(0)?.[0] as {
      where: { workId: string; OR: unknown[] };
    };
    expect(arg.where.workId).toBe("work-1");
    expect(arg.where.OR).toHaveLength(1);
    expect(commandUpdate).not.toHaveBeenCalled();
    expect(updateCommandCard).toHaveBeenCalledTimes(1);
  });
});

describe("supersedeOpenPlanCards", () => {
  const kinds = ["content-plan-draft", "content-plan-options"] as const;

  function update(card: Record<string, unknown>): unknown {
    const input = updateCommandCard.mock.calls.at(0)?.[0] as {
      update: (c: Record<string, unknown>) => unknown;
    };
    return input.update(card);
  }

  it("queries this Work only with one equals per kind", async () => {
    commandFindMany.mockResolvedValue([{ id: "x" }]);
    await supersedeOpenPlanCards({
      projectId: "p",
      exceptCommandId: "new",
      workId: "w",
      kinds,
    });
    const arg = commandFindMany.mock.calls.at(0)?.[0] as {
      where: { workId: string; OR: unknown[] };
    };
    expect(arg.where.workId).toBe("w");
    expect(arg.where.OR).toEqual([
      { parsedIntent: { path: ["card", "kind"], equals: "content-plan-draft" } },
      { parsedIntent: { path: ["card", "kind"], equals: "content-plan-options" } },
    ]);
  });

  it("flips draft plans and open options", async () => {
    commandFindMany.mockResolvedValue([{ id: "x" }]);
    await supersedeOpenPlanCards({ projectId: "p", exceptCommandId: "n", workId: "w", kinds });
    expect(update({ kind: "content-plan-draft", state: "draft" })).toEqual({
      kind: "content-plan-draft",
      state: "superseded",
    });
    expect(update({ kind: "content-plan-options", state: "open" })).toEqual({
      kind: "content-plan-options",
      state: "superseded",
    });
  });

  it("never touches a saved or picked card", async () => {
    commandFindMany.mockResolvedValue([{ id: "x" }]);
    await supersedeOpenPlanCards({ projectId: "p", exceptCommandId: "n", workId: "w", kinds });
    expect(update({ kind: "content-plan-draft", state: "saved" })).toBeNull();
    expect(update({ kind: "content-plan-options", state: "picked" })).toBeNull();
    expect(update({ kind: "content-plan-options", state: "draft" })).toBeNull();
  });

  it("flips a main message in draft or adapted, never a superseded one", async () => {
    commandFindMany.mockResolvedValue([{ id: "x" }]);
    await supersedeOpenPlanCards({
      projectId: "p",
      exceptCommandId: "n",
      workId: "w",
      kinds: ["master-content"],
    });
    expect(update({ kind: "master-content", state: "draft" })).toEqual({
      kind: "master-content",
      state: "superseded",
    });
    expect(update({ kind: "master-content", state: "adapted" })).toEqual({
      kind: "master-content",
      state: "superseded",
    });
    expect(update({ kind: "master-content", state: "superseded" })).toBeNull();
    expect(update({ kind: "content-plan-draft", state: "adapted" })).toBeNull();
  });

  it("honours a kinds subset", async () => {
    commandFindMany.mockResolvedValue([]);
    await supersedeOpenPlanCards({
      projectId: "p",
      exceptCommandId: "n",
      workId: "w",
      kinds: ["content-plan-options"],
    });
    const arg = commandFindMany.mock.calls.at(0)?.[0] as { where: { OR: unknown[] } };
    expect(arg.where.OR).toHaveLength(1);
  });
});

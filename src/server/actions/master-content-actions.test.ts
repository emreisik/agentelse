import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Guard 'master-schedule' (W91): scheduleMasterAction rewrites the SAME
// Command into a saved content-plan-draft. The Command row is an in-memory
// object behind the REAL card store and the REAL save core (transactions are
// serialised like Serializable), so what ends up on the row and in the
// Creative inserts is what production would write; every other IO module is
// mocked.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorksEnabled: vi.fn(),
  isRateLimited: vi.fn(),
  workGet: vi.fn(),
  workTouch: vi.fn(),
  setChannels: vi.fn(),
  findIdea: vi.fn(),
  advance: vi.fn(),
  audit: vi.fn(),
  loadBrandRules: vi.fn(),
  ruleLanguageOf: vi.fn(),
  loadSuggestedSlots: vi.fn(),
  loadOccupiedSlots: vi.fn(),
  getProjectTimezone: vi.fn(),
  getChannelConnections: vi.fn(),
  revalidatePath: vi.fn(),
  commandFindUnique: vi.fn(),
  commandFindFirst: vi.fn(),
  commandCreate: vi.fn(),
  transaction: vi.fn(),
  creativeCreate: vi.fn(),
  workFindFirst: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: {
      findUnique: mocks.commandFindUnique,
      findFirst: mocks.commandFindFirst,
      create: mocks.commandCreate,
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/works/flag", () => ({
  isWorksEnabled: mocks.isWorksEnabled,
}));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/server/repositories/work.repository", () => ({
  WorkRepository: {
    get: mocks.workGet,
    touch: mocks.workTouch,
    setChannels: mocks.setChannels,
  },
}));
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: {
    findByIdInProject: mocks.findIdea,
    advanceForScheduling: mocks.advance,
  },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.audit },
}));
vi.mock("@/server/brand/rule-language", () => ({
  brandRuleLanguageOf: mocks.ruleLanguageOf,
}));
vi.mock("@/server/works/brand-rule-loader", () => ({
  loadBrandRules: mocks.loadBrandRules,
}));
vi.mock("@/server/works/free-slot-loader", () => ({
  loadSuggestedSlots: mocks.loadSuggestedSlots,
  loadOccupiedSlots: mocks.loadOccupiedSlots,
}));
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections: mocks.getChannelConnections,
}));
vi.mock("@/server/chat/content-plan", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/chat/content-plan")
  >("@/server/chat/content-plan");
  return { ...actual, getProjectTimezone: mocks.getProjectTimezone };
});

import {
  addMasterChannelAction,
  scheduleMasterAction,
  toggleMasterTargetAction,
} from "@/server/actions/master-content-actions";
import { AgentelseError } from "@/server/security/errors";

const PROJECT = "p1";
const WORK = "w1";
const CMD = "cmd1";
// 09:00 UTC = 12:00 in Europe/Istanbul on 2026-10-01.
const NOW = new Date("2026-10-01T09:00:00.000Z");
const TZ = "Europe/Istanbul";

type Row = {
  id: string;
  projectId: string;
  workId: string | null;
  replyText: string;
  parsedIntent: Record<string, unknown> | null;
};

let row: Row;
let chain: Promise<unknown> = Promise.resolve();
let creativeCount = 0;

const tx = {
  command: {
    findUnique: vi.fn(async () => row),
    update: vi.fn(async ({ data }: { data: Partial<Row> }) => {
      row = { ...row, ...data } as Row;
      return row;
    }),
    create: vi.fn(),
  },
  work: { findFirst: mocks.workFindFirst },
  creative: { create: mocks.creativeCreate },
  // One Post per post of the plan (save-plan-core createPostsInTx).
  post: { create: vi.fn(async () => ({ id: "post-1" })) },
};

function work(over: Record<string, unknown> = {}) {
  return {
    id: WORK,
    title: "Launch",
    summary: null,
    status: "ACTIVE",
    channels: ["instagram", "linkedin", "x", "ads"],
    acknowledgedUnconnected: [],
    lastActivityAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

type Target = {
  channel: string;
  formatKey: string;
  included: boolean;
  adaptation?: { topic: string; captionIdea: string; issues?: string[] };
};

function masterCard(over: Record<string, unknown> = {}) {
  return {
    kind: "master-content",
    title: "Autumn menu",
    state: "adapted",
    master: {
      title: "Autumn menu",
      message: "The new autumn menu is here.",
      goal: "awareness",
    },
    targets: [
      {
        channel: "instagram",
        formatKey: "instagram.post",
        included: true,
        adaptation: { topic: "IG topic", captionIdea: "IG caption" },
      },
      {
        channel: "linkedin",
        formatKey: "linkedin.post",
        included: true,
        adaptation: { topic: "LI topic", captionIdea: "LI caption" },
      },
      { channel: "ads", formatKey: "ads.campaign", included: false },
    ] as Target[],
    ...over,
  };
}

function setCard(card: unknown, over: Partial<Row> = {}) {
  row = {
    id: CMD,
    projectId: PROJECT,
    workId: WORK,
    replyText: "Here is the main message.",
    parsedIntent: { card, keep: "me" },
    ...over,
  };
}

function storedCard() {
  return (row.parsedIntent as { card: Record<string, unknown> }).card as {
    kind: string;
    state: string;
    via?: string;
    title: string;
    goal?: string;
    master?: { title: string; message: string; ideaId?: string };
    brandCheck?: unknown;
    savedCreativeIds?: string[];
    items: {
      date: string;
      time: string;
      channel: string;
      formatKey: string;
      topic: string;
      captionIdea: string;
      origin?: { kind: string; ref: string };
      brandFlags?: { severity: string }[];
    }[];
    targets?: Target[];
  };
}

const NEVER_RULES = {
  language: "en",
  never: [{ text: "discount", origin: "negative-brief" }],
  approvedClaims: [],
  competitors: [],
};

// The lead channel's slot unless a startFrom pushes it later.
function suggestFor(opts: { channel: string; startFrom?: string }) {
  const time = opts.channel === "linkedin" ? "12:00" : "10:00";
  return {
    timezone: TZ,
    slots: [{ date: opts.startFrom ?? "2026-10-02", time }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  chain = Promise.resolve();
  creativeCount = 0;

  mocks.isWorksEnabled.mockReturnValue(true);
  mocks.isRateLimited.mockReturnValue(false);
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws1",
    defaultBrandId: "b1",
  });
  mocks.workGet.mockResolvedValue(work());
  mocks.workTouch.mockResolvedValue(undefined);
  mocks.setChannels.mockResolvedValue(true);
  mocks.findIdea.mockResolvedValue({ id: "i1", status: "CONCEPT" });
  mocks.advance.mockResolvedValue("MEASURING");
  mocks.audit.mockResolvedValue({});
  mocks.ruleLanguageOf.mockResolvedValue("en");
  mocks.loadBrandRules.mockResolvedValue({
    language: "en",
    never: [],
    approvedClaims: [],
    competitors: [],
  });
  mocks.getProjectTimezone.mockResolvedValue(TZ);
  mocks.getChannelConnections.mockResolvedValue({
    instagram: { connected: true },
    linkedin: { connected: false },
  });
  mocks.loadSuggestedSlots.mockImplementation(
    async (_p: string, opts: { channel: string; startFrom?: string }) =>
      suggestFor(opts),
  );
  mocks.loadOccupiedSlots.mockResolvedValue([]);
  mocks.workFindFirst.mockResolvedValue({ status: "ACTIVE" });
  mocks.creativeCreate.mockImplementation(async () => {
    creativeCount += 1;
    return { id: `cr${creativeCount}` };
  });
  mocks.transaction.mockImplementation(
    (cb: (t: typeof tx) => Promise<unknown>) => {
      const result = chain.then(() => cb(tx));
      chain = result.catch(() => undefined);
      return result;
    },
  );
  mocks.commandFindUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      where.id === row.id ? row : null,
  );
  mocks.commandFindFirst.mockImplementation(
    async ({
      where,
    }: {
      where: { id: string; projectId: string; workId?: string };
    }) =>
      where.id === row.id &&
      where.projectId === row.projectId &&
      (where.workId === undefined || where.workId === row.workId)
        ? row
        : null,
  );
  setCard(masterCard());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("master-schedule: rewrites the same Command into a saved plan", () => {
  it("turns the card into a saved content-plan-draft with one item per ticked target", async () => {
    const result = await scheduleMasterAction(CMD);
    expect(result).toEqual({
      ok: true,
      commandId: CMD,
      slots: [
        {
          channel: "instagram",
          formatKey: "instagram.post",
          date: "2026-10-02",
          time: "10:00",
          creativeId: "cr1",
        },
        // One message is ONE post: every channel at the lead's time.
        {
          channel: "linkedin",
          formatKey: "linkedin.post",
          date: "2026-10-02",
          time: "10:00",
          creativeId: "cr2",
        },
      ],
    });

    // The SAME Command: no new row, no new card row.
    expect(mocks.commandCreate).not.toHaveBeenCalled();
    expect(tx.command.create).not.toHaveBeenCalled();
    expect(row.id).toBe(CMD);

    const card = storedCard();
    expect(card.kind).toBe("content-plan-draft");
    expect(card.state).toBe("saved");
    expect(card.via).toBe("master");
    expect(card.goal).toBe("awareness");
    expect(card.master).toEqual({
      title: "Autumn menu",
      message: "The new autumn menu is here.",
    });
    expect(card.savedCreativeIds).toEqual(["cr1", "cr2"]);
    expect(card.brandCheck).toEqual({ state: "checked", rules: 0 });
    // The post's idea is the master's title; each channel keeps its words.
    expect(card.items.map((i) => [i.channel, i.topic, i.captionIdea])).toEqual([
      ["instagram", "Autumn menu", "IG caption"],
      ["linkedin", "Autumn menu", "LI caption"],
    ]);
    // One origin per item: master:<commandId>.
    for (const item of card.items) {
      expect(item.origin).toEqual({ kind: "master", ref: CMD });
    }
    // Other keys of the row stay; the reply is a factual sentence.
    expect(row.parsedIntent?.keep).toBe("me");
    expect(row.replyText).toBe(
      'Added the main message "Autumn menu" to your calendar on Instagram and LinkedIn.',
    );
    expect(mocks.creativeCreate).toHaveBeenCalledTimes(2);
    expect(mocks.creativeCreate.mock.calls[0]?.[0]).toMatchObject({
      data: { planId: CMD, channel: "instagram", status: "DRAFT" },
    });
  });

  it("keeps an unticked ads target out, and takes it in only when ticked", async () => {
    await scheduleMasterAction(CMD);
    expect(storedCard().items.map((i) => i.channel)).not.toContain("ads");

    setCard(
      masterCard({
        targets: [
          ...masterCard().targets.slice(0, 2),
          { channel: "ads", formatKey: "ads.campaign", included: true },
        ],
      }),
    );
    creativeCount = 0;
    const result = await scheduleMasterAction(CMD);
    expect(result.ok).toBe(true);
    expect(
      storedCard()
        .items.map((i) => i.channel)
        .sort(),
    ).toEqual(["ads", "instagram", "linkedin"]);
  });

  it("falls back to the master text for a target that was never adapted", async () => {
    setCard(
      masterCard({
        state: "draft",
        targets: [
          { channel: "instagram", formatKey: "instagram.post", included: true },
        ],
      }),
    );
    const result = await scheduleMasterAction(CMD);
    expect(result.ok).toBe(true);
    expect(storedCard().items[0]).toMatchObject({
      topic: "Autumn menu",
      captionIdea: "The new autumn menu is here.",
    });
  });

  it("is idempotent: a replay finds the plan and returns its slots without writing", async () => {
    const first = await scheduleMasterAction(CMD);
    const afterFirst = JSON.stringify(row);
    mocks.creativeCreate.mockClear();
    mocks.audit.mockClear();
    const second = await scheduleMasterAction(CMD);
    expect(second).toEqual(first);
    expect(mocks.creativeCreate).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(JSON.stringify(row)).toBe(afterFirst);
  });

  it("two presses at once schedule once", async () => {
    const [a, b] = await Promise.all([
      scheduleMasterAction(CMD),
      scheduleMasterAction(CMD),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(mocks.creativeCreate).toHaveBeenCalledTimes(2);
    expect(a).toEqual(b);
  });

  it("touches the Work, audits, and advances a live seeding idea", async () => {
    setCard(
      masterCard({
        master: {
          title: "Autumn menu",
          message: "The new autumn menu is here.",
          ideaId: "i1",
        },
      }),
    );
    await scheduleMasterAction(CMD);
    expect(mocks.advance).toHaveBeenCalledWith("i1", PROJECT);
    expect(mocks.workTouch).toHaveBeenCalledWith(PROJECT, WORK, {
      summary: "Autumn menu",
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "master_content.scheduled",
        entityId: CMD,
        metadata: {
          channels: ["instagram", "linkedin"],
          dates: ["2026-10-02", "2026-10-02"],
        },
      }),
    );
    expect(storedCard().master?.ideaId).toBe("i1");
  });

  it("does not advance a rejected or archived seeding idea", async () => {
    mocks.findIdea.mockResolvedValue({ id: "i1", status: "ARCHIVED" });
    setCard(
      masterCard({
        master: { title: "Autumn menu", message: "m", ideaId: "i1" },
      }),
    );
    const result = await scheduleMasterAction(CMD);
    expect(result.ok).toBe(true);
    expect(mocks.advance).not.toHaveBeenCalled();
  });
});

describe("master-schedule: the slot the person saw", () => {
  it("uses a valid, free leadSlot for the whole post", async () => {
    const result = await scheduleMasterAction(CMD, {
      leadSlot: { date: "2026-10-05", time: "11:00" },
    });
    expect(result).toMatchObject({
      ok: true,
      slots: [
        { channel: "instagram", date: "2026-10-05", time: "11:00" },
        { channel: "linkedin", date: "2026-10-05", time: "11:00" },
      ],
    });
    expect(mocks.loadSuggestedSlots).not.toHaveBeenCalled();
  });

  it("without a leadSlot the lead gets the first suggestion", async () => {
    await scheduleMasterAction(CMD);
    expect(mocks.loadSuggestedSlots).toHaveBeenNthCalledWith(1, PROJECT, {
      channel: "instagram",
      count: 1,
    });
  });

  it("answers STALE with a fresh suggestion when the leadSlot passed, and writes nothing", async () => {
    const before = JSON.stringify(row);
    const result = await scheduleMasterAction(CMD, {
      leadSlot: { date: "2026-09-30", time: "11:00" },
    });
    expect(result).toEqual({
      ok: false,
      code: "STALE",
      message: "That day has already passed.",
      suggestion: { channel: "instagram", date: "2026-10-02", time: "10:00" },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(JSON.stringify(row)).toBe(before);
  });

  it("answers STALE for a leadSlot that is too soon", async () => {
    const result = await scheduleMasterAction(CMD, {
      // 12:30 local today: under the one hour lead time.
      leadSlot: { date: "2026-10-01", time: "12:30" },
    });
    expect(result).toMatchObject({ ok: false, code: "STALE" });
    expect(mocks.creativeCreate).not.toHaveBeenCalled();
  });

  it("answers STALE for a leadSlot somebody else took meanwhile", async () => {
    mocks.loadOccupiedSlots.mockResolvedValue([
      { date: "2026-10-05", time: "11:00", channel: "instagram" },
    ]);
    const result = await scheduleMasterAction(CMD, {
      leadSlot: { date: "2026-10-05", time: "11:00" },
    });
    expect(result).toMatchObject({
      ok: false,
      code: "STALE",
      suggestion: { channel: "instagram", date: "2026-10-02", time: "10:00" },
    });
    expect(mocks.creativeCreate).not.toHaveBeenCalled();
  });

  it("a slot taken on ANOTHER channel does not make the leadSlot stale", async () => {
    mocks.loadOccupiedSlots.mockResolvedValue([
      { date: "2026-10-05", time: "11:00", channel: "x" },
    ]);
    const result = await scheduleMasterAction(CMD, {
      leadSlot: { date: "2026-10-05", time: "11:00" },
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a malformed leadSlot (strict shape) without writing", async () => {
    for (const leadSlot of [
      { date: "2026-13-40", time: "11:00" },
      { date: "2026-10-05", time: "25:00" },
      { date: "2026-10-05", time: "9:00" },
      { date: "2027-12-05", time: "11:00" },
    ]) {
      const result = await scheduleMasterAction(CMD, { leadSlot });
      expect(result.ok).toBe(false);
    }
    expect(mocks.creativeCreate).not.toHaveBeenCalled();
    expect(storedCard().kind).toBe("master-content");
  });

  it("the lead is the first ticked CONNECTED social channel", async () => {
    mocks.getChannelConnections.mockResolvedValue({
      linkedin: { connected: true },
    });
    await scheduleMasterAction(CMD);
    // Only the lead's time is looked up: the post goes out together.
    expect(mocks.loadSuggestedSlots).toHaveBeenCalledTimes(1);
    expect(mocks.loadSuggestedSlots).toHaveBeenCalledWith(PROJECT, {
      channel: "linkedin",
      count: 1,
    });
  });

  it("puts every channel of the message on one post, at one time", async () => {
    setCard(
      masterCard({
        targets: [
          ...masterCard().targets.slice(0, 2),
          { channel: "x", formatKey: "x.post", included: true },
        ],
      }),
    );
    const result = await scheduleMasterAction(CMD);
    expect(result.ok).toBe(true);
    const times = storedCard().items.map((item) => `${item.date}T${item.time}`);
    expect(times).toHaveLength(3);
    expect(new Set(times).size).toBe(1);
  });

  it("fails visibly when no free slot exists", async () => {
    mocks.loadSuggestedSlots.mockResolvedValue({ timezone: TZ, slots: [] });
    const result = await scheduleMasterAction(CMD);
    expect(result).toMatchObject({
      ok: false,
      code: "FAILED",
      message: "No free time found. Pick a day in the calendar.",
    });
    expect(storedCard().kind).toBe("master-content");
  });
});

describe("master-schedule: refusals before any write", () => {
  it("DISABLED when Works is off, before any lookup", async () => {
    mocks.isWorksEnabled.mockReturnValue(false);
    const result = await scheduleMasterAction(CMD);
    expect(result).toMatchObject({ ok: false, code: "DISABLED" });
    expect(mocks.commandFindUnique).not.toHaveBeenCalled();
    expect(mocks.requireUser).not.toHaveBeenCalled();
  });

  it("NOT_FOUND for a bad id, a missing Command and a Command without a Work", async () => {
    expect(await scheduleMasterAction("")).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await scheduleMasterAction("nope")).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    setCard(masterCard(), { workId: null });
    expect(await scheduleMasterAction(CMD)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("NOT_FOUND (not a different answer) for a project the person cannot reach", async () => {
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    const result = await scheduleMasterAction(CMD);
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mocks.creativeCreate).not.toHaveBeenCalled();
  });

  it("takes the project from the Command row for access and the Work lookup", async () => {
    await scheduleMasterAction(CMD);
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith("u1", PROJECT);
    expect(mocks.workGet).toHaveBeenCalledWith(PROJECT, WORK);
  });

  it("RATE with the shared 'slots' bucket", async () => {
    mocks.isRateLimited.mockReturnValue(true);
    const result = await scheduleMasterAction(CMD);
    expect(result).toMatchObject({ ok: false, code: "RATE" });
    expect(mocks.isRateLimited).toHaveBeenCalledWith(
      "slots:u1",
      30,
      10 * 60_000,
    );
    expect(mocks.creativeCreate).not.toHaveBeenCalled();
  });

  it("WORK for a completed Work, with no write", async () => {
    mocks.workGet.mockResolvedValue(work({ status: "DONE" }));
    const before = JSON.stringify(row);
    const result = await scheduleMasterAction(CMD);
    expect(result).toEqual({
      ok: false,
      code: "WORK",
      message: "This Work is completed. Reopen it to continue.",
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.creativeCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(row)).toBe(before);
  });

  it("WORK when the Work was completed between the read and the transaction", async () => {
    mocks.workFindFirst.mockResolvedValue({ status: "DONE" });
    const before = JSON.stringify(row);
    const result = await scheduleMasterAction(CMD);
    expect(result).toMatchObject({ ok: false, code: "WORK" });
    expect(mocks.creativeCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(row)).toBe(before);
  });

  it("STATE for a superseded card or another kind", async () => {
    for (const card of [
      masterCard({ state: "superseded" }),
      { kind: "idea-options", title: "x", reason: "y", items: [] },
    ]) {
      setCard(card);
      expect(await scheduleMasterAction(CMD)).toMatchObject({
        ok: false,
        code: "STATE",
      });
    }
    expect(mocks.creativeCreate).not.toHaveBeenCalled();
  });

  it("NO_TARGETS when nothing is ticked", async () => {
    setCard(
      masterCard({
        targets: masterCard().targets.map((t) => ({ ...t, included: false })),
      }),
    );
    expect(await scheduleMasterAction(CMD)).toEqual({
      ok: false,
      code: "NO_TARGETS",
      message: "Tick at least one channel.",
    });
    expect(mocks.creativeCreate).not.toHaveBeenCalled();
  });

  it("refuses a format the catalog does not know", async () => {
    setCard(
      masterCard({
        targets: [
          { channel: "instagram", formatKey: "instagram.nope", included: true },
        ],
      }),
    );
    const result = await scheduleMasterAction(CMD);
    expect(result).toMatchObject({ ok: false, code: "FAILED" });
    expect(mocks.creativeCreate).not.toHaveBeenCalled();
  });
});

describe("master-schedule: brand rules and allowIssues", () => {
  beforeEach(() => {
    mocks.loadBrandRules.mockResolvedValue(NEVER_RULES);
    setCard(
      masterCard({
        targets: [
          {
            channel: "instagram",
            formatKey: "instagram.post",
            included: true,
            adaptation: {
              topic: "Autumn sale",
              captionIdea: "A big discount on the autumn menu",
            },
          },
          ...masterCard().targets.slice(1, 2),
        ],
      }),
    );
  });

  it("BRAND_RULES blocks without allowIssues and writes nothing", async () => {
    const before = JSON.stringify(row);
    const result = await scheduleMasterAction(CMD);
    expect(result).toEqual({
      ok: false,
      code: "BRAND_RULES",
      message: 'A brand rule stops this. Tap "Add anyway" to go ahead.',
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.creativeCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(row)).toBe(before);
  });

  it("checks the FALLBACK text too, not only adaptations", async () => {
    setCard(
      masterCard({
        state: "draft",
        master: { title: "Big discount", message: "A discount for you" },
        targets: [
          { channel: "instagram", formatKey: "instagram.post", included: true },
        ],
      }),
    );
    const result = await scheduleMasterAction(CMD);
    expect(result).toMatchObject({ ok: false, code: "BRAND_RULES" });
  });

  it("allowIssues goes ahead, flags the item and audits what was let through", async () => {
    const result = await scheduleMasterAction(CMD, { allowIssues: true });
    expect(result.ok).toBe(true);
    const [first, second] = storedCard().items;
    expect(first?.brandFlags?.[0]?.severity).toBe("block");
    expect(second?.brandFlags).toBeUndefined();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "master_content.scheduled",
        metadata: expect.objectContaining({
          allowIssues: true,
          matched: expect.arrayContaining([expect.any(String)]),
          userId: "u1",
        }),
      }),
    );
  });

  it("only a literal true counts as allowIssues", async () => {
    const result = await scheduleMasterAction(CMD, {
      allowIssues: "yes" as unknown as boolean,
    });
    expect(result).toMatchObject({ ok: false, code: "BRAND_RULES" });
  });
});

describe("master-schedule: concurrency", () => {
  it("answers BUSY on a write conflict (P2034)", async () => {
    mocks.transaction.mockRejectedValue(
      Object.assign(new Error("conflict"), { code: "P2034" }),
    );
    const result = await scheduleMasterAction(CMD);
    expect(result).toEqual({
      ok: false,
      code: "BUSY",
      message: "Already being saved.",
    });
  });

  it("answers BUSY, without a write, when a tick changed after the brand check", async () => {
    mocks.loadSuggestedSlots.mockImplementation(
      async (_p: string, opts: { channel: string; startFrom?: string }) => {
        // The person unticks linkedin while the slots are being chosen.
        // A fresh object, like a database round trip would give.
        const card = storedCard();
        row = {
          ...row,
          parsedIntent: {
            ...row.parsedIntent,
            card: {
              ...card,
              targets: card.targets?.map((t) =>
                t.channel === "linkedin" ? { ...t, included: false } : t,
              ),
            },
          },
        };
        return suggestFor(opts);
      },
    );
    const result = await scheduleMasterAction(CMD);
    expect(result).toMatchObject({ ok: false, code: "BUSY" });
    expect(mocks.creativeCreate).not.toHaveBeenCalled();
    expect(storedCard().kind).toBe("master-content");
  });

  it("writes the plan in ONE Serializable transaction (two presses cannot both commit)", async () => {
    const result = await scheduleMasterAction(CMD);
    expect(result).toMatchObject({ ok: true });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction.mock.calls[0]?.[1]).toEqual({
      isolationLevel: "Serializable",
    });
  });

  it("rolls back when the save core fails (nothing half-written is reported)", async () => {
    mocks.creativeCreate.mockRejectedValue(new Error("db down"));
    const result = await scheduleMasterAction(CMD);
    expect(result).toEqual({
      ok: false,
      code: "FAILED",
      message: "That didn't work. Try again.",
    });
  });
});

describe("toggleMasterTargetAction", () => {
  it("unticks and ticks a channel", async () => {
    expect(await toggleMasterTargetAction(CMD, "linkedin", false)).toEqual({
      ok: true,
      included: false,
    });
    expect(
      storedCard().targets?.find((t) => t.channel === "linkedin")?.included,
    ).toBe(false);
    expect(await toggleMasterTargetAction(CMD, "ads", true)).toEqual({
      ok: true,
      included: true,
    });
    expect(
      storedCard().targets?.find((t) => t.channel === "ads")?.included,
    ).toBe(true);
  });

  it("refuses to untick the last ticked channel", async () => {
    await toggleMasterTargetAction(CMD, "linkedin", false);
    const before = JSON.stringify(row);
    const result = await toggleMasterTargetAction(CMD, "instagram", false);
    expect(result).toEqual({
      ok: false,
      code: "NO_TARGETS",
      message: "Tick at least one channel.",
    });
    expect(JSON.stringify(row)).toBe(before);
  });

  it("refuses a channel that is not a target of the card", async () => {
    const before = JSON.stringify(row);
    const result = await toggleMasterTargetAction(CMD, "tiktok", true);
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(JSON.stringify(row)).toBe(before);
  });

  it("writes nothing when the value does not change", async () => {
    mocks.transaction.mockClear();
    const result = await toggleMasterTargetAction(CMD, "instagram", true);
    expect(result.ok).toBe(true);
    expect(tx.command.update).not.toHaveBeenCalled();
  });

  it("refuses a scheduled card (STATE) and a completed Work (WORK)", async () => {
    mocks.workFindFirst.mockResolvedValue({ status: "DONE" });
    expect(
      await toggleMasterTargetAction(CMD, "linkedin", false),
    ).toMatchObject({ ok: false, code: "WORK" });
    mocks.workFindFirst.mockResolvedValue({ status: "ACTIVE" });
    await scheduleMasterAction(CMD);
    expect(
      await toggleMasterTargetAction(CMD, "linkedin", false),
    ).toMatchObject({ ok: false, code: "STATE" });
  });

  it("is gated: flag, shape, scoping and rate", async () => {
    mocks.isWorksEnabled.mockReturnValue(false);
    expect(await toggleMasterTargetAction(CMD, "x", true)).toMatchObject({
      ok: false,
      code: "DISABLED",
    });
    mocks.isWorksEnabled.mockReturnValue(true);
    expect(
      await toggleMasterTargetAction(CMD, "x", "yes" as unknown as boolean),
    ).toMatchObject({ ok: false, code: "FAILED" });
    expect(await toggleMasterTargetAction("nope", "x", true)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    expect(await toggleMasterTargetAction(CMD, "x", true)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    mocks.requireProjectAccess.mockResolvedValue({
      workspaceId: "ws1",
      defaultBrandId: "b1",
    });
    mocks.isRateLimited.mockReturnValue(true);
    expect(await toggleMasterTargetAction(CMD, "x", true)).toMatchObject({
      ok: false,
      code: "RATE",
    });
  });
});

describe("addMasterChannelAction", () => {
  it("adds the channel to the Work (with the unconnected list) and a ticked target to the card", async () => {
    const result = await addMasterChannelAction(PROJECT, WORK, CMD, "tiktok");
    expect(result).toEqual({
      ok: true,
      channels: ["instagram", "linkedin", "x", "ads", "tiktok"],
    });
    expect(mocks.setChannels).toHaveBeenCalledWith(
      PROJECT,
      WORK,
      ["instagram", "linkedin", "x", "ads", "tiktok"],
      // Neither tiktok nor linkedin is connected; ads/x never need a connection.
      expect.arrayContaining(["tiktok", "linkedin"]),
    );
    expect(storedCard().targets?.at(-1)).toEqual({
      channel: "tiktok",
      formatKey: "tiktok.video",
      included: true,
    });
  });

  it("does not touch the Work when the channel is already in it, and ticks the target", async () => {
    const result = await addMasterChannelAction(PROJECT, WORK, CMD, "ads");
    expect(result.ok).toBe(true);
    expect(mocks.setChannels).not.toHaveBeenCalled();
    expect(
      storedCard().targets?.find((t) => t.channel === "ads")?.included,
    ).toBe(true);
  });

  it("is scoped: a card of another Work or project is NOT_FOUND and the Work is left alone", async () => {
    mocks.workGet.mockImplementation(async (_project: string, id: string) =>
      id === WORK ? work() : null,
    );
    expect(
      await addMasterChannelAction(PROJECT, "other-work", CMD, "tiktok"),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    mocks.workGet.mockResolvedValue(work({ id: "other-work" }));
    expect(
      await addMasterChannelAction(PROJECT, "other-work", CMD, "tiktok"),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mocks.commandFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CMD, projectId: PROJECT, workId: "other-work" },
      }),
    );
    expect(mocks.setChannels).not.toHaveBeenCalled();
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    expect(
      await addMasterChannelAction("p-foreign", WORK, CMD, "tiktok"),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mocks.setChannels).not.toHaveBeenCalled();
  });

  it("refuses an unknown channel, a completed Work and a scheduled card, before changing the Work", async () => {
    expect(
      await addMasterChannelAction(PROJECT, WORK, CMD, "email"),
    ).toMatchObject({ ok: false, code: "FAILED" });
    mocks.workGet.mockResolvedValue(work({ status: "DONE" }));
    expect(
      await addMasterChannelAction(PROJECT, WORK, CMD, "tiktok"),
    ).toMatchObject({ ok: false, code: "WORK" });
    mocks.workGet.mockResolvedValue(work());
    setCard({
      kind: "content-plan-draft",
      title: "x",
      timezone: TZ,
      state: "saved",
      items: [],
    });
    expect(
      await addMasterChannelAction(PROJECT, WORK, CMD, "tiktok"),
    ).toMatchObject({ ok: false, code: "STATE" });
    expect(mocks.setChannels).not.toHaveBeenCalled();
  });

  it("is gated by the flag and the rate bucket", async () => {
    mocks.isWorksEnabled.mockReturnValue(false);
    expect(
      await addMasterChannelAction(PROJECT, WORK, CMD, "tiktok"),
    ).toMatchObject({ ok: false, code: "DISABLED" });
    mocks.isWorksEnabled.mockReturnValue(true);
    mocks.isRateLimited.mockReturnValue(true);
    expect(
      await addMasterChannelAction(PROJECT, WORK, CMD, "tiktok"),
    ).toMatchObject({ ok: false, code: "RATE" });
    expect(mocks.setChannels).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard W98 (variants-materialize): a finished creative job with variant
// results creates one Asset per alternative, stores generationMetadata.
// alternatives and card.alternatives and opens exactly ONE Approval; a
// variantsOnly job ("Make 3 more") attaches its pictures to the piece already
// in review without claiming the slot or creating a stray Creative/Approval;
// a job without variant keys is untouched. Driven through pollOnce with an
// in-memory prisma (the real Neon database is never touched).

type Rec = Record<string, unknown>;

const db = vi.hoisted(() => {
  const state = {
    assets: [] as Rec[],
    creatives: new Map<string, Rec>(),
    versions: new Map<string, Rec>(),
    commands: [] as Rec[],
    tasks: new Map<string, Rec>(),
    job: {} as Rec,
    nextId: 1,
  };
  return state;
});

const worksOn = vi.hoisted(() => ({ value: true }));
const providerResult = vi.hoisted(() => ({ rawResult: {} as Rec }));

const approvalCreate = vi.fn();
const resolveCreativeCard = vi.fn();
const resolveWorkIdForTask = vi.fn();
const creativeCreate = vi.fn();
const creativeUpdateMany = vi.fn();

const id = (prefix: string) => `${prefix}-${db.nextId++}`;

const prismaFake = vi.hoisted(() => ({}) as Rec);

vi.mock("@/lib/prisma", () => ({ prisma: prismaFake }));
vi.mock("@/server/works/flag", () => ({
  isWorksEnabled: () => worksOn.value,
}));
vi.mock("@/server/execution/provider-registry", () => ({
  ProviderRegistry: {
    getByKey: () => ({
      key: "openai-creative",
      getStatus: async () => ({
        status: "COMPLETED",
        rawResult: providerResult.rawResult,
        isMock: false,
      }),
    }),
  },
}));
vi.mock("@/server/execution/capability-router", () => ({
  CapabilityRouter: {},
}));
vi.mock("@/server/repositories/outbox.repository", () => ({
  OUTBOX_EVENT_TYPES: {},
  OutboxRepository: {},
}));
vi.mock("@/server/repositories/human-intervention.repository", () => ({
  HumanInterventionRepository: {},
}));
vi.mock("@/server/repositories/execution-job.repository", () => ({
  ExecutionJobRepository: {},
}));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: vi.fn() },
}));
vi.mock("@/server/repositories/approval.repository", () => ({
  ApprovalRepository: { create: approvalCreate },
}));
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: { resolveCreativeCard, resolveWorkIdForTask },
}));

const { ExecutionService } =
  await import("@/server/execution/execution-service");

const imageOf = (n: number) => ({
  storageKey: `r2://img-${n}.png`,
  filename: `img-${n}.png`,
  mimeType: "image/png",
  size: 100 + n,
  provider: "openai",
  width: 1080,
  height: 1350,
});

function variantResult(alternativeCount: number, base = 1): Rec {
  return {
    caption: "cap",
    copy: "copy",
    image: imageOf(base),
    platform: "INSTAGRAM",
    contentFormat: "POST",
    alternatives: Array.from({ length: alternativeCount }, (_, i) => ({
      image: imageOf(base + i + 1),
      label: `Option ${i + 2}`,
    })),
  };
}

function seedCreative(creative: Rec, alternatives?: Rec[]) {
  db.creatives.set(creative.id as string, creative);
  if (alternatives) {
    db.versions.set(`${creative.id}:1`, {
      id: `${creative.id}-v1`,
      creativeId: creative.id,
      version: 1,
      generationMetadata: { caption: "cap", alternatives },
    });
  }
}

const altEntry = (n: number) => ({
  assetId: `existing-${n}`,
  index: n + 1,
  label: `Option ${n + 1}`,
});

function seedExistingAssets(count: number) {
  for (let n = 1; n <= count; n += 1) {
    db.assets.push({ id: `existing-${n}`, storageKey: `r2://old-${n}.png` });
  }
}

function setTaskPayload(payload: Rec | null) {
  db.tasks.set("task-1", {
    id: "task-1",
    status: "COMPLETED",
    title: "Post 1",
    departmentKey: null,
    payload,
  });
}

function installPrisma() {
  const matches = (rec: Rec, where: Rec) =>
    Object.entries(where).every(([k, v]) => rec[k] === v);
  Object.assign(prismaFake, {
    executionJob: {
      findUniqueOrThrow: async () => db.job,
      updateMany: async () => ({ count: 1 }),
    },
    task: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.tasks.get(where.id) ?? null,
    },
    brand: { findUnique: async () => ({ name: "Brand" }) },
    asset: {
      create: async ({ data }: { data: Rec }) => {
        const row = { id: id("asset"), ...data };
        db.assets.push(row);
        return row;
      },
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        db.assets.filter((a) => where.id.in.includes(a.id as string)),
    },
    creative: {
      updateMany: async (args: { where: Rec; data: Rec }) => {
        creativeUpdateMany(args);
        const row = db.creatives.get(args.where.id as string);
        if (
          !row ||
          row.projectId !== args.where.projectId ||
          row.status !== args.where.status ||
          row.currentVersionId !== args.where.currentVersionId
        ) {
          return { count: 0 };
        }
        Object.assign(row, args.data);
        return { count: 1 };
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.creatives.get(where.id) ?? null,
      findFirst: async ({ where }: { where: Rec }) => {
        const row = db.creatives.get(where.id as string);
        return row &&
          matches(row, { projectId: where.projectId, status: where.status })
          ? row
          : null;
      },
      create: async ({ data }: { data: Rec }) => {
        creativeCreate(data);
        const row = { id: id("creative-new"), currentVersionId: null, ...data };
        db.creatives.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
        Object.assign(db.creatives.get(where.id) as Rec, data);
        return db.creatives.get(where.id);
      },
    },
    creativeVersion: {
      create: async ({ data }: { data: Rec }) => {
        const row = { id: id("version"), ...data };
        db.versions.set(`${data.creativeId}:${data.version}`, row);
        return row;
      },
      findUnique: async ({
        where,
      }: {
        where: { creativeId_version: { creativeId: string; version: number } };
      }) =>
        db.versions.get(
          `${where.creativeId_version.creativeId}:${where.creativeId_version.version}`,
        ) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
        const row = [...db.versions.values()].find((v) => v.id === where.id);
        Object.assign(row as Rec, data);
        return row;
      },
    },
    command: {
      findFirst: async ({ where }: { where: { AND: Rec[] } }) => {
        const creativeId = where.AND[0]?.cardCreativeId;
        return (
          db.commands.find(
            (c) =>
              ((c.parsedIntent as Rec).card as Rec).creativeId === creativeId,
          ) ?? null
        );
      },
      update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
        Object.assign(db.commands.find((c) => c.id === where.id) as Rec, data);
      },
      updateMany: async ({ where, data }: { where: Rec; data: Rec }) => {
        const taskId = where.cardTaskId;
        for (const c of db.commands) {
          if (
            ((c.parsedIntent as Rec)?.card as Rec | undefined)?.taskId ===
            taskId
          ) {
            Object.assign(c, data);
          }
        }
        return { count: 1 };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(prismaFake),
  });
}

async function runJob(rawResult: Rec) {
  providerResult.rawResult = rawResult;
  await ExecutionService.pollOnce("job-1");
}

const assetAt = (i: number) => db.assets[i] as Rec;
const commandAt = (i: number) => db.commands[i] as Rec;
const firstVersion = () => [...db.versions.values()][0] as Rec;

const lastCard = () =>
  (resolveCreativeCard.mock.calls.at(-1)?.[0] as { card: Rec } | undefined)
    ?.card;

beforeEach(() => {
  vi.clearAllMocks();
  db.assets = [];
  db.creatives = new Map();
  db.versions = new Map();
  db.commands = [];
  db.tasks = new Map();
  db.nextId = 1;
  db.job = {
    id: "job-1",
    workspaceId: "ws-1",
    projectId: "p-1",
    brandId: "b-1",
    taskId: "task-1",
    capability: "CREATE_SOCIAL_CREATIVE",
    providerId: "openai-creative",
    providerExecutionReference: "ref-1",
    status: "RUNNING",
    completedAt: null,
  };
  worksOn.value = true;
  setTaskPayload({ request: "brief" });
  approvalCreate.mockResolvedValue({ id: "approval-1" });
  resolveCreativeCard.mockResolvedValue(undefined);
  resolveWorkIdForTask.mockResolvedValue(null);
  installPrisma();
});

describe("materialize with variant alternatives", () => {
  it("creates one Asset per picture, stores the normalised alternatives and puts them on the card", async () => {
    await runJob(variantResult(2));

    expect(db.assets).toHaveLength(3);
    expect(db.assets.map((a) => a.storageKey)).toEqual([
      "r2://img-1.png",
      "r2://img-2.png",
      "r2://img-3.png",
    ]);
    const version = firstVersion();
    const meta = version.generationMetadata as {
      alternatives: Rec[];
      image: Rec;
    };
    expect(meta.alternatives).toEqual([
      {
        assetId: assetAt(1).id,
        index: 2,
        label: "Option 2",
        width: 1080,
        height: 1350,
        assetWidth: 1080,
        assetHeight: 1350,
      },
      {
        assetId: assetAt(2).id,
        index: 3,
        label: "Option 3",
        width: 1080,
        height: 1350,
        assetWidth: 1080,
        assetHeight: 1350,
      },
    ]);
    // The raw render objects (storage keys) are never stored as alternatives.
    expect(JSON.stringify(meta.alternatives)).not.toContain("r2://");
    expect(version.assetId).toBe(assetAt(0).id);
    expect(lastCard()?.alternatives).toEqual([
      {
        assetId: assetAt(1).id,
        label: "Option 2",
        assetWidth: 1080,
        assetHeight: 1350,
      },
      {
        assetId: assetAt(2).id,
        label: "Option 3",
        assetWidth: 1080,
        assetHeight: 1350,
      },
    ]);
    expect(lastCard()?.assetId).toBe(assetAt(0).id);
  });

  it("opens exactly one Creative, one Approval and one card", async () => {
    await runJob(variantResult(2));

    expect(creativeCreate).toHaveBeenCalledTimes(1);
    expect(approvalCreate).toHaveBeenCalledTimes(1);
    expect(resolveCreativeCard).toHaveBeenCalledTimes(1);
    expect(db.versions.size).toBe(1);
  });

  it("fills the plan slot as before and still stores the alternatives", async () => {
    seedCreative({
      id: "slot-1",
      projectId: "p-1",
      status: "DRAFT",
      currentVersionId: null,
      platform: "INSTAGRAM",
    });
    setTaskPayload({ planCreativeId: "slot-1", variantCount: 3 });

    await runJob(variantResult(2));

    expect(creativeCreate).not.toHaveBeenCalled();
    expect(db.creatives.get("slot-1")?.status).toBe("IN_REVIEW");
    const meta = db.versions.get("slot-1:1")?.generationMetadata as {
      alternatives: Rec[];
    };
    expect(meta.alternatives).toHaveLength(2);
    expect(approvalCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps no alternatives on the card when none survived", async () => {
    await runJob(variantResult(0));

    expect(db.assets).toHaveLength(1);
    expect(lastCard()).not.toHaveProperty("alternatives");
    const meta = firstVersion().generationMetadata as Rec;
    expect(meta.alternatives).toEqual([]);
  });
});

describe("materialize without variant keys (parity)", () => {
  it("makes one Asset, stores the result untouched and writes no alternatives anywhere", async () => {
    worksOn.value = false;
    const result = {
      caption: "cap",
      copy: "copy",
      image: imageOf(1),
      platform: "INSTAGRAM",
    };

    await runJob(result);

    expect(db.assets).toHaveLength(1);
    expect(firstVersion().generationMetadata).toEqual(result);
    expect(lastCard()).not.toHaveProperty("alternatives");
    expect(creativeCreate).toHaveBeenCalledTimes(1);
    expect(approvalCreate).toHaveBeenCalledTimes(1);
  });

  it("with Works off never reads the task for the variantsOnly check or looks up a Work", async () => {
    worksOn.value = false;
    const taskRead = vi.spyOn(
      prismaFake.task as { findUnique: (a: unknown) => Promise<unknown> },
      "findUnique",
    );

    await runJob({ caption: "c", copy: "c", image: imageOf(1) });

    // claim + card title + the terminal task sync: none of them is ours.
    expect(taskRead.mock.calls.length).toBeLessThanOrEqual(3);
    expect(resolveWorkIdForTask).not.toHaveBeenCalled();
  });
});

describe("variantsOnly job ('Make 3 more')", () => {
  beforeEach(() => {
    setTaskPayload({
      planCreativeId: "piece-1",
      variantCount: 3,
      variantsOnly: true,
    });
    seedCreative(
      {
        id: "piece-1",
        projectId: "p-1",
        status: "IN_REVIEW",
        currentVersionId: "piece-1-v1",
      },
      [],
    );
    db.commands.push({
      id: "cmd-ready",
      parsedIntent: {
        card: {
          kind: "creative-ready",
          creativeId: "piece-1",
          taskId: "task-0",
        },
      },
    });
    db.commands.push({
      id: "cmd-loading",
      parsedIntent: { card: { kind: "creative-loading", taskId: "task-1" } },
    });
  });

  const stored = () =>
    (
      db.versions.get("piece-1:1")?.generationMetadata as {
        alternatives: Rec[];
      }
    ).alternatives;

  it("attaches the new pictures without claiming the slot or creating a Creative or an Approval", async () => {
    await runJob(variantResult(2, 10));

    expect(creativeUpdateMany).not.toHaveBeenCalled();
    expect(creativeCreate).not.toHaveBeenCalled();
    expect(approvalCreate).not.toHaveBeenCalled();
    expect(resolveCreativeCard).not.toHaveBeenCalled();
    expect(db.versions.size).toBe(1);
    // main + 2 alternatives of the new run all become alternatives.
    expect(stored().map((e) => e.index)).toEqual([2, 3, 4]);
    expect(db.assets.map((a) => a.storageKey)).toEqual([
      "r2://img-10.png",
      "r2://img-11.png",
      "r2://img-12.png",
    ]);
  });

  it("patches the piece's creative-ready card and turns the generating card into a note", async () => {
    await runJob(variantResult(2, 10));

    const ready = commandAt(0).parsedIntent as { card: Rec };
    expect((ready.card.alternatives as Rec[]).map((a) => a.assetId)).toEqual(
      stored().map((e) => e.assetId),
    );
    expect(ready.card.kind).toBe("creative-ready");
    const loading = commandAt(1);
    expect(loading.parsedIntent).toEqual({});
    expect(loading.replyText).toContain("3 more options");
  });

  it("keeps the card's swapped picture set after an adopt: no repeat of the current picture, no lost picture", async () => {
    seedExistingAssets(2);
    seedCreative(
      {
        id: "piece-1",
        projectId: "p-1",
        status: "IN_REVIEW",
        currentVersionId: "piece-1-v3",
      },
      [1, 2].map(altEntry),
    );
    // The piece was adopted from a0 to existing-1: the card shows
    // current existing-1, alternatives a0 + existing-2.
    (commandAt(0).parsedIntent as { card: Rec }).card = {
      kind: "creative-ready",
      creativeId: "piece-1",
      taskId: "task-0",
      assetId: "existing-1",
      alternatives: [{ assetId: "a0" }, { assetId: "existing-2" }],
    };

    await runJob(variantResult(2, 10));

    const ready = commandAt(0).parsedIntent as { card: Rec };
    const ids = (ready.card.alternatives as Rec[]).map((a) => a.assetId);
    expect(ids.slice(0, 2)).toEqual(["a0", "existing-2"]);
    expect(ids).not.toContain("existing-1");
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(5);
  });

  it("takes only as many pictures as still fit under the cap of 5", async () => {
    seedExistingAssets(4);
    seedCreative(
      {
        id: "piece-1",
        projectId: "p-1",
        status: "IN_REVIEW",
        currentVersionId: "piece-1-v1",
      },
      [1, 2, 3, 4].map(altEntry),
    );

    await runJob(variantResult(2, 10));

    expect(stored()).toHaveLength(5);
    expect(
      db.assets.filter((a) => String(a.id).startsWith("asset-")),
    ).toHaveLength(1);
  });

  it("adds nothing at the cap", async () => {
    seedExistingAssets(5);
    seedCreative(
      {
        id: "piece-1",
        projectId: "p-1",
        status: "IN_REVIEW",
        currentVersionId: "piece-1-v1",
      },
      [1, 2, 3, 4, 5].map(altEntry),
    );

    await runJob(variantResult(2, 10));

    expect(stored()).toHaveLength(5);
    expect(
      db.assets.filter((a) => String(a.id).startsWith("asset-")),
    ).toHaveLength(0);
  });

  it("a replayed job appends nothing twice", async () => {
    await runJob(variantResult(2, 10));
    await runJob(variantResult(2, 10));

    expect(stored()).toHaveLength(3);
    expect(db.assets).toHaveLength(3);
  });

  it("drops the pictures with a warning, and still makes no stray Creative, when the piece is gone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    db.creatives.get("piece-1")!.status = "APPROVED";

    await runJob(variantResult(2, 10));

    expect(creativeCreate).not.toHaveBeenCalled();
    expect(approvalCreate).not.toHaveBeenCalled();
    expect(db.assets).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("variantsOnly job job-1"),
    );
    warn.mockRestore();
  });

  it("is also caught when the provider result carries no alternatives key (Works on)", async () => {
    await runJob({ caption: "c", copy: "c", image: imageOf(20) });

    expect(creativeCreate).not.toHaveBeenCalled();
    expect(approvalCreate).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(1);
  });
});

describe("a slot job that loses its claim (safety net)", () => {
  beforeEach(() => {
    // The slot is no longer an empty DRAFT: the claim returns null.
    seedCreative({
      id: "slot-1",
      projectId: "p-1",
      status: "IN_REVIEW",
      currentVersionId: "v-x",
    });
    setTaskPayload({ planCreativeId: "slot-1" });
  });

  it("keeps today's fallback Creative and warns when the Task's Command has a workId", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resolveWorkIdForTask.mockResolvedValue("work-1");

    await runJob({ caption: "c", copy: "c", image: imageOf(1) });

    expect(creativeCreate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("work-1"));
    warn.mockRestore();
  });

  it("stays silent without a workId", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await runJob({ caption: "c", copy: "c", image: imageOf(1) });

    expect(creativeCreate).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not even look for a Work when Works is off", async () => {
    worksOn.value = false;

    await runJob({ caption: "c", copy: "c", image: imageOf(1) });

    expect(creativeCreate).toHaveBeenCalledTimes(1);
    expect(resolveWorkIdForTask).not.toHaveBeenCalled();
  });
});

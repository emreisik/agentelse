import { beforeEach, describe, expect, it, vi } from "vitest";

// A generated logo is a picture the plan pays for: one image right
// (docs/billing-tasks.md). The right is held before anything is drawn, the picture
// is drawn inside the operation's scope (so the operation's meter sees it), and the
// right is charged only when the logo was stored.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  RedirectType: { push: "push", replace: "replace" },
}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/env", () => ({ getEnv: vi.fn(() => ({})) }));

const requireUser = vi.hoisted(() => vi.fn());
const requireProjectAccess = vi.hoisted(() => vi.fn());
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));

const prismaMock = vi.hoisted(() => ({
  project: { findUniqueOrThrow: vi.fn() },
  brandDossier: { findUnique: vi.fn(), upsert: vi.fn() },
  asset: { create: vi.fn() },
  workspaceMember: { findFirstOrThrow: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Pulled in by the other actions of the module; none of them runs here.
vi.mock("@/server/billing/brand-limit", () => ({
  createProjectWithinBrandLimit: vi.fn(),
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn() },
}));
vi.mock("@/server/projects/activation", () => ({
  ensureProjectActive: vi.fn(),
}));
vi.mock("@/server/brand/intake-start", () => ({
  startIntakeAtCreate: vi.fn(),
}));

const begin = vi.hoisted(() => vi.fn());
vi.mock("@/server/billing/operation", () => ({ beginOperation: begin }));

const generateCreativeImage = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/creative-image", () => ({ generateCreativeImage }));
const storage = vi.hoisted(() => ({ putAsset: vi.fn(), readAsset: vi.fn() }));
vi.mock("@/server/storage/asset-storage", () => storage);
const normalizeLogoUpload = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/logo-clean", () => ({ normalizeLogoUpload }));

import type { OperationSpec } from "@/server/billing/operation";
import { NoPlanError, QuotaExceededError } from "@/server/billing/quota-errors";
import {
  getUsageScope,
  runWithUsageScope,
} from "@/server/billing/usage-context";
import type { UsageScope } from "@/server/billing/usage-context";
import { UsageMeter } from "@/server/billing/usage-meter";

const { generateLogoAction } = await import("./project-actions");

// An operation as beginOperation hands it out: a real meter, and a run() that does
// what Operation.run does (runs the work in a scope carrying that meter).
function fakeOperation(spec: OperationSpec) {
  const meter = new UsageMeter({
    workspaceId: spec.workspaceId,
    operationId: spec.operationId,
  });
  return {
    meter,
    run: vi.fn(<T>(fn: () => T): T =>
      runWithUsageScope(
        {
          workspaceId: spec.workspaceId,
          operationId: spec.operationId,
          meter,
        },
        fn,
      ),
    ),
    finish: vi.fn(async () => undefined),
  };
}

let operation: ReturnType<typeof fakeOperation> | undefined;

const GENERATED = {
  storageKey: "r2://drawn.png",
  filename: "drawn.png",
  mimeType: "image/png",
  size: 1234,
  provider: "openai" as const,
  width: 1024,
  height: 1024,
};

function logoForm(variant?: "dark"): FormData {
  const form = new FormData();
  form.set("projectId", "p1");
  if (variant) form.set("variant", variant);
  return form;
}

// What the picture generator saw of the usage scope when it was called.
let scopeSeen: UsageScope | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  operation = undefined;
  scopeSeen = undefined;
  requireUser.mockResolvedValue({ userId: "u1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    defaultBrandId: "brand-1",
  });
  prismaMock.project.findUniqueOrThrow.mockResolvedValue({ name: "Acme" });
  prismaMock.brandDossier.findUnique.mockResolvedValue(null);
  prismaMock.brandDossier.upsert.mockResolvedValue({});
  prismaMock.asset.create.mockResolvedValue({ id: "asset-1" });
  storage.readAsset.mockResolvedValue(Buffer.from("raw"));
  storage.putAsset.mockResolvedValue({
    storageKey: "r2://logo.png",
    filename: "logo.png",
  });
  normalizeLogoUpload.mockResolvedValue({
    png: Buffer.from("png"),
    width: 64,
    height: 64,
  });
  begin.mockReset();
  begin.mockImplementation(async (spec: OperationSpec) => {
    operation = fakeOperation(spec);
    return operation;
  });
  generateCreativeImage.mockReset();
  generateCreativeImage.mockImplementation(async () => {
    scopeSeen = getUsageScope();
    return GENERATED;
  });
});

describe("generateLogoAction plan allowance", () => {
  it("holds exactly one image right and a valid plan, and does so before anything is drawn", async () => {
    await generateLogoAction(logoForm());

    expect(begin).toHaveBeenCalledTimes(1);
    expect(begin.mock.calls[0]![0]).toMatchObject({
      workspaceId: "ws-1",
      projectId: "p1",
      userId: "u1",
      module: "SOCIAL",
      source: "action",
      purpose: "logo.generate",
      reserve: { IMAGE: 1 },
      requireAccess: true,
    });
    // toMatchObject above is a subset match: it would let an AI budget reservation
    // ride along next to the picture. A logo is exactly one image right, nothing else.
    expect((begin.mock.calls[0]![0] as OperationSpec).reserve).toEqual({
      IMAGE: 1,
    });
    expect(begin.mock.invocationCallOrder[0]!).toBeLessThan(
      generateCreativeImage.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    [
      "the image credits are used up",
      new QuotaExceededError({
        unit: "IMAGE",
        needed: 1,
        available: 0,
        resetsAt: null,
      }),
    ],
    ["the workspace has no plan", new NoPlanError("NO_SUBSCRIPTION")],
  ])("draws nothing and returns quietly when %s", async (_label, refusal) => {
    begin.mockRejectedValue(refusal);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(generateLogoAction(logoForm())).resolves.toBeUndefined();

    expect(generateCreativeImage).not.toHaveBeenCalled();
    expect(storage.putAsset).not.toHaveBeenCalled();
    expect(prismaMock.asset.create).not.toHaveBeenCalled();
    expect(prismaMock.brandDossier.upsert).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    // The refusal is logged for the operator; the card just shows nothing new.
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("does not swallow a failure of the gate itself", async () => {
    begin.mockRejectedValue(new Error("ledger exploded"));

    await expect(generateLogoAction(logoForm())).rejects.toThrow(
      "ledger exploded",
    );
    expect(generateCreativeImage).not.toHaveBeenCalled();
  });

  it("hands the right back when the generator draws nothing, and stores nothing", async () => {
    generateCreativeImage.mockResolvedValue(null);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(generateLogoAction(logoForm())).resolves.toBeUndefined();
    log.mockRestore();

    expect(operation!.finish).toHaveBeenCalledTimes(1);
    expect(operation!.finish).toHaveBeenCalledWith("failed");
    expect(storage.readAsset).not.toHaveBeenCalled();
    expect(storage.putAsset).not.toHaveBeenCalled();
    expect(prismaMock.asset.create).not.toHaveBeenCalled();
    expect(prismaMock.brandDossier.upsert).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("hands the right back when the generator blows up, and lets the error out", async () => {
    generateCreativeImage.mockRejectedValue(new Error("model exploded"));

    await expect(generateLogoAction(logoForm())).rejects.toThrow(
      "model exploded",
    );

    expect(operation!.finish).toHaveBeenCalledTimes(1);
    expect(operation!.finish).toHaveBeenCalledWith("aborted");
    expect(prismaMock.asset.create).not.toHaveBeenCalled();
    expect(prismaMock.brandDossier.upsert).not.toHaveBeenCalled();
  });

  it("hands the right back when the logo could not be stored", async () => {
    prismaMock.asset.create.mockRejectedValue(new Error("db down"));

    await expect(generateLogoAction(logoForm())).rejects.toThrow("db down");

    expect(operation!.finish).toHaveBeenCalledTimes(1);
    expect(operation!.finish).toHaveBeenCalledWith("aborted");
    expect(prismaMock.brandDossier.upsert).not.toHaveBeenCalled();
  });

  it("charges the right once the logo is stored", async () => {
    await generateLogoAction(logoForm());

    expect(prismaMock.asset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "p1",
        brandId: "brand-1",
        type: "LOGO",
        source: "AI_GENERATED",
        storageKey: "r2://logo.png",
      }),
    });
    expect(prismaMock.brandDossier.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { logoAssetId: "asset-1" },
      }),
    );
    expect(operation!.finish).toHaveBeenCalledTimes(1);
    expect(operation!.finish).toHaveBeenCalledWith("delivered");
    expect(revalidatePath).toHaveBeenCalledWith("/projects/p1");
  });

  it("draws the logo inside the operation's scope, so the operation's meter sees the picture", async () => {
    await generateLogoAction(logoForm());

    expect(operation!.run).toHaveBeenCalledTimes(1);
    expect(scopeSeen?.meter).toBe(operation!.meter);
    expect(scopeSeen?.workspaceId).toBe("ws-1");
    // Outside the operation there is no scope, so nothing leaks past it.
    expect(getUsageScope()).toBeUndefined();
  });
});

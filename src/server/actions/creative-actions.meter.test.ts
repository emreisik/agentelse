import { beforeEach, describe, expect, it, vi } from "vitest";

// A revision's picture is billed from the operation's meter (billing/operation.ts
// charges the pictures the meter counted). The meter only sees a paid call that
// runs in a usage scope carrying it, which performCreativeRevision builds by hand.
// creative-actions.allowance.test.ts mocks the operation away and never looks at
// that scope, so without this suite the line that hands the meter to the scope
// could go and every paid revision would be free.

const prismaMock = vi.hoisted(() => ({
  creative: { findUniqueOrThrow: vi.fn() },
  asset: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  creativeVersion: { findMany: vi.fn() },
  brandMedia: { findUnique: vi.fn() },
  task: { findUnique: vi.fn() },
  brand: { findUnique: vi.fn() },
  brandDossier: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: vi.fn().mockResolvedValue({ userId: "u1" }),
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
}));
const addVersion = vi.hoisted(() => vi.fn());
vi.mock("@/server/repositories/creative.repository", () => ({
  CreativeRepository: { addVersion, transition: vi.fn() },
}));
vi.mock("@/server/repositories/approval.repository", () => ({
  ApprovalRepository: { create: vi.fn() },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn() },
}));
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: {
    resolveIdeaIdForTask: vi.fn(),
    postSystemMessage: vi.fn(),
  },
}));
const generateCreativeImage = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/creative-image", () => ({ generateCreativeImage }));
const applyBrandTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/creative-template", () => ({ applyBrandTemplate }));
const directImage = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/art-director", () => ({ directImage }));
vi.mock("@/server/media/brand-logo", () => ({
  loadReferenceImage: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: { getBrandContext: vi.fn().mockResolvedValue({}) },
}));
const resolveBrandStyleContext = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/brand-style-context", () => ({
  resolveBrandStyleContext,
}));
const storage = vi.hoisted(() => ({
  readAsset: vi.fn(),
  putAsset: vi.fn(),
  overwriteAsset: vi.fn(),
}));
vi.mock("@/server/storage/asset-storage", () => storage);

// The plan-allowance operation of one revision: beginOperation is a double, but
// the operation it hands out holds a REAL meter.
const allowance = vi.hoisted(() => ({ begin: vi.fn(), finish: vi.fn() }));
vi.mock("@/server/billing/operation", () => ({
  beginOperation: allowance.begin,
}));

// With billing on a revision also takes a per-post lock and reads the post's
// history to price the revision: both are doubles, the scope is built either way.
const billing = vi.hoisted(() => ({ mode: "off" as "off" | "enforce" }));
vi.mock("@/server/billing/config", () => ({
  getBillingConfig: () => ({
    mode: billing.mode,
    legacyBefore: null,
    legacyUntil: null,
  }),
}));
vi.mock("@/server/billing/lease", () => ({
  acquireLease: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
}));

import type { OperationSpec } from "@/server/billing/operation";
import { getUsageScope, type UsageScope } from "@/server/billing/usage-context";
import { UsageMeter } from "@/server/billing/usage-meter";

const { performCreativeRevision } = await import("./creative-actions");

let meter: UsageMeter | undefined;
// What each paid step saw of the usage scope when it ran.
const seen: { art?: UsageScope; picture?: UsageScope } = {};

beforeEach(() => {
  vi.clearAllMocks();
  billing.mode = "off";
  meter = undefined;
  seen.art = undefined;
  seen.picture = undefined;
  storage.readAsset.mockResolvedValue(Buffer.from("raw"));
  storage.putAsset.mockResolvedValue({
    storageKey: "r2://cut.jpg",
    filename: "cut.jpg",
  });
  prismaMock.asset.findFirst.mockResolvedValue(null);
  prismaMock.asset.findUnique.mockResolvedValue({
    storageKey: "k",
    mimeType: "image/png",
  });
  prismaMock.asset.create.mockResolvedValue({
    id: "asset-2",
    mimeType: "image/png",
    width: 1080,
    height: 1440,
  });
  prismaMock.creativeVersion.findMany.mockResolvedValue([]);
  prismaMock.brandMedia.findUnique.mockResolvedValue(null);
  prismaMock.brandDossier.findUnique.mockResolvedValue(null);
  applyBrandTemplate.mockResolvedValue(null);
  addVersion.mockResolvedValue({ version: 2 });
  directImage.mockReset();
  directImage.mockImplementation(async () => {
    seen.art = getUsageScope();
    return null;
  });
  generateCreativeImage.mockReset();
  generateCreativeImage.mockImplementation(async () => {
    seen.picture = getUsageScope();
    return {
      storageKey: "r2://ai.png",
      filename: "ai.png",
      mimeType: "image/png",
      size: 1,
      provider: "openai",
      width: 1080,
      height: 1440,
    };
  });
  resolveBrandStyleContext.mockResolvedValue({
    logoAssetId: null,
    darkLogoAssetId: null,
    legacyApprovedColors: null,
    legacyVisualGuidelines: null,
    visualIdentity: null,
  });
  allowance.begin.mockReset();
  allowance.finish.mockReset();
  allowance.begin.mockImplementation(async (spec: OperationSpec) => {
    meter = new UsageMeter({
      workspaceId: spec.workspaceId,
      operationId: spec.operationId,
    });
    return { meter, finish: allowance.finish };
  });
});

function revise(mode: "new" | "edit") {
  prismaMock.creative.findUniqueOrThrow.mockResolvedValue({
    id: "cr1",
    workspaceId: "w",
    projectId: "p",
    brandId: "b",
    platform: "INSTAGRAM",
    status: "IN_REVIEW",
    title: "Post",
    brief: "brief",
    createdByTaskId: null,
    versions: [
      {
        version: 3,
        assetId: "asset-1",
        caption: "c",
        copy: "x",
        generationMetadata: {},
      },
    ],
  });
  return performCreativeRevision({
    creativeId: "cr1",
    instruction: "",
    mode,
    userId: "u1",
  });
}

const operationId = () =>
  (allowance.begin.mock.calls[0]![0] as OperationSpec).operationId;

describe.each(["off", "enforce"] as const)(
  "the usage scope of a revision (billing %s)",
  (mode) => {
    beforeEach(() => {
      billing.mode = mode;
    });

    it.each(["new", "edit"] as const)(
      "draws the picture (%s) inside a scope that carries the operation's meter",
      async (revisionMode) => {
        await expect(revise(revisionMode)).resolves.toEqual({ ok: true });

        expect(meter).toBeDefined();
        expect(seen.picture?.meter).toBe(meter);
        expect(seen.picture).toMatchObject({
          workspaceId: "w",
          projectId: "p",
          userId: "u1",
          module: "SOCIAL",
          source: "action",
          purpose: "creative.regenerate",
          // The same operation the right was held for, so the usage rows and the
          // reservation can be matched up.
          operationId: operationId(),
        });
        expect(allowance.finish).toHaveBeenCalledWith("delivered");
        // The variant really ran in its billing mode: only with billing on is the
        // post's history read to price the revision.
        expect(prismaMock.creativeVersion.findMany).toHaveBeenCalledTimes(
          mode === "enforce" ? 1 : 0,
        );
      },
    );

    it("runs the art direction in the same scope: it is paid text of the same operation", async () => {
      await revise("new");

      expect(directImage).toHaveBeenCalledTimes(1);
      expect(meter).toBeDefined();
      expect(seen.art?.meter).toBe(meter);
      expect(seen.art?.operationId).toBe(operationId());
    });
  },
);

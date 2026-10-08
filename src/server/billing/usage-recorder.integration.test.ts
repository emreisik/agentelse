import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
// vitest.setup.ts turns the recorder into a no-op for every suite; this one
// needs the real thing against a real database.
vi.unmock("@/server/billing/usage-recorder");

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { ProjectDeletionService } from "@/server/projects/project-deletion.service";
import { describeIntegration } from "@/test-support/integration-suite";

import { runWithUsageScope } from "./usage-context";
import { recordUsage } from "./usage-recorder";

// The billing ledger against real Postgres (CI only; never the shared Neon
// database): the migration matches the model, a row round-trips with its
// BigInt cost, a repeated callId is written once, and — the trap that motivated
// the column name — the real ProjectDeletionService, which wipes every table
// with a `projectId` column, leaves the cost history of a deleted brand intact.
describeIntegration("usage ledger (UsageEntry) vs. real database", () => {
  const runId = randomUUID().slice(0, 8);
  let fixture: AgencyFixture;

  beforeAll(async () => {
    fixture = await createAgencyFixture(`usage-${runId}`);
  }, 60_000);

  afterAll(async () => {
    if (fixture?.workspaceId) {
      await prisma.usageEntry.deleteMany({
        where: { workspaceId: fixture.workspaceId },
      });
    }
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("writes a row with the ambient scope and reads the micro-dollar cost back", async () => {
    await runWithUsageScope(
      {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        userId: `user-${runId}`,
        source: "reasoning",
        purpose: "seo.article",
        operationId: `op-${runId}`,
      },
      () =>
        recordUsage({
          kind: "TEXT",
          provider: "openai",
          model: "gpt-5.6-luna",
          costUsd: 0.0123456,
          costEstimated: false,
          success: true,
          durationMs: 900,
          inputTokens: 1200,
          outputTokens: 300,
          cachedTokens: 400,
        }),
    );

    const row = await prisma.usageEntry.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, operationId: `op-${runId}` },
    });
    expect(row.costMicros).toBe(BigInt(12346));
    expect(row).toMatchObject({
      projectRef: fixture.projectId,
      module: "SEO",
      kind: "TEXT",
      provider: "openai",
      cachedTokens: 400,
      success: true,
      costEstimated: false,
    });
  });

  it("writes a repeated callId once and does not throw", async () => {
    const callId = `call-${runId}`;
    const input = {
      kind: "IMAGE" as const,
      provider: "openai" as const,
      model: "gpt-image-2/medium",
      costUsd: 0.05,
      costEstimated: false,
      success: true,
      durationMs: 5000,
      units: 1,
      callId,
      scope: { workspaceId: fixture.workspaceId },
    };
    await recordUsage(input);
    await expect(recordUsage(input)).resolves.toBeUndefined();

    expect(await prisma.usageEntry.count({ where: { callId } })).toBe(1);
  });

  it("keeps the cost history when the real ProjectDeletionService deletes the brand", async () => {
    const before = await prisma.usageEntry.count({
      where: { workspaceId: fixture.workspaceId },
    });
    expect(before).toBeGreaterThan(0);

    await ProjectDeletionService.delete(fixture.projectId);

    const after = await prisma.usageEntry.count({
      where: { workspaceId: fixture.workspaceId },
    });
    expect(after).toBe(before);
    const survivor = await prisma.usageEntry.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspaceId,
        projectRef: fixture.projectId,
      },
    });
    expect(survivor.projectRef).toBe(fixture.projectId);
  });
});

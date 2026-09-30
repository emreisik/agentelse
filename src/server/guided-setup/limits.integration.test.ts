import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { AUDIT, type DiscoveryCaps } from "@/lib/guided-setup/contract";
import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { ProjectDeletionService } from "@/server/projects/project-deletion.service";
import { describeIntegration } from "@/test-support/integration-suite";

import { reserveDiscovery } from "./limits";

// Guard G53 against real Postgres (CI only; never the shared Neon database):
// the durable caps count workspace-level audit rows, so the real project
// deletion must not erase them.
describeIntegration("guided setup discovery caps vs. project deletion (G53)", () => {
  const runId = randomUUID().slice(0, 8);
  const userId = `user-${runId}`;
  // User scope is per workspace + actor, so the fixture's own workspace keeps
  // the assertions independent of other rows; the global ceiling is set high.
  const caps: DiscoveryCaps = {
    perUserPer24h: 1,
    perWorkspacePer24h: 10,
    globalPer24h: 100_000,
  };
  let fixture: AgencyFixture;

  beforeAll(async () => {
    fixture = await createAgencyFixture(`caps-${runId}`);
  }, 60_000);

  afterAll(async () => {
    await teardownAgencyFixture(fixture?.workspaceId);
    if (fixture?.workspaceId) {
      await prisma.auditLog.deleteMany({
        where: { workspaceId: fixture.workspaceId },
      });
    }
  });

  it("a started row survives the real ProjectDeletionService and still counts", async () => {
    const first = await reserveDiscovery({
      workspaceId: fixture.workspaceId,
      userId,
      projectId: fixture.projectId,
      runId: "run-1",
      attempt: 1,
      nowMs: Date.now(),
      caps,
    });
    expect(first.ok).toBe(true);

    const row = await prisma.auditLog.findFirst({
      where: { workspaceId: fixture.workspaceId, action: AUDIT.discoveryStarted },
    });
    expect(row?.projectId).toBeNull();
    expect(row?.brandId).toBeNull();
    expect(row?.entityId).toBe(fixture.projectId);

    await ProjectDeletionService.delete(fixture.projectId);

    const survivors = await prisma.auditLog.count({
      where: { workspaceId: fixture.workspaceId, action: AUDIT.discoveryStarted },
    });
    expect(survivors).toBe(1);

    // A start from a new project of the same user is refused at cap + 1.
    const second = await reserveDiscovery({
      workspaceId: fixture.workspaceId,
      userId,
      projectId: `other-${runId}`,
      runId: "run-2",
      attempt: 1,
      nowMs: Date.now(),
      caps,
    });
    expect(second).toEqual({ ok: false, scope: "user" });
  }, 60_000);
});

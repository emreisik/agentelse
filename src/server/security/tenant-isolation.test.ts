import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

// tenant-context.ts imports "@/lib/auth" for requireUser(), which pulls in
// next-auth -> next/server — resolvable inside Next's own build, not under
// plain Node/Vitest. Only requireProjectAccess/requireBrowserProfileInProject
// are under test here and neither calls auth(), so a stub is enough.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { AgentelseError, isAgentelseError } from "@/server/security/errors";
import {
  requireBrowserProfileInProject,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { describeIntegration } from "@/test-support/integration-suite";

// Every fixture is namespaced and written only to the isolated test database.
describeIntegration("tenant isolation (spec section 76)", () => {
  const runId = randomUUID().slice(0, 8);
  let workspaceId: string;
  let memberUserId: string;
  let outsiderUserId: string;
  let projectAId: string;
  let projectBId: string;
  let browserProfileBId: string;

  beforeAll(async () => {
    const workspace = await prisma.workspace.create({
      data: {
        name: `Isolation Test ${runId}`,
        slug: `isolation-test-${runId}`,
      },
    });
    workspaceId = workspace.id;

    const member = await prisma.user.create({
      data: { email: `member-${runId}@test.local` },
    });
    memberUserId = member.id;
    const outsider = await prisma.user.create({
      data: { email: `outsider-${runId}@test.local` },
    });
    outsiderUserId = outsider.id;

    await prisma.workspaceMember.create({
      data: { workspaceId, userId: memberUserId, role: "OWNER" },
    });

    const projectA = await prisma.project.create({
      data: {
        workspaceId,
        name: `Project A ${runId}`,
        slug: `project-a-${runId}`,
      },
    });
    projectAId = projectA.id;
    await prisma.brand.create({
      data: {
        workspaceId,
        projectId: projectAId,
        name: "Brand A",
        slug: "default",
        isDefault: true,
      },
    });

    const projectB = await prisma.project.create({
      data: {
        workspaceId,
        name: `Project B ${runId}`,
        slug: `project-b-${runId}`,
      },
    });
    projectBId = projectB.id;
    const brandB = await prisma.brand.create({
      data: {
        workspaceId,
        projectId: projectBId,
        name: "Brand B",
        slug: "default",
        isDefault: true,
      },
    });

    const browserProfileB = await prisma.browserProfile.create({
      data: {
        workspaceId,
        projectId: projectBId,
        brandId: brandB.id,
        name: `project-b-instagram-${runId}`,
        slug: `project-b-instagram-${runId}`,
        purpose: "INSTAGRAM",
      },
    });
    browserProfileBId = browserProfileB.id;
  });

  afterAll(async () => {
    if (!workspaceId) return;

    await prisma.browserProfile.deleteMany({ where: { workspaceId } });
    await prisma.brand.deleteMany({ where: { workspaceId } });
    await prisma.project.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });

    const userIds = [memberUserId, outsiderUserId].filter(Boolean);
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  it("rejects a browser profile resolved against a different project", async () => {
    await expect(
      requireBrowserProfileInProject(browserProfileBId, projectAId),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isAgentelseError(error) && error.code === "BROWSER_PROFILE_MISMATCH",
    );
  });

  it("accepts a browser profile resolved against its own project", async () => {
    await expect(
      requireBrowserProfileInProject(browserProfileBId, projectBId),
    ).resolves.toBeUndefined();
  });

  it("resolves workspace/brand for a member of the project's workspace", async () => {
    const access = await requireProjectAccess(memberUserId, projectAId);
    expect(access.workspaceId).toBe(workspaceId);
    expect(access.projectId).toBe(projectAId);
    expect(access.defaultBrandId).toBeTruthy();
  });

  it("rejects a user who is not a member of the project's workspace", async () => {
    await expect(
      requireProjectAccess(outsiderUserId, projectAId),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isAgentelseError(error) && error.code === "PERMISSION_DENIED",
    );
  });

  it("rejects an unknown project id", async () => {
    await expect(
      requireProjectAccess(memberUserId, "nonexistent-project-id"),
    ).rejects.toBeInstanceOf(AgentelseError);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const auditLog = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  findMany: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { auditLog } }));

import { AuditLogRepository } from "./audit-log.repository";

beforeEach(() => {
  auditLog.create.mockReset().mockResolvedValue({ id: "a1" });
  auditLog.update.mockReset().mockResolvedValue({ id: "a1" });
  auditLog.findMany.mockReset().mockResolvedValue([]);
});

describe("AuditLogRepository", () => {
  it("reclassify updates action and metadata by id, and nothing else", async () => {
    await AuditLogRepository.reclassify("a1", "new.action", { reason: "user" });

    expect(auditLog.update).toHaveBeenCalledTimes(1);
    expect(auditLog.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { action: "new.action", metadata: { reason: "user" } },
    });
    expect(auditLog.create).not.toHaveBeenCalled();
  });

  it("record is unchanged: passes the input through and never adds a projectId", async () => {
    await AuditLogRepository.record({
      workspaceId: "w1",
      actorType: "USER",
      actorId: "u1",
      action: "x",
      entityType: "Project",
      entityId: "p1",
      metadata: { a: 1 },
    });

    const arg = auditLog.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data).toEqual({
      workspaceId: "w1",
      actorType: "USER",
      actorId: "u1",
      action: "x",
      entityType: "Project",
      entityId: "p1",
      metadata: { a: 1 },
    });
    expect(Object.keys(arg.data)).not.toContain("projectId");
  });

  it("listForProject is unchanged", async () => {
    await AuditLogRepository.listForProject("p1");
    expect(auditLog.findMany).toHaveBeenCalledWith({
      where: { projectId: "p1" },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    await AuditLogRepository.listForProject("p1", 5);
    expect(auditLog.findMany).toHaveBeenLastCalledWith({
      where: { projectId: "p1" },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
  });
});

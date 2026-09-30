import { beforeEach, describe, expect, it, vi } from "vitest";

// How a work session is kept: on a Command row tagged with its own topic, one
// live session per project, every write guarded by the version it read, spend
// charged to the session that was worked on, and the trail written on the way.

const findFirst = vi.fn();
const updateMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { command: { findFirst, updateMany } },
}));

const create = vi.fn();
vi.mock("@/server/repositories/command.repository", () => ({
  CommandRepository: { create },
}));

const auditRecord = vi.fn();
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

const { WorkSessionService } = await import("./work-session-service");
const { SESSION_LIMITS, WORK_SESSION_TOPIC, createSession } =
  await import("./session");
import type { WorkSession } from "./session";

const scope = { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" };
const T0 = new Date("2026-09-30T10:00:00.000Z");
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  const created = createSession(
    { goal: "Autumn campaign", steps: ["Research", "Write", "Render"] },
    T0,
    "rev-1",
  );
  if (!created.ok) throw new Error(created.error);
  return { ...created.session, ...overrides };
}

const row = (workSession: unknown, id = "cmd-s1") => ({
  id,
  parsedIntent: { workSession },
});

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(null);
  updateMany.mockResolvedValue({ count: 1 });
  create.mockResolvedValue({ id: "cmd-new" });
  auditRecord.mockResolvedValue(undefined);
});

describe("getLive", () => {
  it("looks at the project's newest session row only", async () => {
    await WorkSessionService.getLive("proj-1", later(1));

    expect(findFirst).toHaveBeenCalledWith({
      where: { projectId: "proj-1", topic: WORK_SESSION_TOPIC },
      orderBy: { createdAt: "desc" },
      select: { id: true, parsedIntent: true },
    });
  });

  it("returns the session and the row it lives on", async () => {
    findFirst.mockResolvedValue(row(session()));

    const live = await WorkSessionService.getLive("proj-1", later(1));

    expect(live?.id).toBe("cmd-s1");
    expect(live?.session.goal).toBe("Autumn campaign");
  });

  it("is null when there is no session", async () => {
    expect(await WorkSessionService.getLive("proj-1", later(1))).toBeNull();
  });

  it("is null when the newest session has ended", async () => {
    findFirst.mockResolvedValue(row(session({ status: "COMPLETED" })));

    expect(await WorkSessionService.getLive("proj-1", later(1))).toBeNull();
  });

  it("is null once the session has been left alone too long", async () => {
    findFirst.mockResolvedValue(row(session()));
    const idle = SESSION_LIMITS.idleExpiryMs / 60_000;

    expect(
      await WorkSessionService.getLive("proj-1", later(idle + 1)),
    ).toBeNull();
  });

  it("is null when the stored value is not a session", async () => {
    findFirst.mockResolvedValue(row({ v: 9, whatever: true }));

    expect(await WorkSessionService.getLive("proj-1", later(1))).toBeNull();
  });

  it("is null when the row has no checkpoint at all", async () => {
    findFirst.mockResolvedValue({ id: "cmd-x", parsedIntent: null });

    expect(await WorkSessionService.getLive("proj-1", later(1))).toBeNull();
  });
});

describe("start", () => {
  const input = {
    goal: "Autumn campaign",
    steps: ["Research", "Write", "Render"],
    userId: "user-1",
  };

  it("writes the checkpoint to a row of its own, outside the chat feed", async () => {
    const result = await WorkSessionService.start(scope, input, T0);

    expect(result).toMatchObject({ status: "STARTED", id: "cmd-new" });
    expect(create).toHaveBeenCalledTimes(1);
    const written = create.mock.calls[0]![0];
    expect(written).toMatchObject({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      source: "SYSTEM",
      topic: WORK_SESSION_TOPIC,
      rawText: "Autumn campaign",
      createdByUserId: "user-1",
    });
    expect(written.parsedIntent.workSession).toMatchObject({
      status: "ACTIVE",
      goal: "Autumn campaign",
    });
    expect(written.parsedIntent.workSession.steps).toHaveLength(3);
  });

  it("leaves a trail", async () => {
    await WorkSessionService.start(scope, input, T0);

    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "work_session.started",
        entityId: "cmd-new",
        actorType: "USER",
        actorId: "user-1",
        metadata: { steps: 3 },
      }),
    );
  });

  it("runs one session at a time: a live one is returned, not replaced", async () => {
    findFirst.mockResolvedValue(row(session()));

    const result = await WorkSessionService.start(scope, input, later(10));

    expect(result).toMatchObject({ status: "ALREADY_ACTIVE", id: "cmd-s1" });
    expect(create).not.toHaveBeenCalled();
  });

  it("starts a new one after the last was cancelled", async () => {
    findFirst.mockResolvedValue(row(session({ status: "CANCELLED" })));

    const result = await WorkSessionService.start(scope, input, later(10));

    expect(result.status).toBe("STARTED");
  });

  it("starts a new one when the last was abandoned", async () => {
    findFirst.mockResolvedValue(row(session()));
    const idle = SESSION_LIMITS.idleExpiryMs / 60_000;

    const result = await WorkSessionService.start(
      scope,
      input,
      later(idle + 1),
    );

    expect(result.status).toBe("STARTED");
  });

  it("writes nothing for a session that is not one", async () => {
    const result = await WorkSessionService.start(
      scope,
      { goal: "Just one thing", steps: ["Only"] },
      T0,
    );

    expect(result).toMatchObject({ status: "INVALID" });
    expect(create).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("still starts when the trail cannot be written", async () => {
    auditRecord.mockRejectedValue(new Error("audit down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await WorkSessionService.start(scope, input, T0);

    expect(result.status).toBe("STARTED");
    spy.mockRestore();
  });
});

describe("update", () => {
  const options = { freeText: true, userId: "user-1" };

  it("writes the change only if the row is still the version it read", async () => {
    findFirst.mockResolvedValue(row(session()));

    const result = await WorkSessionService.update(
      scope,
      { stepId: "s1", status: "IN_PROGRESS" },
      options,
      later(2),
    );

    expect(result).toMatchObject({ status: "UPDATED", ended: null });
    const call = updateMany.mock.calls[0]![0];
    expect(call.where).toEqual({
      id: "cmd-s1",
      parsedIntent: { path: ["workSession", "rev"], equals: "rev-1" },
    });
    const written = call.data.parsedIntent.workSession as WorkSession;
    expect(written.steps[0]!.status).toBe("IN_PROGRESS");
    // A new version, so a slower request cannot overwrite this one.
    expect(written.rev).not.toBe("rev-1");
  });

  it("says nothing was there when no session is live", async () => {
    const result = await WorkSessionService.update(
      scope,
      { stepId: "s1", status: "DONE" },
      options,
      later(2),
    );

    expect(result).toEqual({ status: "NONE" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses a bad update without writing", async () => {
    findFirst.mockResolvedValue(row(session()));

    const result = await WorkSessionService.update(
      scope,
      { stepId: "s9", status: "DONE" },
      options,
      later(2),
    );

    expect(result).toMatchObject({ status: "REJECTED" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("passes on what it left out of a message that read outside content", async () => {
    findFirst.mockResolvedValue(row(session()));

    const result = await WorkSessionService.update(
      scope,
      { stepId: "s1", status: "DONE", note: "from a web page" },
      { freeText: false },
      later(2),
    );

    expect(result).toMatchObject({ status: "UPDATED", ignored: ["note"] });
    const written = updateMany.mock.calls[0]![0].data.parsedIntent
      .workSession as WorkSession;
    expect(written.steps[0]!.note).toBeUndefined();
  });

  it("retries on the fresh state when another request got there first", async () => {
    const stale = session();
    const fresh = session({
      rev: "rev-2",
      steps: stale.steps.map((step) =>
        step.id === "s2" ? { ...step, status: "DONE" as const } : step,
      ),
    });
    findFirst
      .mockResolvedValueOnce(row(stale))
      .mockResolvedValueOnce(row(fresh));
    updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    const result = await WorkSessionService.update(
      scope,
      { stepId: "s1", status: "DONE" },
      options,
      later(2),
    );

    expect(result.status).toBe("UPDATED");
    expect(updateMany).toHaveBeenCalledTimes(2);
    // The second attempt is on top of the other request's change, not a copy
    // of the first read.
    const written = updateMany.mock.calls[1]![0].data.parsedIntent
      .workSession as WorkSession;
    expect(written.steps.map((s) => s.status)).toEqual([
      "DONE",
      "DONE",
      "PENDING",
    ]);
    expect(updateMany.mock.calls[1]![0].where.parsedIntent.equals).toBe(
      "rev-2",
    );
  });

  it("gives up rather than overwrite when it keeps losing the race", async () => {
    findFirst.mockResolvedValue(row(session()));
    updateMany.mockResolvedValue({ count: 0 });

    const result = await WorkSessionService.update(
      scope,
      { stepId: "s1", status: "DONE" },
      options,
      later(2),
    );

    expect(result).toMatchObject({ status: "REJECTED" });
    expect(updateMany).toHaveBeenCalledTimes(3);
  });

  it("trails a session that finishes", async () => {
    findFirst.mockResolvedValue(
      row(
        session({
          steps: [
            { id: "s1", title: "a", status: "DONE", artifacts: [] },
            { id: "s2", title: "b", status: "PENDING", artifacts: [] },
          ],
        }),
      ),
    );

    const result = await WorkSessionService.update(
      scope,
      { stepId: "s2", status: "DONE" },
      options,
      later(2),
    );

    expect(result).toMatchObject({ status: "UPDATED", ended: "COMPLETED" });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "work_session.completed",
        entityId: "cmd-s1",
      }),
    );
  });

  it("trails a session the client cancels", async () => {
    findFirst.mockResolvedValue(row(session()));

    const result = await WorkSessionService.update(
      scope,
      { cancel: true, reason: "Changed plans" },
      options,
      later(2),
    );

    expect(result).toMatchObject({ status: "UPDATED", ended: "CANCELLED" });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "work_session.cancelled",
        metadata: expect.objectContaining({ reason: "Changed plans" }),
      }),
    );
  });

  it("does not trail an ordinary progress update", async () => {
    findFirst.mockResolvedValue(row(session()));

    await WorkSessionService.update(
      scope,
      { stepId: "s1", status: "DONE" },
      options,
      later(2),
    );

    expect(auditRecord).not.toHaveBeenCalled();
  });
});

describe("addSpend", () => {
  it("adds the spend and counts the message on the session that was worked on", async () => {
    findFirst.mockResolvedValue(row(session()));

    await WorkSessionService.addSpend(scope, "cmd-s1", 0.42, later(3));

    const written = updateMany.mock.calls[0]![0].data.parsedIntent
      .workSession as WorkSession;
    expect(written).toMatchObject({
      spentUsd: 0.42,
      turns: 1,
      status: "ACTIVE",
    });
  });

  it("does not charge a different session than the one the message touched", async () => {
    findFirst.mockResolvedValue(row(session(), "cmd-newer"));

    await WorkSessionService.addSpend(scope, "cmd-s1", 0.42, later(3));

    expect(updateMany).not.toHaveBeenCalled();
  });

  it("does nothing when the session has already ended", async () => {
    findFirst.mockResolvedValue(row(session({ status: "COMPLETED" })));

    await WorkSessionService.addSpend(scope, "cmd-s1", 0.42, later(3));

    expect(updateMany).not.toHaveBeenCalled();
  });

  it("closes the session at its budget and says so in the trail", async () => {
    findFirst.mockResolvedValue(row(session({ spentUsd: 4.8 })));

    await WorkSessionService.addSpend(scope, "cmd-s1", 0.4, later(3));

    const written = updateMany.mock.calls[0]![0].data.parsedIntent
      .workSession as WorkSession;
    expect(written).toMatchObject({ status: "CANCELLED", endReason: "budget" });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "work_session.cancelled",
        entityId: "cmd-s1",
        metadata: expect.objectContaining({ reason: "budget" }),
      }),
    );
  });

  it("does not trail spend that stays within budget", async () => {
    findFirst.mockResolvedValue(row(session()));

    await WorkSessionService.addSpend(scope, "cmd-s1", 0.1, later(3));

    expect(auditRecord).not.toHaveBeenCalled();
  });
});

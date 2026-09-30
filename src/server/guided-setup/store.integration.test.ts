import { randomUUID } from "node:crypto";

import { afterAll, expect, it } from "vitest";

import {
  SESSION_TOPIC,
  sessionRowId,
  type SessionRecord,
} from "@/lib/guided-setup/contract";
import { prisma } from "@/lib/prisma";
import { CommandRepository } from "@/server/repositories/command.repository";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  createSessionIfAbsent,
  isUniqueViolation,
  modifySession,
  readSession,
} from "./store";

// Guard G50: the JSON-path compare-and-swap and the primary-key insert behave
// on a REAL Postgres the way the store relies on. The mocks in store.test.ts
// only prove the store's logic; whether `updateMany` filters on a JSON path and
// whether concurrent inserts collapse to one row is the database's business.
// Runs only when a dedicated TEST_DATABASE_URL is configured (CI, Postgres 16),
// never against the shared development database.

describeIntegration("guided-setup store on Postgres (G50)", () => {
  const runId = randomUUID().slice(0, 8);
  const workspaceId = `ws_gs_it_${runId}`;
  const projectFor = (name: string) => `p_${runId}_${name}`;
  const projectIds: string[] = [];

  function session(rev: string): SessionRecord {
    return {
      v: 1,
      rev,
      editRev: "eeeeeeeeeeee",
      status: "OPEN",
      step: "goal",
      more: false,
      seedFirst: false,
      staticFirst: true,
      answers: {},
      seed: null,
      applyingSinceMs: null,
      applyToken: null,
      goalId: null,
      applied: null,
      lastFailure: null,
      createdAtMs: 1_790_000_000_000,
      updatedAtMs: 1_790_000_000_000,
      updatedByUserId: "usr_it",
    };
  }

  function track(name: string): string {
    const projectId = projectFor(name);
    projectIds.push(projectId);
    return projectId;
  }

  async function insertRow(projectId: string, parsedIntent: unknown) {
    await prisma.command.create({
      data: {
        id: sessionRowId(projectId),
        workspaceId,
        projectId,
        topic: SESSION_TOPIC,
        source: "SYSTEM",
        rawText: SESSION_TOPIC,
        parsedIntent: parsedIntent as never,
      },
    });
  }

  const casWhere = (projectId: string, rev: string) => ({
    id: sessionRowId(projectId),
    parsedIntent: { path: ["guidedSetup", "rev"], equals: rev },
  });

  afterAll(async () => {
    await prisma.command.deleteMany({ where: { workspaceId } });
  });

  it("8 concurrent commits holding the same rev produce exactly one winner", async () => {
    const projectId = track("cas");
    await insertRow(projectId, { guidedSetup: session("r0r0r0r0r0r0") });

    const counts = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        prisma.command
          .updateMany({
            where: casWhere(projectId, "r0r0r0r0r0r0"),
            data: {
              parsedIntent: {
                guidedSetup: session(`winner${index}rev`),
              } as never,
            },
          })
          .then((result) => result.count),
      ),
    );

    expect(counts.filter((count) => count === 1)).toHaveLength(1);
    expect(counts.filter((count) => count === 0)).toHaveLength(7);
    const stored = await readSession(projectId);
    expect(stored?.rev).toMatch(/^winner\drev$/);
  });

  it("8 concurrent creates by primary key leave one row and seven P2002", async () => {
    const projectId = track("create");

    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        CommandRepository.create({
          id: sessionRowId(projectId),
          workspaceId,
          projectId,
          topic: SESSION_TOPIC,
          source: "SYSTEM",
          rawText: SESSION_TOPIC,
          parsedIntent: { guidedSetup: session("c0c0c0c0c0c0") },
        }),
      ),
    );

    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const outcome of rejected) {
      expect(isUniqueViolation(outcome.reason)).toBe(true);
    }
    expect(
      await prisma.command.count({ where: { id: sessionRowId(projectId) } }),
    ).toBe(1);
  });

  it("createSessionIfAbsent under 8 concurrent starts: one CREATED, seven EXISTS", async () => {
    const projectId = track("start");
    const scope = { workspaceId, projectId };

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        createSessionIfAbsent({
          scope,
          userId: "usr_it",
          record: session("s0s0s0s0s0s0"),
        }),
      ),
    );

    expect(results.filter((r) => r.status === "CREATED")).toHaveLength(1);
    expect(results.filter((r) => r.status === "EXISTS")).toHaveLength(7);
  });

  it("modifySession under contention never loses or repeats a change", async () => {
    const projectId = track("modify");
    await insertRow(projectId, { guidedSetup: session("m0m0m0m0m0m0") });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        modifySession(
          projectId,
          (record) => ({
            next: { ...record, updatedAtMs: record.updatedAtMs + 1 },
            value: null,
          }),
          { attempts: 16 },
        ),
      ),
    );

    expect(results.every((result) => result.status === "OK")).toBe(true);
    expect((await readSession(projectId))?.updatedAtMs).toBe(
      1_790_000_000_000 + 8,
    );
  });

  it("a row without the JSON key matches nothing and does not throw", async () => {
    const projectId = track("nokey");
    await insertRow(projectId, { somethingElse: { rev: "n0n0n0n0n0n0" } });

    const { count } = await prisma.command.updateMany({
      where: casWhere(projectId, "n0n0n0n0n0n0"),
      data: { parsedIntent: { guidedSetup: session("x1x1x1x1x1x1") } as never },
    });

    expect(count).toBe(0);
  });

  it("a row with a null parsedIntent matches nothing and does not throw", async () => {
    const projectId = track("null");
    await prisma.command.create({
      data: {
        id: sessionRowId(projectId),
        workspaceId,
        projectId,
        topic: SESSION_TOPIC,
        source: "SYSTEM",
        rawText: SESSION_TOPIC,
      },
    });

    const { count } = await prisma.command.updateMany({
      where: casWhere(projectId, "n0n0n0n0n0n0"),
      data: { parsedIntent: { guidedSetup: session("x1x1x1x1x1x1") } as never },
    });

    expect(count).toBe(0);
  });
});

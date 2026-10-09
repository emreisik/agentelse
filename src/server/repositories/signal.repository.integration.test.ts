import { randomUUID } from "node:crypto";

import { afterAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { SignalRepository } from "./signal.repository";

// The scoring step's queue against a real database. A client whose AI allowance
// is spent cannot have its signals scored, they stay NEW, and nothing expires
// them: if they sat at the head of the queue they would fill every tick and no
// other client would ever be scored again.

const runId = randomUUID().slice(0, 8);
const fixtures: AgencyFixture[] = [];

async function client() {
  const fixture = await createAgencyFixture(`${runId}-${fixtures.length}`);
  fixtures.push(fixture);
  return fixture;
}

let counter = 0;
async function signalFor(
  fixture: AgencyFixture,
  options: { status?: "NEW" | "SCORED"; at: Date },
) {
  counter += 1;
  const created = await prisma.signal.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      source: "test",
      category: "SOCIAL_TREND",
      title: `signal ${counter}`,
      fingerprint: `${runId}-${counter}`,
      status: options.status ?? "NEW",
      createdAt: options.at,
    },
  });
  // updatedAt is managed by the database layer: pin it to the creation time.
  await prisma.$executeRaw`UPDATE "Signal" SET "updatedAt" = ${options.at} WHERE "id" = ${created.id}`;
  return created.id;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describeIntegration("SignalRepository scoring queue", () => {
  afterAll(async () => {
    for (const fixture of fixtures) {
      await prisma.signal.deleteMany({
        where: { workspaceId: fixture.workspaceId },
      });
      await teardownAgencyFixture(fixture.workspaceId);
    }
  });

  it("lists NEW signals only, the one attempted longest ago first, and honours the limit", async () => {
    const a = await client();
    const oldest = await signalFor(a, { at: minutesAgo(30) });
    const middle = await signalFor(a, { at: minutesAgo(20) });
    const newest = await signalFor(a, { at: minutesAgo(10) });
    const scored = await signalFor(a, { status: "SCORED", at: minutesAgo(40) });

    const all = (await SignalRepository.listNewForScoring(1000))
      .filter((row) => row.workspaceId === a.workspaceId)
      .map((row) => row.id);
    expect(all).toEqual([oldest, middle, newest]);
    expect(all).not.toContain(scored);

    // `take` is applied by the database in that order.
    const firstTwo = await SignalRepository.listNewForScoring(1000);
    expect(firstTwo.length).toBeGreaterThanOrEqual(3);
    const limited = await SignalRepository.listNewForScoring(1);
    expect(limited).toHaveLength(1);
  });

  it("moves a client's whole NEW backlog behind everybody else's, and touches nothing else", async () => {
    const stuck = await client();
    const healthy = await client();
    const stuckIds = [
      await signalFor(stuck, { at: minutesAgo(90) }),
      await signalFor(stuck, { at: minutesAgo(85) }),
      await signalFor(stuck, { at: minutesAgo(80) }),
    ];
    const stuckScored = await signalFor(stuck, {
      status: "SCORED",
      at: minutesAgo(95),
    });
    const healthyId = await signalFor(healthy, { at: minutesAgo(5) });
    const healthyBefore = await prisma.signal.findUniqueOrThrow({
      where: { id: healthyId },
    });
    const scoredBefore = await prisma.signal.findUniqueOrThrow({
      where: { id: stuckScored },
    });

    // Before: the stuck client's signals are the oldest and head the queue.
    const before = (await SignalRepository.listNewForScoring(10_000)).map(
      (row) => row.id,
    );
    expect(before.indexOf(stuckIds[0]!)).toBeLessThan(
      before.indexOf(healthyId),
    );

    await SignalRepository.deferWorkspace(stuck.workspaceId);

    // After: the healthy client's signal comes first.
    const after = (await SignalRepository.listNewForScoring(10_000)).map(
      (row) => row.id,
    );
    for (const id of stuckIds) {
      expect(after.indexOf(healthyId)).toBeLessThan(after.indexOf(id));
    }
    // Only the stuck client's NEW rows moved.
    const healthyAfter = await prisma.signal.findUniqueOrThrow({
      where: { id: healthyId },
    });
    const scoredAfter = await prisma.signal.findUniqueOrThrow({
      where: { id: stuckScored },
    });
    expect(healthyAfter.updatedAt).toEqual(healthyBefore.updatedAt);
    expect(scoredAfter.updatedAt).toEqual(scoredBefore.updatedAt);
    // They are only moved: still NEW, still the same rows.
    expect(
      await prisma.signal.count({
        where: { id: { in: stuckIds }, status: "NEW" },
      }),
    ).toBe(3);
  });

  it("keeps a deferred backlog in its own order, behind the others, until they are done", async () => {
    const stuck = await client();
    const healthy = await client();
    const stuckIds = [
      await signalFor(stuck, { at: minutesAgo(200) }),
      await signalFor(stuck, { at: minutesAgo(190) }),
    ];
    const healthyIds = [
      await signalFor(healthy, { at: minutesAgo(15) }),
      await signalFor(healthy, { at: minutesAgo(14) }),
    ];

    await SignalRepository.deferWorkspace(stuck.workspaceId);

    const order = (await SignalRepository.listNewForScoring(10_000))
      .map((row) => row.id)
      .filter((id) => [...stuckIds, ...healthyIds].includes(id));
    expect(order.slice(0, 2)).toEqual(healthyIds);
    expect(new Set(order.slice(2))).toEqual(new Set(stuckIds));
  });
});

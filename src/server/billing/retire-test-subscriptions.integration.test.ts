import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  describeDatabase,
  parseLegacyBefore,
  planRetirement,
  retireCandidates,
} from "./retire-test-subscriptions";

// The pre-launch clean-up of subscriptions bought with a TEST card: what it lists (with the
// warnings the owner needs before --apply), what it writes, and that it leaves live payers alone.

const runId = randomUUID().slice(0, 8);
const fixtures: AgencyFixture[] = [];
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const B = (value: number) => BigInt(value);

async function workspace(options: { createdDaysAgo: number }) {
  const fixture = await createAgencyFixture(`rts-${runId}-${fixtures.length}`);
  fixtures.push(fixture);
  await prisma.workspace.update({
    where: { id: fixture.workspaceId },
    data: { createdAt: new Date(NOW.getTime() - options.createdDaysAgo * DAY) },
  });
  return fixture;
}

async function subscription(
  fixture: AgencyFixture,
  data: {
    livemode: boolean;
    status?: string;
    paidThroughDays?: number;
  },
) {
  await prisma.subscription.create({
    data: {
      workspaceId: fixture.workspaceId,
      planKey: "growth",
      interval: "MONTH",
      status: data.status ?? "ACTIVE",
      paidThrough: new Date(NOW.getTime() + (data.paidThroughDays ?? 20) * DAY),
      stripeSubscriptionId: `sub_${randomUUID().slice(0, 10)}`,
      stripeLivemode: data.livemode,
    },
  });
}

const mine = (ids: string[]) => (row: { workspaceId: string }) =>
  ids.includes(row.workspaceId);

describe("describeDatabase", () => {
  it("names the host and database, never the credentials", () => {
    expect(
      describeDatabase("postgresql://app:s3cret@db.example.com:5432/prod?x=1"),
    ).toBe("db.example.com:5432/prod");
    expect(describeDatabase("postgresql://localhost/agentelse")).toBe(
      "localhost/agentelse",
    );
    expect(describeDatabase(undefined)).toContain("tanımlı değil");
    expect(describeDatabase("not a url")).not.toContain("not a url");
    expect(describeDatabase("postgresql://u:pw@h/db")).not.toContain("pw");
  });
});

describe("parseLegacyBefore", () => {
  it("reads an ISO date and treats anything else as unset", () => {
    expect(parseLegacyBefore("2026-10-12T09:00:00Z")?.toISOString()).toBe(
      "2026-10-12T09:00:00.000Z",
    );
    expect(parseLegacyBefore("")).toBeNull();
    expect(parseLegacyBefore(undefined)).toBeNull();
    expect(parseLegacyBefore("later")).toBeNull();
  });
});

describeIntegration("retiring subscriptions bought with a test card", () => {
  afterAll(async () => {
    for (const fixture of fixtures.splice(0)) {
      await teardownAgencyFixture(fixture.workspaceId);
    }
  });

  it("lists only TEST-mode subscriptions that still give access, and writes only those", async () => {
    const test = await workspace({ createdDaysAgo: 1 });
    const live = await workspace({ createdDaysAgo: 1 });
    const ended = await workspace({ createdDaysAgo: 1 });
    await subscription(test, { livemode: false });
    await subscription(live, { livemode: true });
    await subscription(ended, {
      livemode: false,
      status: "CANCELED",
      paidThroughDays: -3,
    });
    const ids = [test, live, ended].map((fixture) => fixture.workspaceId);

    const plan = await planRetirement(prisma, { now: NOW });
    const candidates = plan.active.filter(mine(ids));

    expect(candidates.map((row) => row.workspaceId)).toEqual([
      test.workspaceId,
    ]);
    expect(await retireCandidates(prisma, candidates, NOW)).toBe(1);
    expect(
      await prisma.subscription.findUniqueOrThrow({
        where: { workspaceId: test.workspaceId },
      }),
    ).toMatchObject({
      status: "CANCELED",
      endedReason: "CANCELED",
      paidThrough: NOW,
      stripeLivemode: false,
    });
    expect(
      await prisma.subscription.findUniqueOrThrow({
        where: { workspaceId: live.workspaceId },
      }),
    ).toMatchObject({ status: "ACTIVE", stripeLivemode: true });

    // Running it again finds nothing more to do.
    const again = await planRetirement(prisma, {
      now: new Date(NOW.getTime() + 1000),
    });
    expect(again.active.filter(mine(ids))).toEqual([]);
  });

  it("never touches a live subscription even when it is handed over by mistake", async () => {
    const live = await workspace({ createdDaysAgo: 1 });
    await subscription(live, { livemode: true });

    const written = await retireCandidates(
      prisma,
      [{ workspaceId: live.workspaceId }],
      NOW,
    );

    expect(written).toBe(0);
    expect(
      (
        await prisma.subscription.findUniqueOrThrow({
          where: { workspaceId: live.workspaceId },
        })
      ).status,
    ).toBe("ACTIVE");
  });

  it("flags a workspace that opened before the legacy cut-off: without the test row it would have been an existing customer", async () => {
    const old = await workspace({ createdDaysAgo: 90 });
    const recent = await workspace({ createdDaysAgo: 2 });
    await subscription(old, { livemode: false });
    await subscription(recent, { livemode: false });
    const ids = [old, recent].map((fixture) => fixture.workspaceId);
    const cutoff = new Date(NOW.getTime() - 30 * DAY);

    const flagged = await planRetirement(prisma, {
      now: NOW,
      legacyBefore: cutoff,
    });
    const unflagged = await planRetirement(prisma, { now: NOW });

    const wasLegacy = (plan: typeof flagged) =>
      Object.fromEntries(
        plan.active
          .filter(mine(ids))
          .map((row) => [row.workspaceId, row.wasLegacy]),
      );
    expect(wasLegacy(flagged)).toEqual({
      [old.workspaceId]: true,
      [recent.workspaceId]: false,
    });
    // Without a cut-off nothing can be called legacy (the script says so).
    expect(Object.values(wasLegacy(unflagged))).toEqual([false, false]);
  });

  it("reports extra-pack credit bought with the test card: it does not expire with the subscription", async () => {
    const withPack = await workspace({ createdDaysAgo: 1 });
    const without = await workspace({ createdDaysAgo: 1 });
    await subscription(withPack, { livemode: false });
    await subscription(without, { livemode: false });
    await prisma.usageBalance.create({
      data: {
        id: randomUUID(),
        workspaceId: withPack.workspaceId,
        unit: "IMAGE",
        periodStart: new Date(NOW.getTime() - 5 * DAY),
        periodEnd: new Date(NOW.getTime() + 25 * DAY),
        periodGranted: B(50),
        extraGranted: B(20),
        extraUsed: B(5),
        extraReserved: B(3),
        updatedAt: NOW,
      },
    });

    const plan = await planRetirement(prisma, { now: NOW });
    const left = Object.fromEntries(
      plan.active
        .filter(mine([withPack.workspaceId, without.workspaceId]))
        .map((row) => [row.workspaceId, row.extraLeft]),
    );

    expect(left).toEqual({
      [withPack.workspaceId]: 12,
      [without.workspaceId]: 0,
    });
  });
});

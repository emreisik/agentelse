import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";
import { GaSync } from "@/server/website-analytics/sync/runner";

import { processRiscToken } from "./handler";
import {
  createTestRiscKey,
  signTestRiscToken,
  TEST_RISC_AUDIENCE,
} from "./test-support";

// RISC gerçek Postgres'e karşı: iki Google hesabı, her birinin Analytics ve
// Search Console bağlantısı. tokens-revoked yalnız birinci hesabın
// bağlantılarını EXPIRE eder, bağları AUTH'a çeker ve uyarıları açar; ikinci
// teslimat (aynı jti) hiçbir şeyi yeniden uygulamaz.

describeIntegration("Google RISC receiver", () => {
  const runId = randomUUID().slice(0, 8);
  const subA = `risc-sub-a-${runId}`;
  const subB = `risc-sub-b-${runId}`;
  const jti = `risc-jti-${runId}`;
  const key = createTestRiscKey("kid-int");
  const saved = {
    sync: process.env.GA_SYNC,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  let a: AgencyFixture;
  let b: AgencyFixture;

  async function connect(fixture: AgencyFixture, sub: string) {
    const make = (provider: string) =>
      prisma.integrationCredential.create({
        data: {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          brandId: fixture.brandId,
          provider,
          accountLabel: "owner@example.com",
          encryptedSecret: `not-used-in-mock-${provider}-${sub}`,
          status: "ACTIVE",
          metadata: { googleSub: sub },
        },
      });
    const [ga, gsc] = await Promise.all([
      make("google_analytics"),
      make("google_search_console"),
    ]);
    const gaLink = await prisma.gaPropertyLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: ga.id,
        propertyId: `risc-${runId}-${fixture.projectId.slice(-6)}`,
        isMock: true,
        health: "OK",
      },
    });
    const gscLinks = await Promise.all(
      [0, 1].map((n) =>
        prisma.gscSiteLink.create({
          data: {
            workspaceId: fixture.workspaceId,
            projectId: fixture.projectId,
            credentialId: gsc.id,
            siteUrl: `https://risc-${runId}-${n}.example.com/`,
            isPrimary: n === 0,
            isSecondary: n === 1,
            isMock: true,
            health: "OK",
          },
        }),
      ),
    );
    return { ga, gsc, gaLink, gscLinks };
  }

  let rowsA: Awaited<ReturnType<typeof connect>>;
  let rowsB: Awaited<ReturnType<typeof connect>>;

  beforeAll(async () => {
    process.env.GA_SYNC = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    a = await createAgencyFixture(`risc-a-${runId}`);
    b = await createAgencyFixture(`risc-b-${runId}`);
    rowsA = await connect(a, subA);
    rowsB = await connect(b, subB);
  }, 60_000);

  afterAll(async () => {
    process.env.GA_SYNC = saved.sync;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    await prisma.googleRiscEvent.deleteMany({ where: { jti } });
    for (const fixture of [a, b]) {
      if (!fixture) continue;
      const where = { workspaceId: fixture.workspaceId };
      await prisma.adsAlert.deleteMany({ where });
      await prisma.gscSiteLink.deleteMany({ where });
      await prisma.gaPropertyLink.deleteMany({ where });
      await prisma.integrationCredential.deleteMany({ where });
      await teardownAgencyFixture(fixture.workspaceId);
    }
  }, 60_000);

  const deps = {
    getKey: async (kid: string) => (kid === key.kid ? key.jwk : null),
    audiences: () => [TEST_RISC_AUDIENCE],
  };
  const token = () =>
    signTestRiscToken(key, {
      jti,
      events: {
        "https://schemas.openid.net/secevent/oauth/event-type/tokens-revoked": {
          subject: {
            subject_type: "iss-sub",
            iss: "https://accounts.google.com/",
            sub: subA,
          },
        },
      },
    });

  it("revokes only the first account and keeps the other one connected", async () => {
    const outcome = await processRiscToken(token(), deps);
    expect(outcome).toMatchObject({ status: "applied", matched: 2 });

    const statuses = async (rows: typeof rowsA) =>
      (
        await prisma.integrationCredential.findMany({
          where: { id: { in: [rows.ga.id, rows.gsc.id] } },
          select: { status: true, metadata: true },
        })
      ).map((row) => row.status);
    expect(await statuses(rowsA)).toEqual(["EXPIRED", "EXPIRED"]);
    expect(await statuses(rowsB)).toEqual(["ACTIVE", "ACTIVE"]);

    const expired = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: rowsA.ga.id },
    });
    expect(expired.metadata).toMatchObject({
      googleSub: subA,
      googleHealth: { state: "NEEDS_RECONNECT", source: "risc" },
    });

    const gaLink = await prisma.gaPropertyLink.findUniqueOrThrow({
      where: { id: rowsA.gaLink.id },
    });
    expect(gaLink.health).toBe("AUTH");
    const gscLinks = await prisma.gscSiteLink.findMany({
      where: { id: { in: rowsA.gscLinks.map((link) => link.id) } },
    });
    expect(gscLinks.map((link) => link.health)).toEqual(["AUTH", "AUTH"]);
    const untouched = await prisma.gscSiteLink.findMany({
      where: { id: { in: rowsB.gscLinks.map((link) => link.id) } },
    });
    expect(untouched.every((link) => link.health === "OK")).toBe(true);

    const alertsA = await prisma.adsAlert.findMany({
      where: { workspaceId: a.workspaceId },
    });
    expect(alertsA.map((alert) => alert.dedupeKey).sort()).toEqual(
      [`ga4:${rowsA.gaLink.id}:MH24`, "gsc:GSC_CONNECTION"].sort(),
    );
    expect(alertsA.every((alert) => alert.severity === "CRITICAL")).toBe(true);
    expect(
      await prisma.adsAlert.count({ where: { workspaceId: b.workspaceId } }),
    ).toBe(0);
  });

  it("the sync runner skips the revoked links", async () => {
    await GaSync.runDue(10, new Date(Date.now() + 60 * 60_000));
    const link = await prisma.gaPropertyLink.findUniqueOrThrow({
      where: { id: rowsA.gaLink.id },
    });
    expect(link.lastDailyAt).toBeNull();
    expect(link.health).toBe("AUTH");
  }, 120_000);

  it("stores the event without any subject value and ignores a second delivery", async () => {
    const row = await prisma.googleRiscEvent.findUniqueOrThrow({
      where: { jti },
    });
    expect(row.outcome).toBe("APPLIED");
    expect(row.matched).toBe(2);
    expect(row.eventKeys).toEqual(["tokens-revoked"]);
    expect(JSON.stringify(row)).not.toContain(subA);

    const auditBefore = await prisma.auditLog.count({
      where: { workspaceId: a.workspaceId, action: "google_risc.credential_expired" },
    });
    const again = await processRiscToken(token(), deps);
    expect(again.status).toBe("duplicate");
    expect(
      await prisma.auditLog.count({
        where: { workspaceId: a.workspaceId, action: "google_risc.credential_expired" },
      }),
    ).toBe(auditBefore);
    expect(auditBefore).toBe(2);
  });
});

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  deleteGaAttributionData,
  deleteGaAttributionDataForCredential,
} from "./cleanup";

// GA-F6 Disconnect temizliği gerçek Postgres'e karşı: yalnız "ga-utm:" GA4
// öğrenmeleri silinir (başka ref'li GA4 ve META_ADS öğrenmeleri kalır);
// projenin BÜTÜN AdsDecision satırlarından ga4_* anahtarları çıkar (1.200
// satır, 500'lük bir toplu işten fazla), diğer anahtarlar ve başka projenin
// satırları dokunulmaz kalır. Search Console kimliği hiçbir şey silmez.
// TrackedLink satırları kalır.

describeIntegration("GA attribution cleanup (GA-F6)", () => {
  const runId = randomUUID().slice(0, 8);
  let fixture: AgencyFixture;
  let other: AgencyFixture;
  let gaCredentialId: string;
  let scCredentialId: string;

  const gaEvidence = (index: number): Prisma.InputJsonValue => ({
    window: { from: "2026-09-01", to: "2026-09-28" },
    cpa: 12.5,
    ga4_source: "GA4",
    ga4_from: "2026-09-22",
    ga4_to: "2026-09-28",
    ga4_sessions: 100 + index,
    ga4_engaged_sessions: 60,
    ga4_key_events: 4.5,
    ga4_covered_days: 7,
  });

  async function seedDecisions(
    projectId: string,
    workspaceId: string,
    tag: string,
    count: number,
    withGa: boolean,
  ) {
    await prisma.adsDecision.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        workspaceId,
        projectId,
        adsAccountId: `acct-${runId}`,
        level: "CAMPAIGN" as const,
        externalId: `cmp-${tag}-${index}`,
        ruleKey: "O2_HIGH_CPA",
        ruleVersion: 1,
        kind: "NOTIFY",
        severity: "INFO" as const,
        status: "PROPOSED" as const,
        evidence: withGa
          ? gaEvidence(index)
          : ({ window: { from: "2026-09-01" }, cpa: 9 } as Prisma.InputJsonValue),
        explanation: "Test decision",
        fingerprint: `ga-clean-${runId}-${tag}-${index}`,
      })),
    });
  }

  async function ga4Count(projectId: string): Promise<number> {
    return prisma.adsDecision.count({
      where: {
        projectId,
        evidence: { path: ["ga4_source"], equals: "GA4" },
      },
    });
  }

  beforeAll(async () => {
    fixture = await createAgencyFixture(`ga-attr-clean-${runId}`);
    other = await createAgencyFixture(`ga-attr-clean-b-${runId}`);
    const credential = (provider: string) =>
      prisma.integrationCredential.create({
        data: {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          brandId: fixture.brandId,
          provider,
          accountLabel: "owner@example.com",
          encryptedSecret: "not-used",
          status: "ACTIVE",
        },
      });
    gaCredentialId = (await credential("google_analytics")).id;
    scCredentialId = (await credential("google_search_console")).id;
  }, 60_000);

  afterAll(async () => {
    for (const item of [fixture, other]) {
      if (!item) continue;
      await prisma.adsDecision.deleteMany({
        where: { projectId: item.projectId },
      });
      await prisma.trackedLink.deleteMany({
        where: { projectId: item.projectId },
      });
      await prisma.brandLearning.deleteMany({
        where: { projectId: item.projectId },
      });
      await prisma.integrationCredential.deleteMany({
        where: { workspaceId: item.workspaceId },
      });
    }
    await teardownAgencyFixture(fixture?.workspaceId);
    await teardownAgencyFixture(other?.workspaceId);
  });

  it("does nothing for a Search Console credential", async () => {
    await seedDecisions(fixture.projectId, fixture.workspaceId, "sc", 3, true);
    await prisma.brandLearning.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        insight: "Visitors from the post did well.",
        sourceType: "GA4",
        sourceRef: "ga-utm:link:sc",
        polarity: "WORKS",
      },
    });
    expect(await deleteGaAttributionDataForCredential(scCredentialId)).toEqual({
      learnings: 0,
      decisions: 0,
    });
    expect(await ga4Count(fixture.projectId)).toBe(3);
    expect(
      await prisma.brandLearning.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(1);
    await prisma.adsDecision.deleteMany({
      where: { projectId: fixture.projectId },
    });
    await prisma.brandLearning.deleteMany({
      where: { projectId: fixture.projectId },
    });
  });

  it("deletes only the ga-utm GA4 learnings", async () => {
    const base = {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      polarity: "WORKS" as const,
    };
    await prisma.brandLearning.createMany({
      data: [
        {
          ...base,
          insight: "Visitors from the campaign did well.",
          sourceType: "GA4",
          sourceRef: "ga-utm:meta:123",
        },
        {
          ...base,
          insight: "Visitors from the bio link did well.",
          sourceType: "GA4",
          sourceRef: "ga-utm:link:abc",
        },
        {
          ...base,
          insight: "Improving a landing page raised its key event rate.",
          sourceType: "GA4",
          sourceRef: "finding-1",
        },
        {
          ...base,
          insight: "Ad creative with people did well.",
          sourceType: "META_ADS",
          sourceRef: "ga-utm:meta:123",
        },
        {
          ...base,
          insight: "A learning without a source.",
        },
      ],
    });
    await prisma.brandLearning.create({
      data: {
        workspaceId: other.workspaceId,
        projectId: other.projectId,
        brandId: other.brandId,
        insight: "Visitors from another campaign did well.",
        sourceType: "GA4",
        sourceRef: "ga-utm:meta:999",
        polarity: "WORKS",
      },
    });

    const result = await deleteGaAttributionDataForCredential(gaCredentialId);
    expect(result).toEqual({ learnings: 2, decisions: 0 });

    const left = await prisma.brandLearning.findMany({
      where: { projectId: fixture.projectId },
      select: { sourceType: true, sourceRef: true },
    });
    expect(left).toHaveLength(3);
    expect(left).toContainEqual({ sourceType: "GA4", sourceRef: "finding-1" });
    expect(left).toContainEqual({
      sourceType: "META_ADS",
      sourceRef: "ga-utm:meta:123",
    });
    expect(
      await prisma.brandLearning.count({
        where: { projectId: other.projectId },
      }),
    ).toBe(1);
  });

  it(
    "strips ga4_* keys from every decision of the project, in batches",
    async () => {
      await seedDecisions(fixture.projectId, fixture.workspaceId, "a", 1200, true);
      await seedDecisions(fixture.projectId, fixture.workspaceId, "b", 50, false);
      await seedDecisions(other.projectId, other.workspaceId, "o", 3, true);
      expect(await ga4Count(fixture.projectId)).toBe(1200);

      const result = await deleteGaAttributionData(fixture.projectId);
      expect(result.decisions).toBe(1200);
      expect(await ga4Count(fixture.projectId)).toBe(0);

      const rows = await prisma.adsDecision.findMany({
        where: { projectId: fixture.projectId },
        select: { evidence: true },
      });
      expect(rows).toHaveLength(1250);
      for (const row of rows) {
        const keys = Object.keys(row.evidence as Record<string, unknown>);
        expect(keys.some((key) => key.startsWith("ga4_"))).toBe(false);
        expect(keys).toContain("cpa");
        expect(keys).toContain("window");
      }

      // Başka projenin satırları dokunulmaz.
      expect(await ga4Count(other.projectId)).toBe(3);
      const untouched = await prisma.adsDecision.findFirstOrThrow({
        where: { projectId: other.projectId },
        select: { evidence: true },
      });
      expect(untouched.evidence).toMatchObject({
        ga4_source: "GA4",
        ga4_sessions: expect.any(Number),
      });

      // İkinci koşu yapacak bir şey bulmaz.
      expect(await deleteGaAttributionData(fixture.projectId)).toEqual({
        learnings: 0,
        decisions: 0,
      });
    },
    120_000,
  );

  it("keeps the tracked links", async () => {
    await prisma.trackedLink.create({
      data: {
        code: `t${runId.slice(0, 5)}`,
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        entityType: "instagram_bio",
        entityId: "bio",
        channel: "instagram",
        destinationUrl: "https://acme.test/",
        taggedUrl:
          "https://acme.test/?utm_source=instagram&utm_medium=social&utm_campaign=agx-bio",
        utmSource: "instagram",
        utmMedium: "social",
        utmCampaign: "agx-bio",
        utmContent: `agx_t${runId.slice(0, 5)}`,
      },
    });
    await deleteGaAttributionDataForCredential(gaCredentialId);
    expect(
      await prisma.trackedLink.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(1);
  });
});

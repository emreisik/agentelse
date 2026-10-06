import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import type { An1Evidence } from "@/lib/website-analytics/analysis/types";
import { dayKeyToDate } from "@/lib/website-analytics/days";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { disconnectGoogleCredential } from "@/server/integrations/google-disconnect";
import { describeIntegration } from "@/test-support/integration-suite";

import { deleteGaInsightDerivedDataForCredential } from "./cleanup";

// GA-F4 Disconnect temizliği gerçek Postgres'e karşı: GA kimliği koparılınca
// ga-insights sinyali, ondan doğan ajans bulgusu ve içgörüsü, dokunulmamış
// fırsat, GA4 öğrenmesi ve havuzdaki "website" fikri silinir; görev olmuş
// fırsat (insightId null kalır), kullanılmış fikir ve başka kaynaklı sinyal
// kalır; onaylanmış (APPROVED) fikir kalır ama kanıt bağlantısı çıkarılır
// (SC-F4 forget kuralı). Search Console kimliği hiçbir şey silmez. Disconnect
// GaFinding ve GaAnalysisRun'ı cascade ile, türeyenleri de hemen siler.

describeIntegration("GA insight disconnect cleanup (GA-F4)", () => {
  const runId = randomUUID().slice(0, 8);
  let fixture: AgencyFixture;
  let gaCredentialId: string;
  let scCredentialId: string;

  type Seeded = {
    signalId: string;
    otherSignalId: string;
    findingId: string;
    insightId: string;
    newOpportunityId: string;
    convertedOpportunityId: string;
    learningId: string;
    poolIdeaId: string;
    usedIdeaId: string;
    approvedIdeaId: string;
  };

  async function seed(tag: string): Promise<Seeded> {
    const base = {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
    };
    const signal = await prisma.signal.create({
      data: {
        ...base,
        source: "ga-insights",
        category: "PERFORMANCE",
        externalRef: `ga:link:AN2:0123456789abcdef:2026-W${tag}`,
        title: "Key events changed on your website",
        fingerprint: `ga-${tag}-${runId}`,
      },
    });
    const otherSignal = await prisma.signal.create({
      data: {
        ...base,
        source: "web-research",
        category: "MARKET",
        title: "A market signal",
        fingerprint: `other-${tag}-${runId}`,
      },
    });
    const finding = await prisma.finding.create({
      data: {
        ...base,
        sourceType: "SIGNAL",
        signalId: signal.id,
        statement: "Key events changed on the website.",
        classification: "LIKELY_FACT",
      },
    });
    const insight = await prisma.insight.create({
      data: {
        ...base,
        title: "Website change",
        summary: "Key events changed.",
        signalIds: [signal.id, otherSignal.id],
        findingIds: [finding.id],
        fingerprint: `insight-${tag}-${runId}`,
      },
    });
    const newOpportunity = await prisma.opportunity.create({
      data: {
        ...base,
        insightId: insight.id,
        title: "Improve the website",
        status: "NEW",
      },
    });
    const convertedOpportunity = await prisma.opportunity.create({
      data: {
        ...base,
        insightId: insight.id,
        title: "Accepted website task",
        status: "CONVERTED_TO_TASK",
      },
    });
    const learning = await prisma.brandLearning.create({
      data: {
        ...base,
        insight: "Improving a landing page raised its key event rate.",
        sourceType: "GA4",
        sourceRef: `finding-${tag}`,
        polarity: "WORKS",
      },
    });
    const concept = (status: string): Prisma.InputJsonValue => ({
      v: 2,
      source: "website",
      note: status,
    });
    const poolIdea = await prisma.idea.create({
      data: {
        ...base,
        title: "What visitors search for",
        description: "An article idea from site search.",
        concept: concept("pool"),
        status: "RAW",
      },
    });
    const usedIdea = await prisma.idea.create({
      data: {
        ...base,
        title: "Used website idea",
        description: "Already planned.",
        concept: concept("used"),
        status: "PLANNING",
      },
    });
    const approvedIdea = await prisma.idea.create({
      data: {
        ...base,
        title: "Approved website idea",
        description: "Put forward by the user.",
        concept: {
          v: 2,
          source: "website",
          note: "approved",
          evidence: [
            {
              title: "Site search",
              url: "https://app.example.com/projects/p/site#finding-f",
            },
          ],
        },
        status: "APPROVED",
      },
    });
    return {
      signalId: signal.id,
      otherSignalId: otherSignal.id,
      findingId: finding.id,
      insightId: insight.id,
      newOpportunityId: newOpportunity.id,
      convertedOpportunityId: convertedOpportunity.id,
      learningId: learning.id,
      poolIdeaId: poolIdea.id,
      usedIdeaId: usedIdea.id,
      approvedIdeaId: approvedIdea.id,
    };
  }

  async function expectRemoved(seeded: Seeded) {
    expect(
      await prisma.signal.findUnique({ where: { id: seeded.signalId } }),
    ).toBeNull();
    expect(
      await prisma.finding.findUnique({ where: { id: seeded.findingId } }),
    ).toBeNull();
    expect(
      await prisma.insight.findUnique({ where: { id: seeded.insightId } }),
    ).toBeNull();
    expect(
      await prisma.opportunity.findUnique({
        where: { id: seeded.newOpportunityId },
      }),
    ).toBeNull();
    expect(
      await prisma.brandLearning.findUnique({
        where: { id: seeded.learningId },
      }),
    ).toBeNull();
    expect(
      await prisma.idea.findUnique({ where: { id: seeded.poolIdeaId } }),
    ).toBeNull();

    const converted = await prisma.opportunity.findUnique({
      where: { id: seeded.convertedOpportunityId },
    });
    expect(converted).not.toBeNull();
    expect(converted?.insightId).toBeNull();
    expect(
      await prisma.idea.findUnique({ where: { id: seeded.usedIdeaId } }),
    ).not.toBeNull();
    const approved = await prisma.idea.findUnique({
      where: { id: seeded.approvedIdeaId },
    });
    expect(approved).not.toBeNull();
    expect(approved?.concept).toEqual({
      v: 2,
      source: "website",
      note: "approved",
    });
    expect(
      await prisma.signal.findUnique({ where: { id: seeded.otherSignalId } }),
    ).not.toBeNull();
  }

  beforeAll(async () => {
    fixture = await createAgencyFixture(`ga-clean-${runId}`);
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
    if (fixture) {
      await prisma.brandLearning.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.gaPropertyLink.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.integrationCredential.deleteMany({
        where: { workspaceId: fixture.workspaceId },
      });
    }
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("does nothing for a Search Console credential", async () => {
    const seeded = await seed("01");
    expect(
      await deleteGaInsightDerivedDataForCredential(scCredentialId),
    ).toEqual({
      signals: 0,
      findings: 0,
      insights: 0,
      opportunities: 0,
      learnings: 0,
      ideas: 0,
    });
    expect(
      await prisma.signal.findUnique({ where: { id: seeded.signalId } }),
    ).not.toBeNull();
    expect(
      await prisma.idea.findUnique({ where: { id: seeded.poolIdeaId } }),
    ).not.toBeNull();
  });

  it("removes the GA-derived rows and keeps what the user already used", async () => {
    // Önceki testin satırları da bu projede: hepsi silinir.
    const seeded = await seed("02");
    const result =
      await deleteGaInsightDerivedDataForCredential(gaCredentialId);
    expect(result).toEqual({
      signals: 2,
      findings: 2,
      insights: 2,
      opportunities: 2,
      learnings: 2,
      // 2 havuz fikri silindi, 2 onaylanmış fikrin kanıtı çıkarıldı.
      ideas: 4,
    });
    await expectRemoved(seeded);
  });

  it(
    "disconnect cascades findings and deletes the derived rows",
    async () => {
      const seeded = await seed("03");
      const credential = await prisma.integrationCredential.findUniqueOrThrow({
        where: { id: gaCredentialId },
      });
      const link = await prisma.gaPropertyLink.create({
        data: {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          credentialId: gaCredentialId,
          propertyId: `clean-${runId}`,
          isPrimary: true,
          timeZone: "Europe/Istanbul",
        },
      });
      const evidence: An1Evidence = {
        v: 1,
        rule: "AN1",
        mode: "day",
        target: "2026-10-05",
        readings: [],
        primary: "sessions",
        excludedDays: [],
        breakdown: null,
        seasonalChecked: false,
        preliminary: false,
      };
      await prisma.gaFinding.create({
        data: {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          linkId: link.id,
          ruleKey: "AN1",
          ruleVersion: 1,
          kind: "ANOMALY",
          subject: "site",
          subjectKey: "0123456789abcdef",
          periodGrain: "DAY",
          periodKey: "2026-10-05",
          periodStart: dayKeyToDate("2026-10-05"),
          periodEnd: dayKeyToDate("2026-10-05"),
          severity: "WARN",
          confidence: "SIGNIFICANT",
          mode: "live",
          evidence: evidence as unknown as Prisma.InputJsonValue,
          fingerprint: `${link.id}:AN1:0123456789abcdef:2026-10-05`,
        },
      });
      await prisma.gaAnalysisRun.create({
        data: {
          linkId: link.id,
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
        },
      });

      // Mock kimlik: Google'a iptal isteği gitmesin diye hesap kimliği yok.
      await disconnectGoogleCredential({ ...credential, metadata: {} });

      expect(
        await prisma.gaFinding.count({
          where: { projectId: fixture.projectId },
        }),
      ).toBe(0);
      expect(
        await prisma.gaAnalysisRun.count({
          where: { projectId: fixture.projectId },
        }),
      ).toBe(0);
      await expectRemoved(seeded);
    },
  );
});

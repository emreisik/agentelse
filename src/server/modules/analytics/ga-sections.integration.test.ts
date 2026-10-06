import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { readGaWindow } from "@/server/website-analytics/readers";
import { ensureGaLinkForProject } from "@/server/website-analytics/sync/links";
import { GaSync } from "@/server/website-analytics/sync/runner";
import { describeIntegration } from "@/test-support/integration-suite";

import { readGaModuleSections } from "./ga-sections";

// Analytics modülünün GA listeleri gerçek Postgres'e karşı (mock Google):
// senkron ambarı doldurduktan sonra 28 günlük pencere kanal, açılış sayfası
// ve key event listelerini verir. Kanal payı pencerenin toplam oturumuna
// göredir (mock'un kanal oturumları toplama eşit değildir, bilerek). Kapalı
// rapor yalnız kendi listesini düşürür; bayrak kapalıyken hiçbir şey dönmez.

const PROPERTY_ID = "424242";

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describeIntegration("Analytics module GA lists (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GA_SYNC,
    sections: process.env.GA_MODULE_SECTIONS,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  let fixture: AgencyFixture;

  beforeAll(async () => {
    process.env.GA_SYNC = "true";
    process.env.GA_MODULE_SECTIONS = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`ga-sections-${runId}`);
    await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_analytics",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used-in-mock-mode",
        status: "ACTIVE",
        metadata: {
          ga4Properties: [
            {
              propertyId: PROPERTY_ID,
              propertyName: "Web",
              accountName: "Acme",
            },
          ],
          selectedGa4PropertyId: PROPERTY_ID,
          selectedGa4PropertyName: "Web",
        },
      },
    });
    // Bağ doğrudan kurulur: runDue'nun periyodik bağ eşitlemesi (ga.links
    // kilidi) aynı veritabanındaki başka bir test dosyasınca alınmış olabilir.
    await ensureGaLinkForProject(fixture.projectId);
    // Geri doldurma tur başına en çok 10 istek: birkaç tur sürer.
    for (let round = 0; round < 10; round += 1) {
      await GaSync.runDue(3, new Date());
      const link = await prisma.gaPropertyLink.findFirst({
        where: { projectId: fixture.projectId },
      });
      if (link?.backfillDoneAt) break;
    }
  }, 240_000);

  afterAll(async () => {
    restoreEnv("GA_SYNC", saved.sync);
    restoreEnv("GA_MODULE_SECTIONS", saved.sections);
    restoreEnv("AGENTELSE_PROVIDER_MODE", saved.mode);
    await prisma.gaPropertyLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  async function window28() {
    const window = await readGaWindow({
      projectId: fixture.projectId,
      propertyId: PROPERTY_ID,
      days: 28,
    });
    if (!window) throw new Error("the warehouse does not cover 28 days");
    return window;
  }

  it("lists channels, landing pages and key events for a fully covered window", async () => {
    const window = await window28();
    const lists = await readGaModuleSections({
      projectId: fixture.projectId,
      propertyId: PROPERTY_ID,
      window,
    });
    expect(lists.channels?.length).toBeGreaterThan(0);
    expect(window.totals.sessions).toBeGreaterThan(0);
    for (const row of lists.channels ?? []) {
      expect(row.share, row.channel).toBe(
        round1((row.sessions / window.totals.sessions) * 100),
      );
    }
    expect(lists.landingPages?.length).toBeGreaterThan(0);
    expect(lists.keyEvents?.map((event) => event.name)).toContain(
      "generate_lead",
    );
  });

  it("gives nothing for a different property", async () => {
    const window = await window28();
    expect(
      await readGaModuleSections({
        projectId: fixture.projectId,
        propertyId: "999999",
        window,
      }),
    ).toEqual({});
  });

  it("drops only the list of a disabled report", async () => {
    const link = await prisma.gaPropertyLink.findFirstOrThrow({
      where: { projectId: fixture.projectId, isPrimary: true },
    });
    const before = link.catalog;
    await prisma.gaPropertyLink.update({
      where: { id: link.id },
      data: {
        catalog: {
          landing_page: {
            reason: "FIELD_MISSING: landingPage",
            at: new Date().toISOString(),
          },
        },
      },
    });
    try {
      const lists = await readGaModuleSections({
        projectId: fixture.projectId,
        propertyId: PROPERTY_ID,
        window: await window28(),
      });
      expect(lists.landingPages).toBeUndefined();
      expect(lists.channels?.length).toBeGreaterThan(0);
      expect(lists.keyEvents?.length).toBeGreaterThan(0);
    } finally {
      await prisma.gaPropertyLink.update({
        where: { id: link.id },
        data: { catalog: before ?? {} },
      });
    }
  });

  it("gives nothing with GA_MODULE_SECTIONS off", async () => {
    const window = await window28();
    process.env.GA_MODULE_SECTIONS = "false";
    try {
      expect(
        await readGaModuleSections({
          projectId: fixture.projectId,
          propertyId: PROPERTY_ID,
          window,
        }),
      ).toEqual({});
    } finally {
      process.env.GA_MODULE_SECTIONS = "true";
    }
  });
});

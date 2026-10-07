import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import {
  createGaAdminWriter,
  type GaAdminWriter,
} from "@/server/integrations/google-analytics/admin-write";
import {
  mockGaAdminPushChange,
  resetMockGaAdmin,
  seedMockGaAdmin,
} from "@/server/integrations/google-analytics/admin-write-mock";
import { disconnectGoogleCredential } from "@/server/integrations/google-disconnect";
import { describeIntegration } from "@/test-support/integration-suite";

import { GaChangeWatcher } from "./change-watch";

// GA-F7 değişiklik geçmişi bekçisi gerçek Postgres'e karşı (mock Google): ilk
// tur yalnız imleci kurar; elle silinen anahtar olay ertesi turda tek uyarı
// açar; sonraki tur aynı uyarıyı çoğaltmaz (dedupe); olay geri gelince uyarı
// çözülür; Disconnect izleme satırını ve uyarıları siler.

const PROPERTY_ID = "424242";
const HOUR = 60 * 60 * 1000;
const DAILY = "GA_CHG_KEY_EVENT_REMOVED";

describeIntegration("GA change-history watch (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    fixes: process.env.GA_FIXES,
    sync: process.env.GA_SYNC,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  const t0 = new Date("2026-10-07T09:00:00.000Z");
  const at = (hours: number) => new Date(t0.getTime() + hours * HOUR);
  let fixture: AgencyFixture;
  let credentialId: string;
  let linkId: string;
  let writer: GaAdminWriter;

  function restoreEnv(value: string | undefined, key: string) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const alerts = () =>
    prisma.adsAlert.findMany({
      where: { projectId: fixture.projectId, source: "GA4", kind: DAILY },
    });

  beforeAll(async () => {
    process.env.GA_FIXES = "true";
    process.env.GA_SYNC = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    resetMockGaAdmin();
    seedMockGaAdmin(PROPERTY_ID, { keyEvents: ["purchase", "generate_lead"] });
    writer = createGaAdminWriter("mock-token");

    fixture = await createAgencyFixture(`ga-watch-${runId}`);
    const credential = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_analytics",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used-in-mock-mode",
        status: "ACTIVE",
        metadata: { selectedGa4PropertyId: PROPERTY_ID },
      },
    });
    credentialId = credential.id;
    const link = await prisma.gaPropertyLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId,
        propertyId: PROPERTY_ID,
        accountId: "777",
        isPrimary: true,
        isMock: true,
      },
    });
    linkId = link.id;
  }, 60_000);

  afterAll(async () => {
    restoreEnv(saved.fixes, "GA_FIXES");
    restoreEnv(saved.sync, "GA_SYNC");
    restoreEnv(saved.mode, "AGENTELSE_PROVIDER_MODE");
    resetMockGaAdmin();
    await prisma.adsAlert.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.gaPropertyLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("the first run only sets the cursor", async () => {
    expect(await GaChangeWatcher.runDue(3, t0)).toBe(1);
    const watch = await prisma.gaChangeWatch.findUniqueOrThrow({
      where: { linkId },
    });
    expect(watch.cursorAt?.getTime()).toBe(t0.getTime());
    expect(watch.lastRunAt?.getTime()).toBe(t0.getTime());
    expect(watch.lastError).toBeNull();
    expect(await alerts()).toHaveLength(0);
    // Aynı gün ikinci tur: 23 saat dolmadığı için aday değil.
    expect(await GaChangeWatcher.runDue(3, at(1))).toBe(0);
  });

  it("raises one alert for a manual key event removal, stays quiet on the dedupe run, and resolves it when the event is back", async () => {
    // Biri Google Analytics'te anahtar olayı elle sildi (23,5. saatte).
    const leads = (await writer.listKeyEvents(PROPERTY_ID)).find(
      (item) => item.eventName === "generate_lead",
    );
    expect(leads).toBeDefined();
    await writer.deleteKeyEvent(leads!.name);
    mockGaAdminPushChange(PROPERTY_ID, {
      resource: leads!.name,
      action: "DELETED",
      before: { keyEvent: { eventName: "generate_lead" } },
      at: at(23.5),
    });

    expect(await GaChangeWatcher.runDue(3, at(24))).toBe(1);
    let rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      severity: "WARN",
      status: "OPEN",
      dedupeKey: `ga4:${linkId}:CHG:KEY_EVENT_REMOVED:generate_lead`,
      title: "A key event was removed in Google Analytics",
    });
    const watch = await prisma.gaChangeWatch.findUniqueOrThrow({
      where: { linkId },
    });
    expect(watch.lastAlertCount).toBe(1);
    expect(watch.cursorAt?.getTime()).toBe(at(24).getTime());

    // Ertesi tur: 1 saatlik örtüşme olayı yeniden görür, uyarı çoğalmaz.
    expect(await GaChangeWatcher.runDue(3, at(48))).toBe(1);
    rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("OPEN");

    // Olay geri geldi: olay penceresi dışında; canlı okuma uyarıyı kapatır.
    await writer.createKeyEvent(PROPERTY_ID, "generate_lead");
    expect(await GaChangeWatcher.runDue(3, at(72))).toBe(1);
    rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("RESOLVED");
  });

  it("Disconnect removes the watch row and the alerts", async () => {
    expect(
      await prisma.gaChangeWatch.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(1);
    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    // Mock kimlik: Google'a iptal isteği gitmesin diye hesap kimliği yok.
    await disconnectGoogleCredential({ ...credential, metadata: {} });
    expect(
      await prisma.gaChangeWatch.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(0);
    expect(await alerts()).toHaveLength(0);
  });
});

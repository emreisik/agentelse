import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { funnelPreset } from "@/lib/website-analytics/funnel/definition";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { disconnectGoogleCredential } from "@/server/integrations/google-disconnect";
import { describeIntegration } from "@/test-support/integration-suite";

import { ensureGaLinkForProject } from "../sync/links";
import { runFunnel } from "./run";
import {
  deleteFunnel,
  GA_MAX_FUNNELS_PER_LINK,
  listFunnels,
  saveFunnel,
} from "./store";

// Huni raporu gerçek Postgres'e karşı (mock mod, Google'a gidilmez): hazır
// tanım kaydedilir, çalıştırılır, sonuç ve özet cümle okunur; 6. huni reddedilir;
// ek (ikincil) mülkte de çalışır; Disconnect hunileri cascade ile siler.

describeIntegration("GA funnels (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const keys = [
    "GA_SYNC",
    "GA_AGENCY",
    "GA_FUNNEL",
    "AGENTELSE_PROVIDER_MODE",
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let fixture: AgencyFixture;
  let credentialId: string;
  let linkId: string;

  beforeAll(async () => {
    process.env.GA_SYNC = "true";
    process.env.GA_AGENCY = "true";
    process.env.GA_FUNNEL = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`gafn-${runId}`);
    const credential = await prisma.integrationCredential.create({
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
            { propertyId: "515151", propertyName: "Web", accountName: "Acme" },
          ],
          selectedGa4PropertyId: "515151",
          selectedGa4PropertyName: "Web",
        },
      },
    });
    credentialId = credential.id;
    await ensureGaLinkForProject(fixture.projectId);
    const link = await prisma.gaPropertyLink.findFirstOrThrow({
      where: { projectId: fixture.projectId },
    });
    linkId = link.id;
  }, 60_000);

  afterAll(async () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await prisma.gaPropertyLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  const definition = (name: string) => ({
    ...(funnelPreset("lead")?.definition ??
      (() => {
        throw new Error("preset missing");
      })()),
    name,
  });

  it("saves a preset funnel, runs it and lists the result with its insight", async () => {
    const saved = await saveFunnel({
      projectId: fixture.projectId,
      linkId,
      userId: "user-test",
      definition: definition("Lead funnel"),
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(
      await runFunnel({ projectId: fixture.projectId, funnelId: saved.id }),
    ).toBe("ok");
    const funnels = await listFunnels(fixture.projectId, linkId);
    expect(funnels).toHaveLength(1);
    const [funnel] = funnels;
    expect(funnel?.steps).toHaveLength(3);
    expect(funnel?.result?.steps).toHaveLength(3);
    expect(funnel?.result?.steps[0]?.users).toBeGreaterThan(0);
    expect(funnel?.insight?.headline).toContain("Visit");
    expect(funnel?.lastError).toBeNull();
    // Hemen yeniden çalıştırma 10 dakika hız sınırına takılır.
    expect(
      await runFunnel({ projectId: fixture.projectId, funnelId: saved.id }),
    ).toBe("throttled");
    // Sayaç bugünün UTC günüyle bir kez artmış olmalı.
    const row = await prisma.gaFunnel.findUniqueOrThrow({
      where: { id: saved.id },
    });
    expect(row.runsToday).toBe(1);
    expect(row.runDay).toBe(new Date().toISOString().slice(0, 10));
  });

  it("refuses the 6th funnel on a property and lets a deleted slot be reused", async () => {
    const ids: string[] = [];
    for (let index = 0; index < GA_MAX_FUNNELS_PER_LINK - 1; index += 1) {
      const result = await saveFunnel({
        projectId: fixture.projectId,
        linkId,
        userId: "user-test",
        definition: definition(`Extra ${index}`),
      });
      expect(result.ok).toBe(true);
      if (result.ok) ids.push(result.id);
    }
    const sixth = await saveFunnel({
      projectId: fixture.projectId,
      linkId,
      userId: "user-test",
      definition: definition("One too many"),
    });
    expect(sixth).toEqual({ ok: false, reason: "limit" });
    expect(await deleteFunnel({ projectId: fixture.projectId, funnelId: ids[0] ?? "" })).toBe("ok");
    expect(
      (
        await saveFunnel({
          projectId: fixture.projectId,
          linkId,
          userId: "user-test",
          definition: definition("Reused slot"),
        })
      ).ok,
    ).toBe(true);
    expect(
      await deleteFunnel({ projectId: fixture.projectId, funnelId: "missing" }),
    ).toBe("not_found");
  });

  it("rejects an invalid definition and another project's link", async () => {
    const invalid = await saveFunnel({
      projectId: fixture.projectId,
      linkId,
      userId: "user-test",
      definition: { ...definition("Bad"), steps: [] },
    });
    expect(invalid).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await saveFunnel({
        projectId: fixture.projectId,
        linkId: "not-a-link",
        userId: "user-test",
        definition: definition("Nowhere"),
      }),
    ).toEqual({ ok: false, reason: "no_link" });
  });

  it("works on an extra (secondary) property too", async () => {
    const extra = await prisma.gaPropertyLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId,
        propertyId: "616161",
        isPrimary: false,
        isSecondary: true,
        isMock: true,
      },
    });
    const saved = await saveFunnel({
      projectId: fixture.projectId,
      linkId: extra.id,
      userId: "user-test",
      definition: definition("Extra property funnel"),
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(
      await runFunnel({ projectId: fixture.projectId, funnelId: saved.id }),
    ).toBe("ok");
    expect(
      (await listFunnels(fixture.projectId, extra.id))[0]?.result,
    ).not.toBeNull();
    // Ana mülkün listesi ek mülkün hunisini görmez.
    expect(
      (await listFunnels(fixture.projectId, linkId)).map((item) => item.name),
    ).not.toContain("Extra property funnel");
  });

  it("deletes every funnel when Google is disconnected", async () => {
    expect(
      await prisma.gaFunnel.count({ where: { projectId: fixture.projectId } }),
    ).toBeGreaterThan(0);
    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    await disconnectGoogleCredential({ ...credential, metadata: {} });
    expect(
      await prisma.gaFunnel.count({ where: { projectId: fixture.projectId } }),
    ).toBe(0);
  });
});

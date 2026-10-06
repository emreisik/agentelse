import { randomUUID } from "node:crypto";

import type { GaPropertyLink, Prisma } from "@prisma/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import {
  parseGaCatalogState,
  serializeGaCatalogState,
} from "@/lib/website-analytics/catalog-state";
import { safeTimezone } from "@/lib/website-analytics/days";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { loadGaHealthCounters } from "../health-counters";
import { syncCatalogChecks } from "./catalog-checks";
import type { GaSyncContext } from "./context";
import { ensureGaLinkForProject } from "./links";
import { syncMetadata } from "./metadata";

// Katalog denetimi gerçek Postgres'e karşı (mock Google): catalog v2 olarak
// yazılır, Search Console açılır, Google Ads bağlantısız kapalı kalır ve
// bağlantı gelince açılır; eski düz biçimde 30 gün önce düşmüş rapor yeniden
// açılır; /health sayaçları okunur.

describeIntegration("GA catalog checks (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GA_SYNC,
    checks: process.env.GA_CATALOG_CHECKS,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  let fixture: AgencyFixture;

  // runner.syncLink'teki bağlam.
  function contextFor(link: GaPropertyLink, now: Date): GaSyncContext {
    const timeZone = safeTimezone(link.timeZone);
    return {
      link,
      accessToken: "mock-access-token",
      timeZone,
      today: dayKeyInTimezone(now, timeZone),
      now,
      lane: "P2",
      disabled: new Set(
        Object.keys(parseGaCatalogState(link.catalog).disabled),
      ),
      quota: null,
      serverErrors: null,
      rateLimitedUntil: link.rateLimitedUntil,
    };
  }

  async function primaryLink(): Promise<GaPropertyLink> {
    return prisma.gaPropertyLink.findFirstOrThrow({
      where: { projectId: fixture.projectId, isPrimary: true },
    });
  }

  beforeAll(async () => {
    process.env.GA_SYNC = "true";
    process.env.GA_CATALOG_CHECKS = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`ga-catalog-${runId}`);
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
            { propertyId: "434343", propertyName: "Web", accountName: "Acme" },
          ],
          selectedGa4PropertyId: "434343",
          selectedGa4PropertyName: "Web",
        },
      },
    });
    await ensureGaLinkForProject(fixture.projectId);
  }, 60_000);

  afterAll(async () => {
    process.env.GA_SYNC = saved.sync;
    process.env.GA_CATALOG_CHECKS = saved.checks;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    await prisma.gaPropertyLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("writes catalog v2 with Search Console on and Google Ads off without a link", async () => {
    const now = new Date();
    const ctx = contextFor(await primaryLink(), now);
    await syncMetadata(ctx);
    await syncCatalogChecks(ctx);

    const link = await primaryLink();
    const catalog = link.catalog as Record<string, unknown>;
    expect(catalog.v).toBe(2);
    const state = parseGaCatalogState(link.catalog);
    expect(state.optional.search_console?.enabled).toBe(true);
    expect(state.optional.google_ads).toMatchObject({
      enabled: false,
      reason: "NO_ADS_LINK",
    });
    expect(state.check?.at).toBe(now.toISOString());
    expect(state.check?.missing).toEqual({});
    expect(state.check?.deprecated).toEqual([]);
    expect(state.check?.error).toBeUndefined();
    expect(state.disabled).toEqual({});
    expect(ctx.link.id).toBe(link.id);
    expect(ctx.disabled.size).toBe(0);
  }, 60_000);

  it("turns Google Ads on once the property is linked", async () => {
    const before = await primaryLink();
    const state = parseGaCatalogState(before.catalog);
    await prisma.gaPropertyLink.update({
      where: { id: before.id },
      data: {
        linkedProducts: { googleAds: 1 } as Prisma.InputJsonValue,
        catalog: serializeGaCatalogState({
          ...state,
          check: null,
        }) as Prisma.InputJsonValue,
      },
    });
    const ctx = contextFor(await primaryLink(), new Date());
    await syncCatalogChecks(ctx);

    const after = parseGaCatalogState((await primaryLink()).catalog);
    expect(after.optional.google_ads).toMatchObject({
      enabled: true,
      reason: null,
    });
    expect(after.optional.search_console?.enabled).toBe(true);
  }, 60_000);

  it("re-enables a report dropped 30 days ago in the old flat catalog", async () => {
    const link = await primaryLink();
    const at = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await prisma.gaPropertyLink.update({
      where: { id: link.id },
      data: {
        catalog: { landing_page: { reason: "x", at } } as Prisma.InputJsonValue,
      },
    });
    const ctx = contextFor(await primaryLink(), new Date());
    expect(ctx.disabled.has("landing_page")).toBe(true);
    await syncCatalogChecks(ctx);

    const stored = (await primaryLink()).catalog as Record<string, unknown>;
    expect(stored.v).toBe(2);
    expect(parseGaCatalogState(stored).disabled).toEqual({});
    expect(ctx.disabled.has("landing_page")).toBe(false);
  }, 60_000);

  it("loads the /health counters", async () => {
    const counters = await loadGaHealthCounters();
    expect(counters).not.toBeNull();
    expect(counters!.links.total).toBeGreaterThanOrEqual(1);
    expect(counters!.links.mock).toBeGreaterThanOrEqual(1);
    expect(counters!.catalog.searchConsoleEnabled).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

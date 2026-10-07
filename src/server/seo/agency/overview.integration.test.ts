import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

// Sorgu sayacı: gerçek Prisma istemcisini sarar; yalnız `counter.on` açıkken
// model işlemlerini ve $queryRaw'ı sayar.
const counter = vi.hoisted(() => ({ on: false, queries: 0 }));

vi.mock("@/lib/prisma", async () => {
  const actual = await vi.importActual<typeof import("@/lib/prisma")>(
    "@/lib/prisma",
  );
  const real = actual.prisma;
  const proxy = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "$queryRaw" || prop === "$executeRaw") {
        return (...args: unknown[]) => {
          if (counter.on) counter.queries += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (
        typeof prop === "string" &&
        !prop.startsWith("$") &&
        value &&
        typeof value === "object"
      ) {
        return new Proxy(value as object, {
          get(delegate, method) {
            const fn = Reflect.get(delegate, method) as unknown;
            if (typeof fn !== "function") return fn;
            return (...args: unknown[]) => {
              if (counter.on) counter.queries += 1;
              return (fn as (...a: unknown[]) => unknown).apply(delegate, args);
            };
          },
        });
      }
      return value;
    },
  });
  return { prisma: proxy };
});

import { addDays } from "@/lib/seo/dates";
import { prisma } from "@/lib/prisma";
import { describeIntegration } from "@/test-support/integration-suite";

import { loadSearchAgencyOverview } from "./overview";

// Çalışma alanı genel bakışı gerçek Postgres'e karşı: 20 siteyi en çok 7
// sorguyla listeler, her bağ KENDİ son kesin gününe göre 28 gün ve önceki 28
// günü toplar, başka workspace'in ve başka kipin bağlarını katmaz.
// createAgencyFixture bağ ve günlük toplamları silmez: bu test kendi
// satırlarını afterAll'da temizler.

describeIntegration("Search agency overview (real Postgres)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    agency: process.env.GSC_AGENCY,
    sync: process.env.GSC_SYNC,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
    insights: process.env.SEO_INSIGHTS,
  };
  const SITE_COUNT = 20;
  const BASE_FINAL = "2026-10-05";

  let workspaceId = "";
  let otherWorkspaceId = "";
  const projectIds: string[] = [];
  const linkIds: string[] = [];
  const finalDates: string[] = [];
  let secondaryLinkId = "";
  let mockLinkId = "";
  let foreignLinkId = "";

  const multiplier = (index: number) => (index % 4) + 1;

  async function createProject(
    workspace: string,
    index: number,
  ): Promise<string> {
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace,
        name: `Overview ${runId} ${index}`,
        slug: `overview-${runId}-${index}`,
      },
    });
    return project.id;
  }

  beforeAll(async () => {
    process.env.GSC_AGENCY = "true";
    process.env.GSC_SYNC = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "live";
    process.env.SEO_INSIGHTS = "off";

    const [workspace, other] = await Promise.all([
      prisma.workspace.create({
        data: { name: `Overview ${runId}`, slug: `overview-${runId}` },
      }),
      prisma.workspace.create({
        data: { name: `Overview other ${runId}`, slug: `overview-other-${runId}` },
      }),
    ]);
    workspaceId = workspace.id;
    otherWorkspaceId = other.id;

    for (let index = 0; index < SITE_COUNT; index += 1) {
      const projectId = await createProject(workspaceId, index);
      projectIds.push(projectId);
      // Her bağın kesin günü farklı (0-4 gün geriye)
      const finalDate = addDays(BASE_FINAL, -(index % 5));
      finalDates.push(finalDate);
      const link = await prisma.gscSiteLink.create({
        data: {
          workspaceId,
          projectId,
          credentialId: `cred-${runId}`,
          siteUrl: `sc-domain:site-${runId}-${index}.com`,
          isPrimary: true,
          lastFinalDate: finalDate,
          health: "OK",
          backfillDoneAt: new Date(),
        },
      });
      linkIds.push(link.id);

      const m = multiplier(index);
      const totals = [];
      // fd-69 .. fd+2: pencerenin dışı günler (fd'den sonra ve 56 günden eski)
      // büyük değerli; sayılırsa toplam bozulur.
      for (let offset = -2; offset <= 69; offset += 1) {
        const date = addDays(finalDate, -offset);
        const inLast = offset >= 0 && offset <= 27;
        const inPrevious = offset >= 28 && offset <= 55;
        totals.push({
          linkId: link.id,
          projectId,
          date: new Date(`${date}T00:00:00.000Z`),
          searchType: "web",
          clicks: inLast ? 10 * m : inPrevious ? 4 * m : 1000,
          impressions: inLast ? 100 * m : inPrevious ? 50 : 5000,
          positionWeighted: inLast ? 300 * m : 0,
          fresh: false,
          fetchedAt: new Date(),
        });
      }
      // Web olmayan arama türü sayılmaz
      totals.push({
        linkId: link.id,
        projectId,
        date: new Date(`${finalDate}T00:00:00.000Z`),
        searchType: "image",
        clicks: 777,
        impressions: 777,
        positionWeighted: 0,
        fresh: false,
        fetchedAt: new Date(),
      });
      await prisma.gscDailyTotal.createMany({ data: totals });
    }

    // Aynı projede ikincil site, geriye çekilmiş bağ (listelenmez), sahte kip
    // ve başka workspace'in bağı.
    secondaryLinkId = (
      await prisma.gscSiteLink.create({
        data: {
          workspaceId,
          projectId: projectIds[0] as string,
          credentialId: `cred-${runId}`,
          siteUrl: `https://secondary-${runId}.example.com/`,
          isPrimary: false,
          isSecondary: true,
          health: "OK",
        },
      })
    ).id;
    await prisma.gscSiteLink.create({
      data: {
        workspaceId,
        projectId: projectIds[1] as string,
        credentialId: `cred-${runId}`,
        siteUrl: `sc-domain:retired-${runId}.com`,
        isPrimary: false,
        isSecondary: false,
        demotedAt: new Date(),
      },
    });
    mockLinkId = (
      await prisma.gscSiteLink.create({
        data: {
          workspaceId,
          projectId: projectIds[2] as string,
          credentialId: `cred-${runId}`,
          siteUrl: `sc-domain:mock-${runId}.com`,
          isPrimary: false,
          isSecondary: true,
          isMock: true,
        },
      })
    ).id;
    const otherProjectId = await createProject(otherWorkspaceId, 0);
    projectIds.push(otherProjectId);
    foreignLinkId = (
      await prisma.gscSiteLink.create({
        data: {
          workspaceId: otherWorkspaceId,
          projectId: otherProjectId,
          credentialId: `cred-${runId}`,
          siteUrl: `sc-domain:foreign-${runId}.com`,
          isPrimary: true,
        },
      })
    ).id;
  });

  afterAll(async () => {
    process.env.GSC_AGENCY = saved.agency;
    process.env.GSC_SYNC = saved.sync;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    process.env.SEO_INSIGHTS = saved.insights;
    for (const key of ["GSC_AGENCY", "GSC_SYNC", "AGENTELSE_PROVIDER_MODE", "SEO_INSIGHTS"]) {
      if (process.env[key] === undefined) delete process.env[key];
    }
    const workspaces = [workspaceId, otherWorkspaceId].filter(Boolean);
    // Günlük toplamlar ve bağlar fixture ile silinmez; proje ve workspace'ten
    // önce açıkça temizlenir.
    await prisma.gscDailyTotal.deleteMany({
      where: { projectId: { in: projectIds } },
    });
    await prisma.gscSiteLink.deleteMany({
      where: { workspaceId: { in: workspaces } },
    });
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
  });

  it("lists the 20 sites of the workspace with at most 7 queries", async () => {
    counter.queries = 0;
    counter.on = true;
    const overview = await loadSearchAgencyOverview(workspaceId, new Date("2026-10-07T12:00:00.000Z"));
    counter.on = false;

    const primaries = overview.rows.filter((row) => row.role === "PRIMARY");
    expect(primaries).toHaveLength(SITE_COUNT);
    // 20 birincil + 1 ikincil; geriye çekilmiş ve sahte kip bağı yok
    expect(overview.rows).toHaveLength(SITE_COUNT + 1);
    expect(overview.truncated).toBe(false);
    expect(counter.queries).toBeLessThanOrEqual(7);
    expect(counter.queries).toBeGreaterThan(0);
  });

  it("sums 28 and previous 28 days per link from its own last final date", async () => {
    const overview = await loadSearchAgencyOverview(workspaceId, new Date("2026-10-07T12:00:00.000Z"));
    for (let index = 0; index < SITE_COUNT; index += 1) {
      const m = multiplier(index);
      const row = overview.rows.find((r) => r.linkId === linkIds[index]);
      expect(row, `link ${index}`).toBeDefined();
      expect(row?.finalThrough).toBe(finalDates[index]);
      expect(row?.clicks).toBe(280 * m);
      expect(row?.previousClicks).toBe(112 * m);
      expect(row?.clicksChangePct).toBe(150);
      expect(row?.impressions).toBe(2800 * m);
      expect(row?.position).toBe(3);
      expect(row?.projectName).toBe(`Overview ${runId} ${index}`);
    }
  });

  it("marks the secondary site with no engine fields", async () => {
    const overview = await loadSearchAgencyOverview(workspaceId);
    const secondary = overview.rows.find((row) => row.linkId === secondaryLinkId);
    expect(secondary).toMatchObject({
      role: "SECONDARY",
      healthScore: null,
      openOpportunities: null,
      critical: 0,
      warn: 0,
      clicks: null,
    });
  });

  it("never mixes in another workspace or the other mode", async () => {
    const live = await loadSearchAgencyOverview(workspaceId);
    const ids = live.rows.map((row) => row.linkId);
    expect(ids).not.toContain(foreignLinkId);
    expect(ids).not.toContain(mockLinkId);

    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    try {
      const mock = await loadSearchAgencyOverview(workspaceId);
      expect(mock.rows.map((row) => row.linkId)).toEqual([mockLinkId]);
      expect(mock.rows[0]?.isMock).toBe(true);
    } finally {
      process.env.AGENTELSE_PROVIDER_MODE = "live";
    }

    const other = await loadSearchAgencyOverview(otherWorkspaceId);
    expect(other.rows.map((row) => row.linkId)).toEqual([foreignLinkId]);
  });

  it("returns an empty overview when the flag is off", async () => {
    process.env.GSC_AGENCY = "false";
    try {
      const overview = await loadSearchAgencyOverview(workspaceId);
      expect(overview.rows).toEqual([]);
    } finally {
      process.env.GSC_AGENCY = "true";
    }
  });
});

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ notifyProject: vi.fn() }));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/server/notifications/project-telegram-notifier", () => ({
  notifyProjectTelegram: mocks.notifyProject,
}));
vi.mock("@/lib/app-url", () => ({
  appUrl: (path: string) => new URL(path, "https://app.example"),
}));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { SiteAlerts } from "./site-alerts";

// SiteAlerts gerçek Postgres'e karşı: ortak AdsAlert tablosunda `source`
// sütunuyla yaşar; tekrar raise tek satır kalır, resolveMissing / listOpen /
// mute / toplu yardımcılar yalnız kendi kaynağına dokunur, Meta (source null)
// satırları ve başka kaynaklar etkilenmez.

describeIntegration("SiteAlerts (shared AdsAlert table)", () => {
  const runId = randomUUID().slice(0, 8);
  let fixture: AgencyFixture;
  const now = new Date();

  function ga(key: string, severity: "WARN" | "CRITICAL" = "WARN") {
    return {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      source: "GA4" as const,
      kind: `GA_${key}`,
      severity,
      dedupeKey: `ga4:link-${runId}:${key}`,
      title: `Title ${key}`,
      detail: null,
      data: { checkKey: key, linkId: `link-${runId}` },
    };
  }

  async function rowsBy(dedupeKey: string) {
    return prisma.adsAlert.findMany({
      where: { projectId: fixture.projectId, dedupeKey },
    });
  }

  beforeAll(async () => {
    fixture = await createAgencyFixture(`site-alerts-${runId}`);
    // Aynı türde bir Meta satırı (source null) ve bir GSC satırı.
    await prisma.adsAlert.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        kind: "GA_MH7",
        severity: "WARN",
        dedupeKey: `meta-${runId}`,
        title: "Meta row",
      },
    });
    await prisma.adsAlert.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        source: "GSC",
        kind: "GSC_SEARCH_DROP",
        severity: "WARN",
        dedupeKey: "gsc:GSC_SEARCH_DROP",
        title: "GSC row",
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.adsAlert.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("raising twice keeps one GA4 row", async () => {
    await SiteAlerts.raise(ga("MH7"), now);
    await SiteAlerts.raise(ga("MH7"), new Date(now.getTime() + 1_000));
    const rows = await rowsBy(`ga4:link-${runId}:MH7`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "GA4",
      status: "OPEN",
      kind: "GA_MH7",
    });
  });

  it("a CRITICAL alert without a project Telegram stays in-app", async () => {
    await SiteAlerts.raise(ga("MH1", "CRITICAL"), now);
    const [row] = await rowsBy(`ga4:link-${runId}:MH1`);
    expect(row?.notifyChannels).toEqual(["in_app"]);
    expect(row?.notifiedAt).not.toBeNull();
    expect(mocks.notifyProject).not.toHaveBeenCalled();
  });

  it("listOpen returns only the requested sources", async () => {
    const ga4 = await SiteAlerts.listOpen(fixture.projectId, ["GA4"]);
    expect(ga4.map((alert) => alert.source)).toEqual(["GA4", "GA4"]);
    expect(ga4[0]!.severity).toBe("CRITICAL");
    const gsc = await SiteAlerts.listOpen(fixture.projectId, ["GSC"]);
    expect(gsc.map((alert) => alert.dedupeKey)).toEqual([
      "gsc:GSC_SEARCH_DROP",
    ]);
  });

  it("mute hides a site alert", async () => {
    const [row] = await rowsBy(`ga4:link-${runId}:MH7`);
    await SiteAlerts.mute(row!.id, fixture.projectId, 7);
    const open = await SiteAlerts.listOpen(fixture.projectId, ["GA4"]);
    expect(open.map((alert) => alert.kind)).toEqual(["GA_MH1"]);
    // Meta satırı susturulamaz.
    const [meta] = await rowsBy(`meta-${runId}`);
    await SiteAlerts.mute(meta!.id, fixture.projectId, 7);
    const [metaAfter] = await rowsBy(`meta-${runId}`);
    expect(metaAfter?.status).toBe("OPEN");
  });

  it("resolveMissing closes only GA4 kinds that are not still open", async () => {
    const resolved = await SiteAlerts.resolveMissing(
      {
        projectId: fixture.projectId,
        source: "GA4",
        kinds: ["GA_MH1", "GA_MH7"],
        stillOpen: new Set([`ga4:link-${runId}:MH1`]),
      },
      now,
    );
    expect(resolved).toBe(1);
    const [mh7] = await rowsBy(`ga4:link-${runId}:MH7`);
    const [mh1] = await rowsBy(`ga4:link-${runId}:MH1`);
    const [meta] = await rowsBy(`meta-${runId}`);
    expect(mh7?.status).toBe("RESOLVED");
    expect(mh1?.status).toBe("OPEN");
    expect(meta?.status).toBe("OPEN");
  });

  it("resolveForProjects and deleteForProjects touch only their source", async () => {
    expect(
      await SiteAlerts.resolveForProjects([fixture.projectId], "GA4", now),
    ).toBe(1);
    const [gscRow] = await rowsBy("gsc:GSC_SEARCH_DROP");
    expect(gscRow?.status).toBe("OPEN");

    expect(await SiteAlerts.deleteForProjects([fixture.projectId], "GA4")).toBe(
      2,
    );
    const remaining = await prisma.adsAlert.findMany({
      where: { projectId: fixture.projectId },
      select: { source: true },
    });
    expect(remaining.map((row) => row.source).sort()).toEqual(["GSC", null]);
  });
});

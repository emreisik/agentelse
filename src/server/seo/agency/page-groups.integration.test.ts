import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { validatePageGroupRules } from "@/lib/seo/agency/page-groups";
import { dayKeyToDate } from "@/lib/seo/dates";
import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { upsertPages } from "@/server/seo/sync/dictionary";
import type { GscSyncContext } from "@/server/seo/sync/context";
import { describeIntegration } from "@/test-support/integration-suite";

import { GscPageGroups } from "./page-groups";

// Sayfa grubu kuralları gerçek Postgres'e karşı: 200 GscPage iki bütçeli
// geçişte yeniden gruplanır, yalnız değişen satırlar yazılır, uygulanan sürüm
// ilerler; kural değişince baştan başlar; kurallar kaydedildikten sonra
// upsertPages ile eklenen sayfa kuralın grubuyla doğar (ekleme anı yolu,
// integrator'ın dictionary.ts düzenlemesine dayanır).

describeIntegration("GSC page group rules", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GSC_SYNC,
    agency: process.env.GSC_AGENCY,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  const SITE = "sc-domain:groups.example";
  let fixture: AgencyFixture;
  let linkId: string;

  function rules(...items: [string, "PREFIX" | "GLOB" | "EXACT", string][]) {
    const checked = validatePageGroupRules(
      items.map(([group, match, pattern]) => ({ group, match, pattern })),
    );
    if (!checked.ok) throw new Error("bad test rules");
    return checked.rules;
  }

  async function groupsOf(): Promise<Record<string, number>> {
    const pages = await prisma.gscPage.groupBy({
      by: ["pageGroup"],
      where: { linkId },
      _count: { _all: true },
    });
    return Object.fromEntries(pages.map((row) => [row.pageGroup ?? "null", row._count._all]));
  }

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.GSC_AGENCY = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`groups-${runId}`);
    const link = await prisma.gscSiteLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: `cred-${runId}`,
        siteUrl: SITE,
        isPrimary: true,
        isMock: true,
        lastWeeklyWeek: "2026-09-28",
      },
    });
    linkId = link.id;
    const week = dayKeyToDate("2026-09-28");
    await prisma.gscPage.createMany({
      data: Array.from({ length: 200 }, (_, at) => {
        const path = at < 100 ? `/shop/item${at}/reviews` : `/blog/post${at}`;
        return {
          linkId,
          projectId: fixture.projectId,
          url: `https://groups.example${path}`,
          urlHash: `hash-${runId}-${at}`,
          path,
          pageGroup: at < 100 ? "/shop" : "/blog",
          firstSeenWeek: week,
          lastSeenWeek: week,
        };
      }),
    });
  }, 60_000);

  afterAll(async () => {
    process.env.GSC_SYNC = saved.sync;
    process.env.GSC_AGENCY = saved.agency;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    await prisma.gscSiteSetting.deleteMany({ where: { projectId: fixture?.projectId } });
    await prisma.gscSiteLink.deleteMany({ where: { projectId: fixture?.projectId } });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("applies saved rules in two budget-limited passes, writing only differing rows", async () => {
    const result = await GscPageGroups.save({
      projectId: fixture.projectId,
      linkId,
      rules: rules(["/shop/reviews", "GLOB", "/shop/*/reviews"]),
      userId: "user-1",
    });
    expect(result).toEqual({ ok: true, version: 1 });
    expect((await GscPageGroups.read(fixture.projectId, SITE)).applying).toBe(true);

    // Bütçe 0: hiç ilerlemeden bırakır, imleç ve kilit temiz.
    const idle = await GscPageGroups.regroupLink(linkId, { budgetMs: 0 });
    expect(idle).toEqual({ updated: 0, done: false });

    // Küçük sayfa yarım kalmaz (200 < 2000): tek geçişte biter.
    const first = await GscPageGroups.regroupLink(linkId);
    expect(first).toEqual({ updated: 100, done: true });
    expect(await groupsOf()).toEqual({ "/shop/reviews": 100, "/blog": 100 });

    const state = await GscPageGroups.read(fixture.projectId, SITE);
    expect(state).toMatchObject({ version: 1, appliedVersion: 1, applying: false, appliedWeek: "2026-09-28" });

    // İkinci geçiş hiçbir satırı yazmaz.
    expect(await GscPageGroups.regroupLink(linkId)).toEqual({ updated: 0, done: true });
  }, 60_000);

  it("a rule change restarts the pass and empty rules restore the default groups", async () => {
    await GscPageGroups.save({
      projectId: fixture.projectId,
      linkId,
      rules: rules(["/articles", "PREFIX", "/blog"]),
      userId: "user-1",
    });
    expect((await GscPageGroups.read(fixture.projectId, SITE)).applying).toBe(true);
    expect(await GscPageGroups.regroupDue(2, new Date())).toBeGreaterThanOrEqual(1);
    expect(await groupsOf()).toEqual({ "/shop": 100, "/articles": 100 });

    await GscPageGroups.save({
      projectId: fixture.projectId,
      linkId,
      rules: { v: 1, rules: [] },
      userId: "user-1",
    });
    await GscPageGroups.regroupLink(linkId);
    expect(await groupsOf()).toEqual({ "/shop": 100, "/blog": 100 });
  }, 60_000);

  it("a page inserted after the rules were saved is born in the rule's group", async () => {
    await GscPageGroups.save({
      projectId: fixture.projectId,
      linkId,
      rules: rules(["/shop/reviews", "GLOB", "/shop/*/reviews"]),
      userId: "user-1",
    });
    const link = await prisma.gscSiteLink.findUniqueOrThrow({ where: { id: linkId } });
    const path = "/shop/new-item/reviews";
    const urlHash = `hash-${runId}-new`;
    const ids = await upsertPages(
      { link } as unknown as GscSyncContext,
      [{ url: `https://groups.example${path}`, hash: urlHash, path, pageGroup: "/shop" }],
      "2026-09-28",
    );
    const id = ids.get(urlHash);
    expect(id).toBeDefined();
    const row = await prisma.gscPage.findUniqueOrThrow({ where: { id: id! } });
    expect(row.pageGroup).toBe("/shop/reviews");
  }, 60_000);
});

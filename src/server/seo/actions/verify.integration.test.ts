import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { scopeFromVerifiedDomain } from "@/lib/seo/crawl-url";
import { seoMockMode } from "@/lib/seo/health-flags";
import type { SeoActionProposalStored } from "@/lib/seo/actions/types";
import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import type { SiteFetchDeps } from "@/server/seo/crawl/fetcher";
import {
  mockSiteTransport,
  type MockPageOverride,
  type MockRequestLog,
} from "@/server/seo/crawl/mock-site";
import { describeIntegration } from "@/test-support/integration-suite";

import { createSeoAction, getAction } from "./store";
import { SeoActionVerifier } from "./verify";

// Doğrulayıcı gerçek Postgres'e karşı, sahte site taşıyıcısıyla (hiçbir istek
// süreçten çıkmaz): uygulanan başlık değişikliği tarayıcıyla otomatik doğrulanır
// ve (GSC bağı yokken) ölçüme geçer: measureFrom = appliedAt, evaluateAfter =
// appliedAt + 28 gün, yöntem CRAWLER; eski başlık eylemi APPLIED bırakır
// (deneme 1, nextCheckAt + 24 saat), 14. günde sorulur, 45. günde EXPIRED olur
// ve openKey boşalır; robots'un kapattığı hedef ROBOTS nedeniyle doğrulanmaz;
// www eşindeki hedef köken alan adından getirilir.

describeIntegration("SEO action verifier (fixture site)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = { mode: process.env.AGENTELSE_PROVIDER_MODE };
  const DAY = 86_400_000;
  const BASE = new Date("2026-09-20T10:00:00.000Z");
  const NEW_TITLE = "Pricing plans for small teams";
  const PRICING = `<html><head><title>${NEW_TITLE}</title></head><body><h1>Pricing</h1></body></html>`;
  let fixture: AgencyFixture;
  let siteId: string;
  let log: MockRequestLog;

  function deps(
    overrides: Readonly<Record<string, MockPageOverride>>,
  ): SiteFetchDeps {
    log = [];
    return {
      transport: mockSiteTransport({ overrides, log }),
      pacer: { wait: async () => undefined },
    };
  }

  async function titleAction(path: string, host = "example.test") {
    const proposal: SeoActionProposalStored = {
      v: 1,
      kind: "TITLE_META",
      before: null,
      after: { title: NEW_TITLE, metaDescription: "" },
      variants: [],
      note: null,
      alert: null,
    };
    const { action } = await createSeoAction({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      kind: "TITLE_META",
      source: "SEO_MANAGER",
      status: "APPLIED",
      openKey: `card:${randomUUID()}`,
      linkId: null,
      targetUrl: `https://${host}${path}`,
      pageId: null,
      targetQueries: [],
      proposal,
      userId: null,
      now: BASE,
    });
    return action;
  }

  async function setRobots(body: string): Promise<void> {
    await prisma.seoSite.update({
      where: { id: siteId },
      data: { robotsBody: body },
    });
  }

  beforeAll(async () => {
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`sav-${runId}`);
    await prisma.project.update({
      where: { id: fixture.projectId },
      data: { status: "ACTIVE" },
    });
    const scope = scopeFromVerifiedDomain("example.test")!;
    const site = await prisma.seoSite.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        isMock: seoMockMode(),
        scope: {
          kind: scope.kind,
          root: scope.root,
          prefix: scope.prefix,
          key: scope.key,
        },
        scopeKey: scope.key,
        origin: "https://example.test",
        robotsVerdict: "OK",
        robotsBody: "User-agent: *\nAllow: /",
        robotsFetchedAt: BASE,
      },
    });
    siteId = site.id;
  }, 60_000);

  beforeEach(async () => {
    await setRobots("User-agent: *\nAllow: /");
  });

  afterAll(async () => {
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    await prisma.seoAction.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.seoSite.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("verifies a title change with the crawler and starts measuring from appliedAt", async () => {
    const action = await titleAction("/pricing");
    const result = await SeoActionVerifier.runAction(action.id, {
      now: BASE,
      deps: deps({ "/pricing": { html: PRICING } }),
    });
    expect(result.status).toBe("measuring");
    expect(result.fetches).toBe(1);
    const row = await getAction(fixture.projectId, action.id);
    expect(row).toMatchObject({
      status: "EVALUATING",
      verifiedAt: BASE,
      measureFrom: BASE,
      evaluateAfter: new Date(BASE.getTime() + 28 * DAY),
    });
    expect(row?.verification.method).toBe("CRAWLER");
    expect(row?.verification.checks.every((check) => check.ok)).toBe(true);
    expect(row?.linkId).toBeNull();
  });

  it("keeps an unverified action, asks on day 14 and expires it on day 45", async () => {
    // Sahte sitede bulunan bir yol (olmayan yol 404 verir ve hızlı yeniden
    // denemeye girer); yayında hâlâ eski başlık var.
    const action = await titleAction("/pricing");
    const old = deps({
      "/pricing": {
        html: "<html><head><title>Old title</title></head><body><h1>x</h1></body></html>",
      },
    });
    const first = await SeoActionVerifier.runAction(action.id, {
      now: BASE,
      deps: old,
    });
    expect(first.status).toBe("pending");
    let row = await getAction(fixture.projectId, action.id);
    expect(row).toMatchObject({
      status: "APPLIED",
      nextCheckAt: new Date(BASE.getTime() + DAY),
      askedAt: null,
    });
    expect(row?.verification.attempts).toBe(1);

    const asked = await SeoActionVerifier.runAction(action.id, {
      now: new Date(BASE.getTime() + 14 * DAY),
      deps: old,
    });
    expect(asked.status).toBe("asked");
    row = await getAction(fixture.projectId, action.id);
    expect(row?.askedAt).toEqual(new Date(BASE.getTime() + 14 * DAY));

    const expired = await SeoActionVerifier.runAction(action.id, {
      now: new Date(BASE.getTime() + 45 * DAY),
      deps: old,
    });
    expect(expired.status).toBe("expired");
    row = await getAction(fixture.projectId, action.id);
    expect(row?.status).toBe("EXPIRED");
    const raw = await prisma.seoAction.findUniqueOrThrow({
      where: { id: action.id },
    });
    expect(raw.openKey).toBeNull();
  });

  it("does not fetch a page that robots.txt blocks", async () => {
    await setRobots("User-agent: *\nDisallow: /blocked");
    const action = await titleAction("/blocked/page");
    const result = await SeoActionVerifier.runAction(action.id, {
      now: BASE,
      deps: deps({ "/blocked/page": { html: PRICING } }),
    });
    expect(result.status).toBe("pending");
    expect(log).toHaveLength(0);
    const row = await getAction(fixture.projectId, action.id);
    expect(row?.status).toBe("APPLIED");
    expect(row?.verification.reason).toBe("ROBOTS");
  });

  it("fetches a target on the www twin from the origin host", async () => {
    const action = await titleAction("/pricing", "www.example.test");
    const result = await SeoActionVerifier.runAction(action.id, {
      now: BASE,
      deps: deps({ "/pricing": { html: PRICING } }),
    });
    expect(result.status).toBe("measuring");
    expect(
      log
        .filter((entry) => !entry.url.endsWith("/robots.txt"))
        .map((entry) => new URL(entry.url).host),
    ).toEqual(["example.test"]);
  });
});

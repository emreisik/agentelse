import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { projectSiteDomains } from "./domains";
import { loadLinkTrackingSettings, saveLinkTrackingSettings, utmTaggingOnFor } from "./settings";
import { ensureTrackedLink, findTrackedLink, findTrackedLinksForProject, resolveMetaAdLinks } from "./store";
import { cleanupTrackedLinks, seedTrackedLink } from "./test-support";

// Etiketli link deposu gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı): ensureTrackedLink idempotent, kod çakışmasında
// yeniden dener, Meta kimlikleri AdsLaunch'tan tembel çözülür, ayar satırı
// yokken etiketleme açık sayılır.

describeIntegration("tracked links store", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = { utm: process.env.GA_UTM };
  let fixture: AgencyFixture;

  const base = () => ({
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    channel: "meta_ads" as const,
    destinationUrl: "https://acme.test/landing",
    campaign: "agx-spring",
    label: "Spring",
    userId: null,
  });

  beforeAll(async () => {
    fixture = await createAgencyFixture(`tl-${runId}`);
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.GA_UTM = saved.utm;
    await cleanupTrackedLinks(fixture.projectId);
    await prisma.adsLaunch.deleteMany({ where: { projectId: fixture.projectId } });
    await prisma.gaPropertyLink.deleteMany({ where: { projectId: fixture.projectId } });
  });

  afterAll(async () => {
    await cleanupTrackedLinks(fixture?.projectId);
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("ensureTrackedLink is idempotent: same code, one row, updatedAt unchanged", async () => {
    const first = await ensureTrackedLink({ ...base(), entityType: "meta_ad", entityId: "cmd:0" });
    const second = await ensureTrackedLink({ ...base(), entityType: "meta_ad", entityId: "cmd:0" });
    expect(second.code).toBe(first.code);
    expect(second.id).toBe(first.id);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(first.carriesCode).toBe(true);
    expect(first.taggedUrl).toContain(`utm_content=agx_${first.code}`);
    expect(await prisma.trackedLink.count({ where: { projectId: fixture.projectId } })).toBe(1);
  });

  it("a changed campaign updates utmCampaign and taggedUrl but keeps the code", async () => {
    const first = await ensureTrackedLink({ ...base(), entityType: "meta_ad", entityId: "cmd:0" });
    const changed = await ensureTrackedLink({
      ...base(),
      entityType: "meta_ad",
      entityId: "cmd:0",
      campaign: "agx-summer",
    });
    expect(changed.code).toBe(first.code);
    expect(changed.utmCampaign).toBe("agx-summer");
    expect(changed.taggedUrl).toContain("utm_campaign=agx-summer");
    expect(changed.taggedUrl).not.toContain("agx-spring");
    expect((await findTrackedLink(fixture.projectId, "meta_ad", "cmd:0"))?.utmCampaign).toBe("agx-summer");
  });

  it("retries when the generated code collides", async () => {
    await seedTrackedLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      entityType: "instagram_bio",
      entityId: "bio",
      channel: "instagram",
      code: "aaaaaa",
      utmCampaign: "agx-bio",
    });
    const realRandom = Math.random.bind(Math);
    let calls = 0;
    vi.spyOn(Math, "random").mockImplementation(() => {
      calls += 1;
      // İlk kod (6 çağrı) "aaaaaa" ile çakışır; sonrası gerçek rastgele.
      return calls <= 6 ? 0 : realRandom();
    });
    const link = await ensureTrackedLink({ ...base(), entityType: "meta_ad", entityId: "cmd:1" });
    expect(link.code).not.toBe("aaaaaa");
    expect(link.code).toMatch(/^[a-z0-9]{6}$/);
  });

  it("carriesCode is false when the destination already has utm_content", async () => {
    const link = await ensureTrackedLink({
      ...base(),
      entityType: "meta_ad",
      entityId: "cmd:2",
      destinationUrl: "https://acme.test/landing?utm_content=mine",
    });
    expect(link.carriesCode).toBe(false);
    expect(link.taggedUrl).toContain("utm_content=mine");
    expect(link.taggedUrl).not.toContain(`agx_${link.code}`);
    const listed = await findTrackedLinksForProject(fixture.projectId, { entityTypes: ["meta_ad"] });
    expect(listed.map((item) => item.carriesCode)).toEqual([false]);
  });

  it("resolveMetaAdLinks fills the ids from the newest AdsLaunch and persists them", async () => {
    const commandId = `cmd-${runId}`;
    await prisma.adsLaunch.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        commandId,
        launchKey: "k1",
        adAccountExternalId: "act_1",
        spec: {},
        specHash: "h",
        campaignExternalId: "camp-1",
        progress: { ads: { "0": "ad-100", "1": "ad-101" } },
      },
    });
    const a = await ensureTrackedLink({ ...base(), entityType: "meta_ad", entityId: `${commandId}:0` });
    const b = await ensureTrackedLink({ ...base(), entityType: "meta_ad", entityId: `${commandId}:1` });
    const c = await ensureTrackedLink({ ...base(), entityType: "meta_ad", entityId: `${commandId}:2` });
    const bio = await ensureTrackedLink({
      ...base(),
      channel: "instagram",
      entityType: "instagram_bio",
      entityId: "bio",
    });
    const resolved = await resolveMetaAdLinks([a, b, c, bio]);
    expect(resolved.map((link) => [link.campaignExternalId, link.adExternalId])).toEqual([
      ["camp-1", "ad-100"],
      ["camp-1", "ad-101"],
      ["camp-1", null],
      [null, null],
    ]);
    const stored = await findTrackedLink(fixture.projectId, "meta_ad", `${commandId}:1`);
    expect(stored?.campaignExternalId).toBe("camp-1");
    expect(stored?.adExternalId).toBe("ad-101");
    // Üçüncü reklam sonradan oluşunca yalnız eksik alan yazılır.
    await prisma.adsLaunch.updateMany({
      where: { commandId },
      data: { progress: { ads: { "0": "ad-100", "1": "ad-101", "2": "ad-102" } } },
    });
    const again = await resolveMetaAdLinks(await findTrackedLinksForProject(fixture.projectId));
    expect(again.find((link) => link.entityId === `${commandId}:2`)?.adExternalId).toBe("ad-102");
    expect((await findTrackedLink(fixture.projectId, "meta_ad", `${commandId}:2`))?.adExternalId).toBe("ad-102");
  });

  // "Bayrak kapalıyken sorgu yok" sözü settings.test.ts'te (Prisma temsilcileri
  // casusla sarılınca geri dönmez, o yüzden burada yalnız sonuç denetlenir).
  it("utmTaggingOnFor: the flag wins over a stored row, no row is on, stored false is off", async () => {
    await saveLinkTrackingSettings({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      userId: "user-1",
      value: { utmEnabled: true },
    });
    process.env.GA_UTM = "false";
    expect(await utmTaggingOnFor(fixture.projectId)).toBe(false);

    await prisma.linkTrackingSetting.deleteMany({
      where: { projectId: fixture.projectId },
    });
    process.env.GA_UTM = "true";
    expect(await utmTaggingOnFor(fixture.projectId)).toBe(true);
    expect(await loadLinkTrackingSettings(fixture.projectId)).toEqual({
      utmEnabled: true,
      stored: false,
    });

    await saveLinkTrackingSettings({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      userId: "user-1",
      value: { utmEnabled: false },
    });
    expect(await utmTaggingOnFor(fixture.projectId)).toBe(false);
    expect(await loadLinkTrackingSettings(fixture.projectId)).toEqual({
      utmEnabled: false,
      stored: true,
    });
    await prisma.linkTrackingSetting.deleteMany({
      where: { projectId: fixture.projectId },
    });
  });

  it("projectSiteDomains returns the domain plus the stream host", async () => {
    expect(await projectSiteDomains("missing-project")).toEqual([]);
    await prisma.project.update({ where: { id: fixture.projectId }, data: { domain: "acme.test" } });
    expect(await projectSiteDomains(fixture.projectId)).toEqual(["acme.test"]);
    await prisma.gaPropertyLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: "cred-1",
        propertyId: "424242",
        streamUri: "https://shop.example.org/",
      },
    });
    expect(await projectSiteDomains(fixture.projectId)).toEqual(["acme.test", "shop.example.org"]);
  });
});

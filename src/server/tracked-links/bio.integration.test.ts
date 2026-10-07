import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { loadInstagramBioLink, saveInstagramBioLink } from "./bio";
import { cleanupTrackedLinks } from "./test-support";

// Instagram bio linki gerçek Postgres'e karşı: ret nedenleri, tek satır,
// agx-bio UTM'leri, hedefteki utm_* temizliği ve yerinde güncelleme.

describeIntegration("Instagram bio link", () => {
  const runId = randomUUID().slice(0, 8);
  const domain = `acme-${runId}.test`;
  let fx: AgencyFixture;

  const save = (destinationUrl: string) =>
    saveInstagramBioLink({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      userId: "user-1",
      destinationUrl,
    });

  const clear = async () => {
    await cleanupTrackedLinks(fx.projectId);
    await prisma.linkTrackingSetting.deleteMany({
      where: { projectId: fx.projectId },
    });
    await prisma.project.update({
      where: { id: fx.projectId },
      data: { domain },
    });
  };

  beforeAll(async () => {
    fx = await createAgencyFixture(runId);
    await prisma.project.update({
      where: { id: fx.projectId },
      data: { domain },
    });
  });

  beforeEach(() => {
    vi.stubEnv("GA_UTM", "true");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await clear();
  });

  afterAll(async () => {
    await clear();
    await teardownAgencyFixture(fx.workspaceId);
  });

  it("refuses with off, invalid, no_domain and not_own_site", async () => {
    vi.stubEnv("GA_UTM", "");
    expect(await save(`https://${domain}/`)).toEqual({ ok: false, reason: "off" });
    vi.stubEnv("GA_UTM", "true");

    expect(await save("not a link")).toEqual({ ok: false, reason: "invalid" });
    expect(await save("ftp://acme.test/")).toEqual({ ok: false, reason: "invalid" });
    expect(await save("https://other.example/")).toEqual({
      ok: false,
      reason: "not_own_site",
    });

    await prisma.project.update({
      where: { id: fx.projectId },
      data: { domain: null },
    });
    expect(await save(`https://${domain}/`)).toEqual({
      ok: false,
      reason: "no_domain",
    });
    expect(await prisma.trackedLink.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it("creates one instagram_bio row with the agx-bio UTM set", async () => {
    const result = await save(`https://${domain}/links`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await prisma.trackedLink.findMany({
      where: { projectId: fx.projectId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityType: "instagram_bio",
      entityId: "bio",
      channel: "instagram",
      utmSource: "instagram",
      utmMedium: "social",
      utmCampaign: "agx-bio",
      utmContent: `agx_${result.link.code}`,
    });
    expect(result.link.url).toContain(`utm_content=agx_${result.link.code}`);
    expect((await loadInstagramBioLink(fx.projectId))?.code).toBe(result.link.code);
  });

  it("strips an existing utm_content so the link still carries its code", async () => {
    const result = await save(`https://${domain}/links?utm_content=x&ref=1`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.link.destinationUrl).not.toContain("utm_content");
    expect(result.link.destinationUrl).toContain("ref=1");
    expect(result.link.url).toContain(`utm_content=agx_${result.link.code}`);
    expect(result.link.url).not.toContain("utm_content=x");
  });

  it("keeps the code and updates the destination for another own page", async () => {
    const first = await save(`https://${domain}/one`);
    const second = await save(`https://${domain}/two`);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.link.code).toBe(first.link.code);
    expect(second.link.destinationUrl).toBe(`https://${domain}/two`);
    expect(await prisma.trackedLink.count({ where: { projectId: fx.projectId } })).toBe(1);
  });
});

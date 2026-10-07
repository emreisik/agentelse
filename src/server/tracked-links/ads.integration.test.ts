import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { specHash } from "@/lib/ads/launch-spec";
import { prisma } from "@/lib/prisma";
import { launchSpecFromFlow } from "@/lib/module-flows/ads/launch";
import type { AdsBrief } from "@/lib/module-flows/ads/state";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { adLaunchUrlTags } from "./ads";
import { cleanupTrackedLinks } from "./test-support";

// Review'da hesaplanan url_tags gerçek Postgres'e karşı: bayrak, ayar, mesaj
// reklamı, yabancı link ve utm_content'li link etiketsiz kalır; geçerli linkte
// her reklam kendi kodunu alır ve ikinci çağrı aynı dizeleri verir.

describeIntegration("adLaunchUrlTags", () => {
  const runId = randomUUID().slice(0, 8);
  const domain = `acme-${runId}.test`;
  const link = `https://${domain}/spring`;
  const commandId = `cmd-${runId}`;
  let fx: AgencyFixture;

  const brief = (overrides: Partial<AdsBrief> = {}): AdsBrief => ({
    objective: "OUTCOME_ENGAGEMENT",
    dailyBudget: 20,
    days: 7,
    countries: ["TR"],
    ageMin: 18,
    ageMax: 65,
    gender: "all",
    link,
    callToAction: "LEARN_MORE",
    source: { creativeId: "c1", assetId: "a1", title: "Spring" },
    extraSources: [
      { creativeId: "c2", assetId: "a2", title: "Summer" },
      { creativeId: "c3", assetId: "a3", title: "Autumn" },
    ],
    currency: "TRY",
    dsaBeneficiary: "Acme",
    dsaPayor: "Acme Ltd",
    ...overrides,
  });
  const plan = {
    campaignName: "Spring Sale",
    adSetName: "TR",
    adName: "Ad",
    primaryText: "Hello",
  };
  const context = {
    adAccountId: "act_1",
    currency: "TRY",
    timezone: "Europe/Istanbul",
    pageId: "9",
    minCampaignSpendCapMinor: null,
    dsaBeneficiary: null,
    dsaPayor: null,
  };

  const run = (value: AdsBrief) =>
    adLaunchUrlTags({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      commandId,
      userId: "user-1",
      brief: value,
      plan,
    });

  const rows = () =>
    prisma.trackedLink.findMany({
      where: { projectId: fx.projectId },
      orderBy: { entityId: "asc" },
    });

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
    await cleanupTrackedLinks(fx.projectId);
    await prisma.linkTrackingSetting.deleteMany({
      where: { projectId: fx.projectId },
    });
  });

  afterAll(async () => {
    await cleanupTrackedLinks(fx.projectId);
    await prisma.linkTrackingSetting.deleteMany({
      where: { projectId: fx.projectId },
    });
    await teardownAgencyFixture(fx.workspaceId);
  });

  it("returns undefined and writes nothing when GA_UTM is unset", async () => {
    vi.stubEnv("GA_UTM", "");
    expect(await run(brief())).toBeUndefined();
    expect(await rows()).toHaveLength(0);
  });

  it("returns undefined when the project switched tracking off", async () => {
    await prisma.linkTrackingSetting.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        utmEnabled: false,
      },
    });
    expect(await run(brief())).toBeUndefined();
    expect(await rows()).toHaveLength(0);
  });

  it("keeps messaging ads, foreign links and utm_content links untagged", async () => {
    expect(
      await run(brief({ messages: { app: "MESSENGER" } })),
    ).toBeUndefined();
    expect(
      await run(brief({ link: "https://other.example/spring" })),
    ).toBeUndefined();
    expect(
      await run(brief({ link: `${link}?utm_content=x` })),
    ).toBeUndefined();
    expect(await rows()).toHaveLength(0);
  });

  it("tags the main ad and both extra ads with their own codes", async () => {
    const tags = await run(brief());

    expect(tags).toHaveLength(3);
    const codes = (tags ?? []).map((tag) => /utm_content=agx_([a-z0-9]{6})/.exec(tag)?.[1]);
    expect(codes.every(Boolean)).toBe(true);
    expect(new Set(codes).size).toBe(3);
    for (const tag of tags ?? []) {
      expect(tag).toContain("utm_source=facebook");
      expect(tag).toContain("utm_campaign=agx-spring-sale");
      expect(tag).toContain("utm_term={{site_source_name}}");
    }

    const stored = await rows();
    expect(stored.map((row) => row.entityId)).toEqual([
      `${commandId}:0`,
      `${commandId}:1`,
      `${commandId}:2`,
    ]);
    expect(stored.every((row) => row.entityType === "meta_ad")).toBe(true);
    expect(stored.map((row) => row.code)).toEqual(codes);
  });

  it("gives the same strings on a second call and leaves specHash alone", async () => {
    const first = await run(brief());
    const second = await run(brief());
    expect(second).toEqual(first);
    expect(await rows()).toHaveLength(3);

    const plain = launchSpecFromFlow({
      brief: brief(),
      plan,
      context,
      activate: true,
    });
    const withTags = (tags: string[] | undefined) => ({
      ...plain,
      ads: plain.ads.map((ad, index) => ({
        ...ad,
        urlTags: tags?.[index] ?? ad.urlTags,
      })),
    });
    const firstSpec = withTags(first);
    const secondSpec = withTags(second);

    expect(firstSpec.ads.map((ad) => ad.urlTags)).toEqual(
      secondSpec.ads.map((ad) => ad.urlTags),
    );
    // specHash urlTags'i içermez: etiket Review ile Approve arasında hash'i bozmaz.
    expect(specHash(firstSpec)).toBe(specHash(plain));
  });

  it("builds one tracked link for a carousel (the extra posts are cards, not ads)", async () => {
    const tags = await run(brief({ adFormat: "carousel" }));
    expect(tags).toHaveLength(1);
    expect((await rows()).map((row) => row.entityId)).toEqual([`${commandId}:0`]);
  });

  it("drops rows of an earlier Review when this Review no longer tags", async () => {
    expect(await run(brief())).toHaveLength(3);
    expect(await rows()).toHaveLength(3);

    // Ayar kapandı: önceki Review'ın satırları kodsuz reklama bağlı kalmasın.
    await prisma.linkTrackingSetting.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        utmEnabled: false,
      },
    });
    expect(await run(brief())).toBeUndefined();
    expect(await rows()).toHaveLength(0);
  });

  it("drops the rows of ads that no longer exist when the ad count shrinks", async () => {
    expect(await run(brief())).toHaveLength(3);
    expect(await run(brief({ extraSources: [] }))).toHaveLength(1);
    expect((await rows()).map((row) => row.entityId)).toEqual([`${commandId}:0`]);
  });
});

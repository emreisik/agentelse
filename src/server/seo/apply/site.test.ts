import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { siteFixture } from "@/lib/seo/apply/test-support";

// Bu dosyanın kanıtladığı: gateApplySite tek kapıdır ve sırayla bayrağı (ve
// geliştirme korumasını), site satırını, mock uyuşmasını, sağlığı, kapsamı
// (anahtar ve köken) ve yeteneği denetler; her ret sabit bir hata kodu ve
// refusal verir ve hiçbir adım WordPress'e gitmez.

const mocks = vi.hoisted(() => ({
  loadCmsSite: vi.fn(),
  readState: vi.fn(),
}));

vi.mock("@/server/integrations/wordpress/connection", () => ({
  loadCmsSite: mocks.loadCmsSite,
}));
vi.mock("@/server/seo/site/sites", () => ({
  SeoSites: { readState: mocks.readState },
}));

const { gateApplySite, parseSeoFields, parseWpCapabilities } = await import(
  "./site"
);

const SCOPE = {
  kind: "VERIFIED_DOMAIN" as const,
  root: "example.com",
  prefix: null,
  key: "VERIFIED_DOMAIN:example.com:",
};
const NO_MOCK = { mock: false };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SEO_HEALTH", "true");
  vi.stubEnv("SEO_APPLY", "true");
  mocks.loadCmsSite.mockResolvedValue(siteFixture());
  mocks.readState.mockResolvedValue({ scope: { ...SCOPE } });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("gateApplySite", () => {
  it("opens for a healthy connected site and returns its parsed capabilities", async () => {
    const gate = await gateApplySite("proj_1", "TITLE_META", NO_MOCK);
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.site.id).toBe("site_1");
    expect(gate.scope.key).toBe(SCOPE.key);
    expect(gate.fields).toEqual({
      plugin: "YOAST",
      titleVia: "META",
      descriptionVia: "META",
      verifiable: true,
    });
    expect(gate.capabilities.editOthers).toBe(true);
    expect(mocks.loadCmsSite).toHaveBeenCalledWith("proj_1", { mock: false });
  });

  it("accepts a LIMITED connection", async () => {
    mocks.loadCmsSite.mockResolvedValue(siteFixture({ health: "LIMITED" }));
    expect((await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).ok).toBe(true);
  });

  it("refuses with not_enabled and no query when SEO_APPLY is off", async () => {
    vi.stubEnv("SEO_APPLY", "false");
    expect(await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).toEqual({
      ok: false,
      code: "not_enabled",
      refusal: "not_enabled",
    });
    expect(mocks.loadCmsSite).not.toHaveBeenCalled();
    expect(mocks.readState).not.toHaveBeenCalled();
  });

  it("refuses with not_enabled when SEO_HEALTH is off", async () => {
    vi.stubEnv("SEO_HEALTH", "false");
    const gate = await gateApplySite("proj_1", "TITLE_META", NO_MOCK);
    expect(gate).toMatchObject({ ok: false, code: "not_enabled" });
    expect(mocks.loadCmsSite).not.toHaveBeenCalled();
  });

  it("a dev process only handles allow-listed projects", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user@db.neon.tech/prod");
    vi.stubEnv("SEO_DEV_PROJECTS", "other_project");
    const gate = await gateApplySite("proj_1", "TITLE_META", NO_MOCK);
    expect(gate).toMatchObject({ ok: false, code: "not_enabled" });
    expect(mocks.loadCmsSite).not.toHaveBeenCalled();
  });

  it("refuses with not_connected when there is no site row", async () => {
    mocks.loadCmsSite.mockResolvedValue(null);
    expect(await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).toEqual({
      ok: false,
      code: "not_connected",
      refusal: "not_connected",
    });
  });

  it("refuses a site whose mock flag does not match the process mode", async () => {
    mocks.loadCmsSite.mockResolvedValue(siteFixture({ isMock: true }));
    expect(await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).toEqual({
      ok: false,
      code: "not_enabled",
      refusal: "not_allowed_here",
    });
    expect(mocks.readState).not.toHaveBeenCalled();

    mocks.loadCmsSite.mockResolvedValue(siteFixture({ isMock: false }));
    expect(
      await gateApplySite("proj_1", "TITLE_META", { mock: true }),
    ).toMatchObject({ ok: false, refusal: "not_allowed_here" });
  });

  it.each([
    ["AUTH", "reconnect", "site_unhealthy"],
    ["NO_PERMISSION", "no_permission", "no_permission"],
    ["DOMAIN_MISMATCH", "domain_mismatch", "domain_mismatch"],
    ["UNREACHABLE", "site_unhealthy", "site_unhealthy"],
    ["REST_BLOCKED", "site_unhealthy", "site_unhealthy"],
    ["NOT_WORDPRESS", "site_unhealthy", "site_unhealthy"],
    ["UNKNOWN", "site_unhealthy", "site_unhealthy"],
  ])("health %s is refused as %s", async (health, code, refusal) => {
    mocks.loadCmsSite.mockResolvedValue(siteFixture({ health }));
    expect(await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).toEqual({
      ok: false,
      code,
      refusal,
    });
    expect(mocks.readState).not.toHaveBeenCalled();
  });

  it("a DOMAIN_MISMATCH health with reason scope_changed reports scope_changed", async () => {
    mocks.loadCmsSite.mockResolvedValue(
      siteFixture({ health: "DOMAIN_MISMATCH", healthReason: "scope_changed" }),
    );
    expect(await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).toEqual({
      ok: false,
      code: "scope_changed",
      refusal: "domain_mismatch",
    });
  });

  it("refuses with scope_changed when the verified scope key differs from the stored one", async () => {
    // Köken yine kapsamda kalır: yalnız kapsam anahtarı farklıdır.
    mocks.readState.mockResolvedValue({
      scope: { ...SCOPE, kind: "GSC_DOMAIN", key: "GSC_DOMAIN:example.com:" },
    });
    expect(await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).toEqual({
      ok: false,
      code: "scope_changed",
      refusal: "domain_mismatch",
    });
  });

  it("refuses with scope_changed when the site has no scope key stored", async () => {
    mocks.loadCmsSite.mockResolvedValue(siteFixture({ scopeKey: null }));
    expect(await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).toMatchObject({
      ok: false,
      code: "scope_changed",
    });
  });

  it("refuses with scope_changed when the project no longer has a verified scope", async () => {
    mocks.readState.mockResolvedValue({ scope: null });
    expect(await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).toMatchObject({
      ok: false,
      code: "scope_changed",
    });
    mocks.readState.mockResolvedValue(null);
    expect(await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).toMatchObject({
      ok: false,
      code: "scope_changed",
    });
  });

  it("refuses with domain_mismatch when the origin is outside the scope", async () => {
    mocks.loadCmsSite.mockResolvedValue(
      siteFixture({ origin: "https://other-site.org" }),
    );
    expect(await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).toEqual({
      ok: false,
      code: "domain_mismatch",
      refusal: "domain_mismatch",
    });
  });

  it("refuses with no_permission when the capability does not allow the kind", async () => {
    mocks.loadCmsSite.mockResolvedValue(
      siteFixture({
        capabilities: {
          draftPosts: true,
          publishPosts: false,
          editPublishedPosts: false,
          editPages: false,
          editPublishedPages: false,
          editOthers: false,
          deletePosts: false,
        },
      }),
    );
    expect(await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).toEqual({
      ok: false,
      code: "no_permission",
      refusal: "no_permission",
    });
    expect(await gateApplySite("proj_1", "PUBLISH_LIVE", NO_MOCK)).toMatchObject(
      { ok: false, code: "no_permission" },
    );
    expect((await gateApplySite("proj_1", "PUBLISH_ARTICLE", NO_MOCK)).ok).toBe(
      true,
    );
  });

  it("checks the page type when the caller knows it", async () => {
    mocks.loadCmsSite.mockResolvedValue(
      siteFixture({
        capabilities: {
          draftPosts: true,
          publishPosts: true,
          editPublishedPosts: true,
          editPages: true,
          editPublishedPages: false,
          editOthers: true,
          deletePosts: true,
        },
      }),
    );
    expect(
      (await gateApplySite("proj_1", "TITLE_META", { ...NO_MOCK, wpType: "post" }))
        .ok,
    ).toBe(true);
    expect(
      await gateApplySite("proj_1", "TITLE_META", { ...NO_MOCK, wpType: "page" }),
    ).toMatchObject({ ok: false, code: "no_permission" });
  });

  it("an unknown type passes with post OR page rights (anyWpType)", async () => {
    mocks.loadCmsSite.mockResolvedValue(
      siteFixture({
        capabilities: {
          draftPosts: true,
          publishPosts: true,
          editPublishedPosts: true,
          editPages: true,
          editPublishedPages: false,
          editOthers: true,
          deletePosts: true,
        },
      }),
    );
    // Tür bilinmiyorsa eski davranış ikisini birden ister.
    expect(await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).toMatchObject({
      ok: false,
      code: "no_permission",
    });
    expect(
      (await gateApplySite("proj_1", "TITLE_META", { ...NO_MOCK, anyWpType: true }))
        .ok,
    ).toBe(true);
    expect(
      (await gateApplySite("proj_1", "INTERNAL_LINKS", { ...NO_MOCK, anyWpType: true }))
        .ok,
    ).toBe(true);
  });

  it("closes the gate when the stored capability JSON is unusable", async () => {
    mocks.loadCmsSite.mockResolvedValue(siteFixture({ capabilities: null }));
    expect(await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).toMatchObject({
      ok: false,
      code: "site_unhealthy",
    });
    mocks.loadCmsSite.mockResolvedValue(siteFixture({ seoFields: "nope" }));
    expect(await gateApplySite("proj_1", "TITLE_META", NO_MOCK)).toMatchObject({
      ok: false,
      code: "site_unhealthy",
    });
  });
});

describe("stored JSON parsers", () => {
  it("parseSeoFields rejects unknown values", () => {
    expect(
      parseSeoFields({ plugin: "X", titleVia: "META", descriptionVia: "META" }),
    ).toBeNull();
    expect(parseSeoFields(null)).toBeNull();
  });

  it("parseWpCapabilities treats anything but true as false", () => {
    expect(parseWpCapabilities({ draftPosts: "yes" })).toMatchObject({
      draftPosts: false,
      editOthers: false,
    });
    expect(parseWpCapabilities(undefined)).toBeNull();
  });
});

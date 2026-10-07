import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: IndexNow açma/doğrulama/kapatma (anahtar dosyası
// eşleşmezse doğrulanmaz), taslağın asla bildirilmemesi, proje başına aralıkta
// en çok bir POST, mock kipinde ağın hiç kullanılmaması, KEY_INVALID ve
// URL_MISMATCH sonuçlarının satıra yazılması ve bayrak kapalıyken sorgusuz
// çıkış.

const mocks = vi.hoisted(() => ({
  settingFindUnique: vi.fn(),
  settingUpsert: vi.fn(),
  settingUpdate: vi.fn(),
  settingUpdateMany: vi.fn(),
  changeFindMany: vi.fn(),
  changeUpdateMany: vi.fn(),
  loadCmsSite: vi.fn(),
  transport: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoApplySetting: {
      findUnique: mocks.settingFindUnique,
      upsert: mocks.settingUpsert,
      update: mocks.settingUpdate,
      updateMany: mocks.settingUpdateMany,
    },
    seoChange: {
      findMany: mocks.changeFindMany,
      updateMany: mocks.changeUpdateMany,
    },
  },
}));
vi.mock("@/server/integrations/wordpress/connection", () => ({
  loadCmsSite: mocks.loadCmsSite,
}));
vi.mock("@/server/integrations/wordpress/transport", () => ({
  WORDPRESS_USER_AGENT: "AgentelseSEO/1.0 (+https://agentelse.com)",
  guardedWpTransport: mocks.transport,
}));

const { SeoIndexNow, isIndexNowReady } = await import("./indexnow");

const KEY = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const SITE = { id: "site1", origin: "https://example.com", isMock: false };

function enableFlags(): void {
  // Gerçek kip (fixture SITE.isMock: false); CI'nın mock kipi sızmasın.
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "live");
  vi.stubEnv("SEO_APPLY", "true");
  vi.stubEnv("SEO_HEALTH", "true");
  vi.stubEnv("SEO_INDEXNOW", "true");
}

function readySetting(overrides: Record<string, unknown> = {}) {
  return {
    indexNowEnabled: true,
    indexNowKey: KEY,
    indexNowHost: "example.com",
    indexNowVerifiedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  };
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    projectId: "p1",
    kind: "TITLE_META",
    liveUrl: null,
    params: { url: "https://example.com/pricing" },
    indexNow: { state: "PENDING" },
    updatedAt: new Date("2026-10-07T11:50:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.loadCmsSite.mockResolvedValue(SITE);
  mocks.settingUpsert.mockImplementation(
    async (args: { create: Record<string, unknown> }) => ({
      ...args.create,
      indexNowLastPingAt: null,
    }),
  );
  mocks.settingUpdate.mockResolvedValue({});
  mocks.settingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.changeUpdateMany.mockImplementation(
    async (args: { where: { id: { in: string[] } } }) => ({
      count: args.where.id.in.length,
    }),
  );
});

describe("isIndexNowReady", () => {
  it("is false without any query while the flag is off", async () => {
    vi.stubEnv("SEO_APPLY", "true");
    vi.stubEnv("SEO_HEALTH", "true");
    expect(await isIndexNowReady("p1")).toBe(false);
    expect(mocks.settingFindUnique).not.toHaveBeenCalled();
  });

  it("is true only for an enabled project with a verified key", async () => {
    enableFlags();
    mocks.settingFindUnique.mockResolvedValue(readySetting());
    expect(await isIndexNowReady("p1")).toBe(true);
    mocks.settingFindUnique.mockResolvedValue(
      readySetting({ indexNowVerifiedAt: null }),
    );
    expect(await isIndexNowReady("p1")).toBe(false);
    mocks.settingFindUnique.mockResolvedValue(
      readySetting({ indexNowEnabled: false }),
    );
    expect(await isIndexNowReady("p1")).toBe(false);
    mocks.settingFindUnique.mockResolvedValue(null);
    expect(await isIndexNowReady("p1")).toBe(false);
  });
});

describe("SeoIndexNow.enable / disable", () => {
  it("does nothing while the flag is off", async () => {
    const view = await SeoIndexNow.enable("p1", "w1", "u1");
    expect(view.enabled).toBe(false);
    expect(mocks.settingUpsert).not.toHaveBeenCalled();
  });

  it("generates a 32 hex key, binds the host and starts unverified", async () => {
    enableFlags();
    mocks.settingFindUnique.mockResolvedValue(null);
    const view = await SeoIndexNow.enable("p1", "w1", "u1");
    expect(view.enabled).toBe(true);
    expect(view.key).toMatch(/^[0-9a-f]{32}$/);
    expect(view.keyUrl).toBe(`https://example.com/${view.key}.txt`);
    expect(view.verified).toBe(false);
    expect(mocks.settingUpsert.mock.calls[0]?.[0].create).toMatchObject({
      indexNowHost: "example.com",
      indexNowVerifiedAt: null,
    });
  });

  it("keeps the key and the verification when the host is unchanged", async () => {
    enableFlags();
    const verifiedAt = new Date("2026-10-01T00:00:00.000Z");
    mocks.settingFindUnique.mockResolvedValue(readySetting());
    await SeoIndexNow.enable("p1", "w1", "u1");
    expect(mocks.settingUpsert.mock.calls[0]?.[0].update).toMatchObject({
      indexNowKey: KEY,
      indexNowVerifiedAt: verifiedAt,
    });
  });

  it("drops the verification when the site host changed", async () => {
    enableFlags();
    mocks.settingFindUnique.mockResolvedValue(
      readySetting({ indexNowHost: "old.example.com" }),
    );
    await SeoIndexNow.enable("p1", "w1", "u1");
    expect(mocks.settingUpsert.mock.calls[0]?.[0].update).toMatchObject({
      indexNowKey: KEY,
      indexNowVerifiedAt: null,
    });
  });

  it("does not enable without a connected site", async () => {
    enableFlags();
    mocks.loadCmsSite.mockResolvedValue(null);
    const view = await SeoIndexNow.enable("p1", "w1", "u1");
    expect(view.enabled).toBe(false);
    expect(mocks.settingUpsert).not.toHaveBeenCalled();
  });

  it("disable switches the project off and keeps the key", async () => {
    await SeoIndexNow.disable("p1", "u1");
    expect(mocks.settingUpdateMany).toHaveBeenCalledWith({
      where: { projectId: "p1" },
      data: { indexNowEnabled: false },
    });
  });
});

describe("SeoIndexNow.verify", () => {
  beforeEach(() => {
    enableFlags();
    mocks.settingFindUnique.mockResolvedValue(readySetting());
  });

  it("verifies when the key file body equals the key", async () => {
    mocks.transport.mockResolvedValue({
      status: 200,
      headers: {},
      body: `${KEY}\n`,
      truncated: false,
    });
    expect(await SeoIndexNow.verify("p1", "u1")).toEqual({ ok: true });
    const request = mocks.transport.mock.calls[0]?.[0];
    expect(request.method).toBe("GET");
    expect(String(request.url)).toBe(`https://example.com/${KEY}.txt`);
    expect(mocks.settingUpdate.mock.calls[0]?.[0].data.indexNowVerifiedAt).toBeInstanceOf(
      Date,
    );
  });

  it("does not verify on a key mismatch", async () => {
    mocks.transport.mockResolvedValue({
      status: 200,
      headers: {},
      body: "something else",
      truncated: false,
    });
    const result = await SeoIndexNow.verify("p1", "u1");
    expect(result.ok).toBe(false);
    expect(mocks.settingUpdate).not.toHaveBeenCalled();
  });

  it("does not verify on 404 or a failing request", async () => {
    mocks.transport.mockResolvedValue({
      status: 404,
      headers: {},
      body: KEY,
      truncated: false,
    });
    expect((await SeoIndexNow.verify("p1", "u1")).ok).toBe(false);
    mocks.transport.mockRejectedValue(new Error("boom"));
    expect((await SeoIndexNow.verify("p1", "u1")).ok).toBe(false);
    expect(mocks.settingUpdate).not.toHaveBeenCalled();
  });

  it("asks the user to switch IndexNow on first", async () => {
    mocks.settingFindUnique.mockResolvedValue(null);
    const result = await SeoIndexNow.verify("p1", "u1");
    expect(result).toEqual({ ok: false, message: "Switch IndexNow on first." });
  });

  it("is verified in mock mode without a network call", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    expect(await SeoIndexNow.verify("p1", "u1")).toEqual({ ok: true });
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.settingUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("SeoIndexNow.flushDue", () => {
  beforeEach(() => {
    enableFlags();
    mocks.settingFindUnique.mockResolvedValue(readySetting());
    mocks.transport.mockResolvedValue({
      status: 200,
      headers: {},
      body: "",
      truncated: false,
    });
  });

  it("returns 0 without any query while the flag is off", async () => {
    vi.unstubAllEnvs();
    expect(await SeoIndexNow.flushDue(NOW)).toBe(0);
    expect(mocks.changeFindMany).not.toHaveBeenCalled();
  });

  it("sends one POST for the pending public change and records SENT", async () => {
    mocks.changeFindMany.mockResolvedValue([pendingRow()]);
    expect(await SeoIndexNow.flushDue(NOW)).toBe(1);

    expect(mocks.transport).toHaveBeenCalledTimes(1);
    const request = mocks.transport.mock.calls[0]?.[0];
    expect(request.method).toBe("POST");
    expect(String(request.url)).toBe("https://api.indexnow.org/indexnow");
    expect(JSON.parse(request.body)).toEqual({
      host: "example.com",
      key: KEY,
      keyLocation: `https://example.com/${KEY}.txt`,
      urlList: ["https://example.com/pricing"],
    });
    expect(mocks.changeUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: { in: ["c1"] },
        indexNow: { path: ["state"], equals: "PENDING" },
      },
      data: { indexNow: { state: "SENT", at: NOW.toISOString(), urls: 1 } },
    });
  });

  it("never pings a draft article", async () => {
    mocks.changeFindMany.mockResolvedValue([
      pendingRow({ id: "d1", kind: "PUBLISH_ARTICLE", liveUrl: null }),
    ]);
    await SeoIndexNow.flushDue(NOW);
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.changeUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { indexNow: { state: "SKIPPED", at: NOW.toISOString(), urls: 0 } },
      }),
    );
  });

  it("pings the live address of a published article", async () => {
    mocks.changeFindMany.mockResolvedValue([
      pendingRow({
        id: "l1",
        kind: "PUBLISH_LIVE",
        liveUrl: "https://example.com/blog/hello",
        params: { link: "https://example.com/?p=9" },
      }),
    ]);
    await SeoIndexNow.flushDue(NOW);
    expect(JSON.parse(mocks.transport.mock.calls[0]?.[0].body).urlList).toEqual([
      "https://example.com/blog/hello",
    ]);
  });

  it("skips a url on another host", async () => {
    mocks.changeFindMany.mockResolvedValue([
      pendingRow({ params: { url: "https://other.example.org/x" } }),
    ]);
    await SeoIndexNow.flushDue(NOW);
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it("sends one POST per project and takes the gap lock first", async () => {
    mocks.changeFindMany.mockResolvedValue([
      pendingRow({ id: "a" }),
      pendingRow({ id: "b", params: { url: "https://example.com/about" } }),
    ]);
    await SeoIndexNow.flushDue(NOW);
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.transport.mock.calls[0]?.[0].body).urlList).toEqual([
      "https://example.com/pricing",
      "https://example.com/about",
    ]);
    const lock = mocks.settingUpdateMany.mock.calls[0]?.[0];
    expect(lock.data).toEqual({ indexNowLastPingAt: NOW });
    expect(lock.where.OR).toEqual([
      { indexNowLastPingAt: null },
      { indexNowLastPingAt: { lte: new Date(NOW.getTime() - 10 * 60_000) } },
    ]);
  });

  it("sends nothing when the gap lock is not won", async () => {
    mocks.changeFindMany.mockResolvedValue([pendingRow()]);
    mocks.settingUpdateMany.mockResolvedValue({ count: 0 });
    expect(await SeoIndexNow.flushDue(NOW)).toBe(0);
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.changeUpdateMany).not.toHaveBeenCalled();
  });

  it("sends at most 5 addresses and leaves the rest pending", async () => {
    mocks.changeFindMany.mockResolvedValue(
      Array.from({ length: 7 }, (_, index) =>
        pendingRow({
          id: `c${index}`,
          params: { url: `https://example.com/p${index}` },
        }),
      ),
    );
    expect(await SeoIndexNow.flushDue(NOW)).toBe(5);
    expect(JSON.parse(mocks.transport.mock.calls[0]?.[0].body).urlList).toHaveLength(5);
  });

  it("skips pending rows when the project switched IndexNow off", async () => {
    mocks.settingFindUnique.mockResolvedValue(
      readySetting({ indexNowEnabled: false }),
    );
    mocks.changeFindMany.mockResolvedValue([pendingRow()]);
    await SeoIndexNow.flushDue(NOW);
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.changeUpdateMany.mock.calls[0]?.[0].data.indexNow.state).toBe(
      "SKIPPED",
    );
  });

  it("records KEY_INVALID, marks the key unverified", async () => {
    mocks.changeFindMany.mockResolvedValue([pendingRow()]);
    mocks.transport.mockResolvedValue({
      status: 403,
      headers: {},
      body: "",
      truncated: false,
    });
    await SeoIndexNow.flushDue(NOW);
    expect(mocks.changeUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          indexNow: {
            state: "FAILED",
            at: NOW.toISOString(),
            urls: 0,
            code: "key_invalid",
          },
        },
      }),
    );
    expect(mocks.settingUpdateMany).toHaveBeenCalledWith({
      where: { projectId: "p1" },
      data: { indexNowVerifiedAt: null },
    });
  });

  it("records URL_MISMATCH", async () => {
    mocks.changeFindMany.mockResolvedValue([pendingRow()]);
    mocks.transport.mockResolvedValue({
      status: 422,
      headers: {},
      body: "",
      truncated: false,
    });
    await SeoIndexNow.flushDue(NOW);
    expect(
      mocks.changeUpdateMany.mock.calls.at(-1)?.[0].data.indexNow,
    ).toMatchObject({ state: "FAILED", code: "url_mismatch" });
  });

  it("keeps the row pending on rate limiting or a network error", async () => {
    mocks.changeFindMany.mockResolvedValue([pendingRow()]);
    mocks.transport.mockResolvedValue({
      status: 429,
      headers: {},
      body: "",
      truncated: false,
    });
    expect(await SeoIndexNow.flushDue(NOW)).toBe(0);
    mocks.transport.mockRejectedValue(new Error("down"));
    expect(await SeoIndexNow.flushDue(NOW)).toBe(0);
    expect(mocks.changeUpdateMany).not.toHaveBeenCalled();
  });

  it("gives up on a notification pending for more than a day", async () => {
    mocks.changeFindMany.mockResolvedValue([
      pendingRow({ updatedAt: new Date("2026-10-05T00:00:00.000Z") }),
    ]);
    await SeoIndexNow.flushDue(NOW);
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.changeUpdateMany.mock.calls[0]?.[0].data.indexNow).toMatchObject({
      state: "FAILED",
      code: "stale",
    });
  });

  it("mock mode records SENT without a network call", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    mocks.changeFindMany.mockResolvedValue([pendingRow()]);
    expect(await SeoIndexNow.flushDue(NOW)).toBe(1);
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.changeFindMany.mock.calls[0]?.[0].where.isMock).toBe(true);
    expect(mocks.changeUpdateMany.mock.calls.at(-1)?.[0].data.indexNow.state).toBe(
      "SENT",
    );
  });

  it("restricts the scan to the allow-listed projects in a dev process", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com/live");
    vi.stubEnv("SEO_DEV_PROJECTS", "p9");
    mocks.changeFindMany.mockResolvedValue([]);
    await SeoIndexNow.flushDue(NOW);
    expect(mocks.changeFindMany.mock.calls[0]?.[0].where.projectId).toEqual({
      in: ["p9"],
    });
  });
});

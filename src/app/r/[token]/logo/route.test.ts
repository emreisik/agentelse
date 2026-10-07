import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: yalnız png/jpeg/webp ve yalnız paylaşımın kendi
// workspace'inin LOGO varlığı sunulur; SVG, başka workspace, logosuz paylaşım,
// kötü belirteç, bayrak kapalı ve okuma hatası AYNI 404'ü verir; başlıklar.

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  assetFindFirst: vi.fn(),
  readAsset: vi.fn(),
}));

vi.mock("@/server/report-share/store", () => ({
  ReportShares: { resolve: mocks.resolve },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { asset: { findFirst: mocks.assetFindFirst } },
}));
vi.mock("@/server/storage/asset-storage", () => ({
  readAsset: mocks.readAsset,
}));

import { GET } from "./route";

const TOKEN = "clshare0123456789abcdefg.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
let ipCounter = 0;

function request(): Request {
  ipCounter += 1;
  return new Request(`http://localhost/r/${TOKEN}/logo`, {
    headers: { "x-forwarded-for": `192.0.2.${ipCounter}` },
  });
}

function call(token = TOKEN) {
  return GET(request(), { params: Promise.resolve({ token }) });
}

function share(logoAssetId: string | null = "logo1") {
  return {
    ok: true,
    share: {
      workspaceId: "ws1",
      branding: {
        displayName: "Acme",
        accent: "slate",
        footer: null,
        logoAssetId,
      },
    },
  };
}

async function expectUniform404(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("Not found");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("GA_AGENCY", "true");
  mocks.resolve.mockResolvedValue(share());
  mocks.assetFindFirst.mockResolvedValue({
    storageKey: "local://logo1",
    mimeType: "image/png",
  });
  mocks.readAsset.mockResolvedValue(Buffer.from([1, 2, 3]));
});

describe("GET /r/[token]/logo", () => {
  it.each(["image/png", "image/jpeg", "image/webp"])("serves %s", async (mime) => {
    mocks.assetFindFirst.mockResolvedValue({
      storageKey: "local://logo1",
      mimeType: mime,
    });
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(mime);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("looks the asset up inside the share's workspace and the LOGO type", async () => {
    await call();
    expect(mocks.assetFindFirst.mock.calls[0]?.[0].where).toEqual({
      id: "logo1",
      workspaceId: "ws1",
      type: "LOGO",
    });
  });

  it("never serves SVG", async () => {
    mocks.assetFindFirst.mockResolvedValue({
      storageKey: "local://logo1",
      mimeType: "image/svg+xml",
    });
    await expectUniform404(await call());
    expect(mocks.readAsset).not.toHaveBeenCalled();
  });

  it("404s when the asset is not found (other workspace or wrong type)", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);
    await expectUniform404(await call());
  });

  it("404s when the share has no logo", async () => {
    mocks.resolve.mockResolvedValue(share(null));
    await expectUniform404(await call());
    expect(mocks.assetFindFirst).not.toHaveBeenCalled();
  });

  it("404s for a token that does not resolve", async () => {
    mocks.resolve.mockResolvedValue({ ok: false });
    await expectUniform404(await call("bad"));
  });

  it("404s when both flags are off, before resolving", async () => {
    vi.stubEnv("GA_AGENCY", "false");
    vi.stubEnv("GSC_AGENCY", "false");
    await expectUniform404(await call());
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("404s when the file cannot be read", async () => {
    mocks.readAsset.mockRejectedValue(new Error("missing"));
    await expectUniform404(await call());
  });

  it("rate-limits per IP", async () => {
    const same = () =>
      new Request("http://localhost/x", {
        headers: { "x-forwarded-for": "198.18.0.9" },
      });
    for (let index = 0; index < 60; index += 1) {
      await GET(same(), { params: Promise.resolve({ token: TOKEN }) });
    }
    await expectUniform404(
      await GET(same(), { params: Promise.resolve({ token: TOKEN }) }),
    );
  });
});

import type { SeoSite } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: DNS TXT kaydı (parçalı döndüğünde de) ve ana
// sayfadaki meta etiketi doğrular; ikisi de yoksa not_found ve başarısızlık
// sayacı artar; alan adı yoksa no_domain; mock kipte ağa çıkmadan MOCK;
// başarı kapsamı yeniden kurar (ensureForProject); izin listesi dışındaki
// projede ensureVerifyToken hiçbir şey yazmadan null döner.

const mocks = vi.hoisted(() => ({
  projectFindUnique: vi.fn(),
  siteUpdate: vi.fn(),
  siteUpdateMany: vi.fn(),
  siteFindUnique: vi.fn(),
  ensure: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: mocks.projectFindUnique },
    seoSite: {
      update: mocks.siteUpdate,
      updateMany: mocks.siteUpdateMany,
      findUnique: mocks.siteFindUnique,
    },
  },
}));
vi.mock("./sites", () => ({ SeoSites: { ensureForProject: mocks.ensure } }));

import {
  MOCK_VERIFICATION_TOKEN,
  mockSiteTransport,
} from "@/server/seo/crawl/mock-site";

import { checkSiteVerification, ensureVerifyToken } from "./verify";

const NOW = new Date("2026-10-06T12:00:00Z");

function site(overrides: Partial<SeoSite> = {}): Partial<SeoSite> {
  return { id: "site-1", projectId: "p1", verifyToken: "abc123", ...overrides };
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AGENTELSE_PROVIDER_MODE;
  delete process.env.SEO_ROLLOUT_PROJECTS;
  delete process.env.SEO_DEV_PROJECTS;
  mocks.projectFindUnique.mockResolvedValue({ domain: "example.com" });
  mocks.ensure.mockResolvedValue(site());
  mocks.siteUpdate.mockResolvedValue({});
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("checkSiteVerification", () => {
  it("matches a DNS TXT record split into chunks", async () => {
    const resolveTxt = vi
      .fn()
      .mockResolvedValue([
        ["v=spf1 -all"],
        ["agentelse-site-", "verification=abc", "123"],
      ]);

    const result = await checkSiteVerification("p1", { resolveTxt }, NOW);

    expect(result).toEqual({ ok: true, method: "DNS" });
    expect(resolveTxt).toHaveBeenCalledWith("example.com");
    expect(mocks.siteUpdate).toHaveBeenCalledWith({
      where: { id: "site-1" },
      data: {
        verifiedDomain: "example.com",
        verifyMethod: "DNS",
        verifiedAt: NOW,
        verifyFailures: 0,
        verifyCheckedAt: NOW,
      },
    });
    // Başarı kapsamı sıfırlamalı yoldan yeniden kurar.
    expect(mocks.ensure).toHaveBeenLastCalledWith("p1", NOW);
  });

  it("matches the meta tag on the homepage via the transport", async () => {
    mocks.ensure.mockResolvedValue(
      site({ verifyToken: MOCK_VERIFICATION_TOKEN }),
    );
    const resolveTxt = vi.fn().mockRejectedValue(new Error("ENODATA"));

    const result = await checkSiteVerification(
      "p1",
      { resolveTxt, transport: mockSiteTransport() },
      NOW,
    );

    expect(result).toEqual({ ok: true, method: "META" });
  });

  it("returns not_found and counts the failure when neither is present", async () => {
    const resolveTxt = vi.fn().mockResolvedValue([["something-else"]]);
    const transport = mockSiteTransport({
      overrides: {
        "/": {
          html: "<html><head><title>Home</title></head><body>Hi</body></html>",
        },
      },
    });

    const result = await checkSiteVerification(
      "p1",
      { resolveTxt, transport },
      NOW,
    );

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(mocks.siteUpdate).toHaveBeenCalledWith({
      where: { id: "site-1" },
      data: { verifyFailures: { increment: 1 }, verifyCheckedAt: NOW },
    });
  });

  it("returns no_domain without a project domain", async () => {
    mocks.projectFindUnique.mockResolvedValue({ domain: null });

    const result = await checkSiteVerification("p1", {}, NOW);

    expect(result).toEqual({ ok: false, reason: "no_domain" });
    expect(mocks.siteUpdate).not.toHaveBeenCalled();
  });

  it("verifies as MOCK in mock mode without touching the network", async () => {
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    const resolveTxt = vi.fn();
    const transport = vi.fn();

    const result = await checkSiteVerification(
      "p1",
      { resolveTxt, transport },
      NOW,
    );

    expect(result).toEqual({ ok: true, method: "MOCK" });
    expect(resolveTxt).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("is unavailable for a project outside the rollout list", async () => {
    process.env.SEO_ROLLOUT_PROJECTS = "other";

    const result = await checkSiteVerification("p1", {}, NOW);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(mocks.projectFindUnique).not.toHaveBeenCalled();
  });
});

describe("ensureVerifyToken", () => {
  it("returns null without any write when the project is not allowed", async () => {
    process.env.SEO_ROLLOUT_PROJECTS = "other";

    expect(await ensureVerifyToken("p1")).toBeNull();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.siteUpdateMany).not.toHaveBeenCalled();
  });

  it("creates the token once with a compare-and-set", async () => {
    mocks.ensure.mockResolvedValue(site({ verifyToken: null }));
    mocks.siteFindUnique.mockResolvedValue({ verifyToken: "generated" });

    const result = await ensureVerifyToken("p1");

    expect(result).toEqual({ token: "generated", domain: "example.com" });
    const call = mocks.siteUpdateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: { verifyToken: string };
    };
    expect(call.where).toEqual({ id: "site-1", verifyToken: null });
    expect(call.data.verifyToken).toMatch(/^[a-z2-7]{24}$/);
  });

  it("returns the existing token without writing", async () => {
    const result = await ensureVerifyToken("p1");

    expect(result).toEqual({ token: "abc123", domain: "example.com" });
    expect(mocks.siteUpdateMany).not.toHaveBeenCalled();
  });
});

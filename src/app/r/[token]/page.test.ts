import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: geçersiz / süresi dolmuş / iptal / bilinmeyen /
// bayrak kapalı / çizici hatası / çizici null / hız sınırı AYNI notFound()
// sonucunu verir; 60 istekten sonra IP başına sınır (getClientIp ile);
// metadata noindex + no-referrer; geçerli belirteç çerçeveyi marka ve
// "Agentelse" yazısı olmadan çizer; not-found sayfası nötrdür.

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  resolve: vi.fn(),
  rendererFor: vi.fn(),
  renderer: vi.fn(),
}));

class NotFoundSignal extends Error {}

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/server/report-share/store", () => ({
  ReportShares: { resolve: mocks.resolve },
}));
vi.mock("@/server/report-share/renderers", () => ({
  shareRendererFor: mocks.rendererFor,
}));
vi.mock("@/server/report-share/register-all", () => ({}));

import NotAvailable from "../not-found";
import SharedReportPage, { metadata } from "./page";

const TOKEN = "clshare0123456789abcdefg.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
let ipCounter = 0;

function share(overrides: Record<string, unknown> = {}) {
  return {
    id: "clshare0123456789abcdefg",
    workspaceId: "ws1",
    projectId: "p1",
    kind: "SEARCH",
    reportId: "rep1",
    branding: {
      displayName: "Acme Agency",
      accent: "blue",
      footer: "Prepared by Acme.",
      logoAssetId: null,
    },
    ...overrides,
  };
}

function call(token = TOKEN) {
  return SharedReportPage({ params: Promise.resolve({ token }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("GSC_AGENCY", "true");
  ipCounter += 1;
  mocks.headers.mockResolvedValue(
    new Headers({ "x-forwarded-for": `203.0.113.${ipCounter}` }),
  );
  mocks.resolve.mockResolvedValue({ ok: true, share: share() });
  mocks.renderer.mockResolvedValue({
    title: "Weekly report",
    periodLabel: "Sep 28 - Oct 4",
    node: createElement("p", null, "Report body"),
  });
  mocks.rendererFor.mockReturnValue(mocks.renderer);
});

describe("shared report page", () => {
  it("is noindex with no referrer", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe("no-referrer");
    expect(metadata.title).toBe("Report");
  });

  it("renders the frame with the stored branding and no Agentelse text", async () => {
    const element = (await call()) as ReactElement;
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Acme Agency");
    expect(html).toContain("Weekly report");
    expect(html).toContain("Sep 28 - Oct 4");
    expect(html).toContain("Report body");
    expect(html).toContain("Prepared by Acme.");
    expect(html.toLowerCase()).not.toContain("agentelse");
    expect(mocks.renderer).toHaveBeenCalledWith({
      projectId: "p1",
      reportId: "rep1",
      branding: share().branding,
    });
  });

  it("points the logo at the share's own logo route", async () => {
    mocks.resolve.mockResolvedValue({
      ok: true,
      share: share({
        branding: {
          displayName: "Acme",
          accent: "slate",
          footer: null,
          logoAssetId: "logo1",
        },
      }),
    });
    const html = renderToStaticMarkup((await call()) as ReactElement);
    expect(html).toContain(`src="/r/${TOKEN}/logo"`);
    expect(html).not.toContain("/api/assets");
  });

  it("calls notFound when the token does not resolve", async () => {
    mocks.resolve.mockResolvedValue({ ok: false });
    await expect(call()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(mocks.renderer).not.toHaveBeenCalled();
  });

  it("calls notFound when both flags are off, before any lookup", async () => {
    vi.stubEnv("GSC_AGENCY", "false");
    vi.stubEnv("GA_AGENCY", "false");
    await expect(call()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("calls notFound when no renderer is registered for the kind", async () => {
    mocks.rendererFor.mockReturnValue(null);
    await expect(call()).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("calls notFound for a kind the registry does not know", async () => {
    mocks.resolve.mockResolvedValue({ ok: true, share: share({ kind: "X" }) });
    await expect(call()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(mocks.rendererFor).not.toHaveBeenCalled();
  });

  it("calls notFound when the renderer returns null or throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.renderer.mockResolvedValueOnce(null);
    await expect(call()).rejects.toBeInstanceOf(NotFoundSignal);
    mocks.renderer.mockRejectedValueOnce(new Error("boom with details"));
    await expect(call()).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("rate-limits per client IP after 60 requests in a window", async () => {
    mocks.headers.mockResolvedValue(
      new Headers({ "x-forwarded-for": "198.51.100.77, 10.0.0.1" }),
    );
    for (let index = 0; index < 60; index += 1) {
      await call();
    }
    await expect(call()).rejects.toBeInstanceOf(NotFoundSignal);
    // Başka IP etkilenmez.
    mocks.headers.mockResolvedValue(
      new Headers({ "x-forwarded-for": "198.51.100.78" }),
    );
    await expect(call()).resolves.toBeDefined();
  });
});

describe("not-found page", () => {
  it("shows a neutral message with no product wording and no links", () => {
    const html = renderToStaticMarkup(createElement(NotAvailable));
    expect(html).toContain("This link isn&#x27;t available.");
    expect(html.toLowerCase()).not.toContain("agentelse");
    expect(html).not.toContain("<a");
  });
});

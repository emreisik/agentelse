import { describe, expect, it, vi } from "vitest";

import type { Transport } from "@/server/security/safe-fetch";

import { defaultSiteFetcher, GA_SITE_CHECK_UA } from "./site-tag";

// Entegrasyon kapısı: site etiketi kontrolü safe-fetch'in userAgent
// seçeneğiyle kendi kimliğini (AgentelseSiteCheck) gönderir; robots.txt bu
// kimliğe göre değerlendirildiği için sayfa ve robots istekleri aynı UA'yı
// taşımalıdır. Yönlendirme yalnız aynı siteye izlenir (yol başka sunucuya
// gitmez).

function fakeTransport() {
  return vi.fn<Transport>(async () => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: Buffer.from("<html>ok</html>"),
    truncated: false,
  }));
}

describe("GA site check user agent", () => {
  it("sends AgentelseSiteCheck for page and robots.txt requests", async () => {
    const html = fakeTransport();
    await defaultSiteFetcher("html", html)("https://93.184.216.34/");
    expect(html.mock.calls[0]![1].userAgent).toBe(GA_SITE_CHECK_UA);

    const robots = fakeTransport();
    await defaultSiteFetcher(
      "robots",
      robots,
    )("https://93.184.216.34/robots.txt");
    expect(robots.mock.calls[0]![1].userAgent).toBe(GA_SITE_CHECK_UA);
  });

  it("never follows a redirect to another site", async () => {
    const transport = vi.fn<Transport>(async (url) =>
      url.pathname === "/pricing"
        ? {
            status: 301,
            headers: { location: "https://8.8.8.8/pricing" },
            body: Buffer.alloc(0),
            truncated: false,
          }
        : {
            status: 200,
            headers: { "content-type": "text/html" },
            body: Buffer.from("<html>ok</html>"),
            truncated: false,
          },
    );
    expect(
      await defaultSiteFetcher("html", transport)(
        "https://93.184.216.34/pricing",
      ),
    ).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect on the same site", async () => {
    const transport = vi.fn<Transport>(async (url) =>
      url.pathname === "/old"
        ? {
            status: 301,
            headers: { location: "/new" },
            body: Buffer.alloc(0),
            truncated: false,
          }
        : {
            status: 200,
            headers: { "content-type": "text/html" },
            body: Buffer.from("<html>ok</html>"),
            truncated: false,
          },
    );
    const result = await defaultSiteFetcher("html", transport)(
      "https://93.184.216.34/old",
    );
    expect(result?.finalUrl).toBe("https://93.184.216.34/new");
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

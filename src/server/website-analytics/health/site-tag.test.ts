import { afterEach, describe, expect, it, vi } from "vitest";

import type { Transport } from "@/server/security/safe-fetch";

import {
  defaultSiteFetcher,
  GA_SITE_CHECK_TOKEN,
  scanSiteTags,
  type SiteFetchResult,
  type SiteFetcher,
} from "./site-tag";

// Bu dosyanın kanıtladığı: robots.txt bizi yasaklarsa hiçbir sayfa
// getirilmez (blocked_by_robots); robots 5xx ya da ulaşılamazsa
// fetch_failed; robots 404 her şeye izin verir; her sayfa isteğinden önce
// 1 sn beklenir; başka alan adına yönlenen sayfa başarısız sayılır; 45 sn
// bütçe dolunca durulur; sonuçta adres yoktur; mock modda ağa çıkılmaz.

const HOST = "example.com";
const NOW = new Date("2026-10-06T10:00:00.000Z");
const PATHS = ["/", "/pricing", "/blog/post"];

const TAGGED = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-EXPECT01"></script>
<script>gtag('config','G-EXPECT01')</script><a href="tel:+905551112233">call</a>`;

function page(
  url: string,
  body = TAGGED,
  status = 200,
  finalUrl = url,
): SiteFetchResult {
  return { status, finalUrl, body };
}

function harness(options: {
  robots: SiteFetchResult | null;
  html?: (url: string) => SiteFetchResult | null;
  stepMs?: number;
}) {
  let time = 0;
  const calls: string[] = [];
  const fetchRobots = vi.fn<SiteFetcher>(async (url) => {
    calls.push(`robots ${url}`);
    return options.robots;
  });
  const fetchHtml = vi.fn<SiteFetcher>(async (url) => {
    calls.push(`html ${url}`);
    return options.html ? options.html(url) : page(url);
  });
  const sleep = vi.fn(async (ms: number) => {
    calls.push(`sleep ${ms}`);
    time += options.stepMs ?? ms;
  });
  return {
    calls,
    fetchHtml,
    fetchRobots,
    sleep,
    deps: { fetchHtml, fetchRobots, sleep, clock: () => time },
  };
}

const robotsText = (text: string, status = 200): SiteFetchResult => ({
  status,
  finalUrl: `https://${HOST}/robots.txt`,
  body: text,
});

const scan = (deps: ReturnType<typeof harness>["deps"], paths = PATHS) =>
  scanSiteTags({ host: HOST, paths, expectedId: "G-EXPECT01", now: NOW }, deps);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("scanSiteTags", () => {
  it("stops at robots.txt when our token is disallowed", async () => {
    const h = harness({
      robots: robotsText(
        `User-agent: ${GA_SITE_CHECK_TOKEN}\nDisallow: /\n\nUser-agent: *\nAllow: /`,
      ),
    });
    const result = await scan(h.deps);
    expect(result.outcome).toBe("blocked_by_robots");
    expect(result.pagesChecked).toBe(0);
    expect(h.fetchHtml).not.toHaveBeenCalled();
    expect(h.fetchRobots).toHaveBeenCalledWith(
      "https://example.com/robots.txt",
    );
  });

  it("skips only the disallowed paths", async () => {
    const h = harness({ robots: robotsText("User-agent: *\nDisallow: /blog") });
    const result = await scan(h.deps);
    expect(h.fetchHtml.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/",
      "https://example.com/pricing",
    ]);
    expect(result.pagesChecked).toBe(2);
  });

  it("is fetch_failed without page fetches when robots.txt fails", async () => {
    for (const robots of [robotsText("", 503), null]) {
      const h = harness({ robots });
      const result = await scan(h.deps);
      expect(result.outcome).toBe("fetch_failed");
      expect(result.pagesChecked).toBe(0);
      expect(result.pagesFailed).toBe(0);
      expect(h.fetchHtml).not.toHaveBeenCalled();
    }
  });

  it("treats a missing robots.txt as allow-all and sleeps 1 s before each page", async () => {
    const h = harness({ robots: robotsText("", 404) });
    const result = await scan(h.deps);
    expect(h.calls).toEqual([
      "robots https://example.com/robots.txt",
      "sleep 1000",
      "html https://example.com/",
      "sleep 1000",
      "html https://example.com/pricing",
      "sleep 1000",
      "html https://example.com/blog/post",
    ]);
    expect(result).toMatchObject({
      outcome: "ok",
      host: HOST,
      pagesChecked: 3,
      pagesFailed: 0,
      pagesWithExpected: 3,
      expectedId: "G-EXPECT01",
      gtagJs: true,
      at: NOW.toISOString(),
    });
    expect(result.hints.tel).toBe(true);
  });

  it("counts off-site redirects, errors and non-2xx pages as failed", async () => {
    const h = harness({
      robots: robotsText("", 404),
      html: (url) => {
        if (url.endsWith("/pricing"))
          return page(url, TAGGED, 200, "https://other-site.test/pricing");
        if (url.endsWith("/blog/post")) return page(url, "", 404);
        return page(url, TAGGED, 200, "https://www.example.com/");
      },
    });
    const result = await scan(h.deps);
    expect(result.pagesChecked).toBe(1);
    expect(result.pagesFailed).toBe(2);
    expect(result.outcome).toBe("ok");

    const failing = harness({ robots: robotsText("", 404), html: () => null });
    expect((await scan(failing.deps)).outcome).toBe("fetch_failed");
  });

  it("stops when the 45 s budget is spent", async () => {
    const h = harness({ robots: robotsText("", 404), stepMs: 20_000 });
    const result = await scan(h.deps, ["/", "/1", "/2", "/3", "/4", "/5"]);
    // 20 sn'lik iki bekleme sonrası üçüncü bekleme bütçeyi aşar.
    expect(h.fetchHtml).toHaveBeenCalledTimes(2);
    expect(result.pagesChecked).toBe(2);
    expect(result.pagesFailed).toBe(0);
  });

  it("never puts URLs or paths into the result", async () => {
    const h = harness({
      robots: robotsText("", 404),
      html: (url) =>
        page(url, `${TAGGED}<a href="https://example.com/secret-path">x</a>`),
    });
    const json = JSON.stringify(await scan(h.deps, ["/", "/secret-landing"]));
    expect(json).not.toContain("https://");
    expect(json).not.toContain("secret");
    expect(json).not.toContain("robots");
  });

  it("returns the mock result in mock mode without default fetchers", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    const result = await scanSiteTags({
      host: HOST,
      paths: PATHS,
      expectedId: "G-EXPECT01",
      now: NOW,
    });
    expect(result).toMatchObject({
      outcome: "ok",
      pagesChecked: 1,
      pagesWithExpected: 1,
    });
  });
});

describe("defaultSiteFetcher", () => {
  const transport = (status: number, contentType = "text/html; charset=utf-8") =>
    vi.fn<Transport>(async () => ({
      status,
      headers: { "content-type": contentType },
      body: Buffer.from("<html>ok</html>"),
      truncated: false,
    }));

  it("returns the body, status and final URL", async () => {
    const fake = transport(200);
    expect(await defaultSiteFetcher("html", fake)("https://93.184.216.34/")).toEqual({
      status: 200,
      finalUrl: "https://93.184.216.34/",
      body: "<html>ok</html>",
    });
    const [, options] = fake.mock.calls[0]!;
    expect(options).toMatchObject({
      maxBytes: 1_500_000,
      truncate: true,
      accept: "text/html,application/xhtml+xml",
    });
  });

  it("keeps the status of a non-2xx answer and drops other failures", async () => {
    expect(await defaultSiteFetcher("robots", transport(404))("https://93.184.216.34/robots.txt")).toEqual({
      status: 404,
      finalUrl: "https://93.184.216.34/robots.txt",
      body: "",
    });
    // Yanlış içerik türü (UnsafeUrlError) ve güvensiz adres sessizce null.
    expect(await defaultSiteFetcher("html", transport(200, "image/png"))("https://93.184.216.34/")).toBeNull();
    expect(await defaultSiteFetcher("html", transport(200))("http://127.0.0.1/")).toBeNull();
  });
});

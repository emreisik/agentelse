import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run: vi.fn() },
}));

const { scanWebsite, normalizeScanUrl } = await import("./scan");
const { UnsafeUrlError } = await import("@/server/security/safe-fetch");

import type { SafeFetchResult } from "@/server/security/safe-fetch";

const scope = { workspaceId: "ws", projectId: "p", brandId: "b" };

let logoPng: Buffer;
beforeAll(async () => {
  // A 120x60 teal logo on a transparent background.
  logoPng = await sharp({
    create: { width: 120, height: 60, channels: 4, background: { r: 13, g: 148, b: 136, alpha: 1 } },
  })
    .png()
    .toBuffer();
});

const HTML = `<html lang="tr"><head><title>Web Health</title>
<meta name="theme-color" content="#0b1f3a">
<meta property="og:image" content="/og.png">
<link rel="stylesheet" href="/app.css">
<link rel="manifest" href="/site.webmanifest"></head>
<body><header><a href="/"><img class="logo" src="/logo.png" alt="Web Health logo"></a></header></body></html>`;

const CSS = `:root{--brand-primary:#0b1f3a;--accent:#2dd4bf} body{font-family:"Inter",sans-serif} h1{font-family:"Playfair Display",serif}`;
const MANIFEST = JSON.stringify({ theme_color: "#0b1f3a", background_color: "#ffffff", icons: [] });

function res(url: string, body: Buffer | string, contentType: string): SafeFetchResult {
  return {
    url,
    status: 200,
    contentType,
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    truncated: false,
  };
}

function siteFetcher(overrides: Record<string, () => SafeFetchResult> = {}) {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: string): Promise<SafeFetchResult> => {
    // The real safeFetch returns the normalized URL ("https://host" gains
    // its trailing slash); mirror that so routing matches.
    const url = new URL(input).toString();
    calls.push(url);
    if (overrides[url]) return overrides[url]!();
    if (url === "https://webhealth.com.tr/") return res(url, HTML, "text/html");
    if (url.endsWith("/app.css")) return res(url, CSS, "text/css");
    if (url.endsWith("/site.webmanifest")) return res(url, MANIFEST, "application/json");
    if (url.endsWith("/logo.png") || url.endsWith("/og.png")) return res(url, logoPng, "image/png");
    throw new Error(`HTTP 404 for ${url}`);
  });
  return { fetcher: fetcher as never, calls };
}

const suggestion = (overrides: Record<string, unknown> = {}) => ({
  output: {
    primaryColors: [{ hex: "#0b1f3a", name: "Navy" }],
    secondaryColors: [{ hex: "#0d9488", name: "Teal" }],
    accentColors: [{ hex: "#2dd4bf" }],
    photographyStyle: "PHOTOGRAPHIC" as const,
    styleRefinement: "Soft daylight, clean surfaces.",
    moodTags: ["trustworthy", "calm"],
    compositionNotes: "Generous negative space.",
    backgroundTone: "DARK" as const,
    alwaysAvoid: ["stock smiles"],
    ...overrides,
  },
  isMock: false,
  reasoningCallId: "rc",
});

describe("normalizeScanUrl", () => {
  it("adds https to a bare domain and keeps explicit schemes", () => {
    expect(normalizeScanUrl(" webhealth.com.tr ")).toBe("https://webhealth.com.tr");
    expect(normalizeScanUrl("http://example.com")).toBe("http://example.com");
    expect(() => normalizeScanUrl("  ")).toThrow(UnsafeUrlError);
  });
});

describe("scanWebsite", () => {
  it("extracts logo, palette, fonts and style from a site", async () => {
    const { fetcher } = siteFetcher();
    const reason = vi.fn().mockResolvedValue(suggestion());

    const result = await scanWebsite("webhealth.com.tr", scope, { fetch: fetcher, reason });

    expect(result.title).toBe("Web Health");
    expect(result.logo?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(result.logo?.source).toContain("logo");
    expect(result.logo?.fallback).toBe(false);
    // The fixture logo is a flat teal rectangle: a dark / mid-tone mark on a
    // solid background, which the scan flags.
    expect(result.logo?.tone).toBe("dark");
    expect(result.logo?.hasSolidBackground).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/solid background/);
    expect(result.colors.primary.map((c) => c.hex)).toEqual(["#0b1f3a"]);
    expect(result.colors.secondary.map((c) => c.hex)).toEqual(["#0d9488"]);
    expect(result.colors.accent.map((c) => c.hex)).toEqual(["#2dd4bf"]);
    expect(result.fonts).toEqual(expect.arrayContaining(["Inter", "Playfair Display"]));
    expect(result.style).toMatchObject({
      photographyStyle: "PHOTOGRAPHIC",
      backgroundTone: "DARK",
      moodTags: ["trustworthy", "calm"],
    });

    // The model was given the candidates, plus the logo and site image.
    const call = reason.mock.calls[0]!;
    expect(call[1].attachments).toHaveLength(2);
    expect(JSON.stringify(call[1].context.colorCandidates)).toContain("#0b1f3a");
  });

  it("never lets the model invent colours or reuse one across roles", async () => {
    const { fetcher } = siteFetcher();
    const reason = vi.fn().mockResolvedValue(
      suggestion({
        primaryColors: [{ hex: "#ff00ff" }, { hex: "#0b1f3a" }], // invented + real
        secondaryColors: [{ hex: "#0b1f3a" }], // duplicate of primary
        accentColors: [{ hex: "#2dd4bf" }],
      }),
    );
    const result = await scanWebsite("webhealth.com.tr", scope, { fetch: fetcher, reason });

    expect(result.colors.primary.map((c) => c.hex)).toEqual(["#0b1f3a"]);
    expect(result.colors.secondary).toEqual([]);
    expect(result.colors.accent.map((c) => c.hex)).toEqual(["#2dd4bf"]);
  });

  it("falls back to ranked candidates when nothing the model said is usable", async () => {
    const { fetcher } = siteFetcher();
    const reason = vi.fn().mockResolvedValue(
      suggestion({ primaryColors: [{ hex: "#123456" }], secondaryColors: [], accentColors: [] }),
    );
    const result = await scanWebsite("webhealth.com.tr", scope, { fetch: fetcher, reason });

    expect(result.colors.primary.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toMatch(/chosen by frequency/);
  });

  it("degrades gracefully on a bare page with no logo or styles", async () => {
    const { fetcher } = siteFetcher({
      "https://webhealth.com.tr/": () => res("https://webhealth.com.tr/", "<html><head><title>x</title></head><body></body></html>", "text/html"),
    });
    const reason = vi.fn().mockResolvedValue(
      suggestion({ primaryColors: [], secondaryColors: [], accentColors: [] }),
    );
    const result = await scanWebsite("webhealth.com.tr", scope, { fetch: fetcher, reason });

    expect(result.logo).toBeNull();
    expect(result.colors.primary).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/No logo/);
    expect(result.warnings.join(" ")).toMatch(/No distinct brand colours/);
  });

  it("rejects an unsafe start URL before any request is made", async () => {
    const { fetcher, calls } = siteFetcher();
    const guarded = vi.fn(async (url: string, o: unknown) => {
      const { assertSafeUrl } = await import("@/server/security/safe-fetch");
      assertSafeUrl(url);
      return (fetcher as (u: string, o: unknown) => Promise<SafeFetchResult>)(url, o);
    });
    await expect(
      scanWebsite("http://169.254.169.254/", scope, {
        fetch: guarded as never,
        reason: vi.fn(),
      }),
    ).rejects.toThrow(/not publicly reachable/);
    expect(calls).toEqual([]);
  });

  it("skips a logo the site serves from a forbidden address and tries the next", async () => {
    const html = `<html><body><header>
      <img class="logo" src="http://10.0.0.5/logo.png">
      <img class="logo-mark" src="/logo.png"></header></body></html>`;
    const { fetcher } = siteFetcher({
      "https://webhealth.com.tr/": () => res("https://webhealth.com.tr/", html, "text/html"),
      "http://10.0.0.5/logo.png": () => {
        throw new UnsafeUrlError("That address is not publicly reachable");
      },
    });
    const reason = vi.fn().mockResolvedValue(suggestion());
    const result = await scanWebsite("webhealth.com.tr", scope, { fetch: fetcher, reason });
    expect(result.logo).not.toBeNull();
  });
});

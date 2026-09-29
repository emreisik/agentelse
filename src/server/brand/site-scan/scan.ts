import "server-only";

import { ReasoningService } from "@/server/reasoning/reasoning-service";
import {
  brandSiteScanDef,
  type BrandSiteScanSuggestion,
} from "@/server/reasoning/prompts/brand-site-scan";
import {
  safeFetch,
  UnsafeUrlError,
  type SafeFetchResult,
} from "@/server/security/safe-fetch";

import {
  cssColorToHex,
  extractCssFacts,
  extractHtmlFacts,
  hexToRgb,
  rankColors,
  type ColorSignal,
  type HtmlFacts,
} from "./extract";
import {
  analyzeLogo,
  dominantColors,
  prepareLogo,
  prepareVisionImage,
  type LogoTone,
} from "./image-colors";

// Orchestrates one brand scan: page -> stylesheets/manifest -> logo -> colour
// and font facts -> OpenAI interpretation -> a validated, NOT-yet-saved
// suggestion. Nothing here writes to the database; the caller (server
// action) returns the result to the user, who reviews it before applying.

const HTML_LIMIT = 2 * 1024 * 1024;
const CSS_LIMIT = 500 * 1024;
const MANIFEST_LIMIT = 100 * 1024;
const IMAGE_LIMIT = 3 * 1024 * 1024;
const MAX_LOGO_TRIES = 4;
const SNAP_DISTANCE = 30;

export type Swatch = { hex: string; name?: string };

export type SiteScanResult = {
  url: string;
  siteName?: string;
  title?: string;
  description?: string;
  logo: {
    dataUrl: string;
    width: number;
    height: number;
    // Where it came from, shown so the user can judge it.
    source: string;
    // true when it is an icon / social image, not a real logo.
    fallback: boolean;
    // "light": a light-coloured mark, legible on dark backgrounds (stored in
    // the light-logo slot). "dark": a dark / mid-tone mark for light
    // backgrounds (the dark-logo slot).
    tone: LogoTone;
    // A logo baked onto a solid background shows up as a box on posts.
    hasSolidBackground: boolean;
  } | null;
  colors: {
    primary: Swatch[];
    secondary: Swatch[];
    accent: Swatch[];
    neutrals: string[];
  };
  fonts: string[];
  style: Omit<
    BrandSiteScanSuggestion,
    "primaryColors" | "secondaryColors" | "accentColors"
  >;
  warnings: string[];
};

export type ScanScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type ScanDeps = {
  fetch?: typeof safeFetch;
  reason?: typeof ReasoningService.run;
};

const IMAGE_TYPES =
  /^(image\/(png|jpe?g|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon)|application\/octet-stream)/i;

export function normalizeScanUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new UnsafeUrlError("Enter a website address");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
}

async function tryFetch(
  fetcher: typeof safeFetch,
  url: string,
  options: Parameters<typeof safeFetch>[1],
): Promise<SafeFetchResult | null> {
  try {
    return await fetcher(url, options);
  } catch (error) {
    // An unsafe URL from the page itself (e.g. a logo hosted on a private
    // address) is simply skipped; the top-level URL was validated separately.
    if (!(error instanceof UnsafeUrlError)) {
      console.warn(
        "[site-scan] fetch failed:",
        url,
        error instanceof Error ? error.message : error,
      );
    }
    return null;
  }
}

async function fetchPage(
  fetcher: typeof safeFetch,
  input: string,
  hadScheme: boolean,
): Promise<SafeFetchResult> {
  const options = {
    maxBytes: HTML_LIMIT,
    truncate: true,
    timeoutMs: 12_000,
    accept: "text/html,application/xhtml+xml",
    allowedContentTypes: /^(text\/html|application\/xhtml\+xml)/i,
  };
  try {
    return await fetcher(input, options);
  } catch (error) {
    // A bare domain defaults to https; some sites only answer on http.
    if (!hadScheme && !(error instanceof UnsafeUrlError)) {
      return fetcher(input.replace(/^https:/, "http:"), options);
    }
    throw error;
  }
}

async function manifestFacts(
  fetcher: typeof safeFetch,
  manifestUrl: string | undefined,
): Promise<{ signals: ColorSignal[]; icons: { url: string; size: number }[] }> {
  if (!manifestUrl) return { signals: [], icons: [] };
  const response = await tryFetch(fetcher, manifestUrl, {
    maxBytes: MANIFEST_LIMIT,
    timeoutMs: 6000,
    accept: "application/manifest+json,application/json",
  });
  if (!response) return { signals: [], icons: [] };
  try {
    const manifest = JSON.parse(response.body.toString("utf-8")) as {
      theme_color?: string;
      background_color?: string;
      icons?: { src?: string; sizes?: string }[];
    };
    const signals: ColorSignal[] = [];
    const theme = manifest.theme_color && cssColorToHex(manifest.theme_color);
    if (theme)
      signals.push({ hex: theme, weight: 40, source: "manifest:theme_color" });
    const bg =
      manifest.background_color && cssColorToHex(manifest.background_color);
    if (bg)
      signals.push({ hex: bg, weight: 8, source: "manifest:background_color" });
    const icons = (manifest.icons ?? []).flatMap((icon) => {
      if (!icon.src) return [];
      try {
        return [
          {
            url: new URL(icon.src, response.url).toString(),
            size: Number(icon.sizes?.split(/\s+/)[0]?.split("x")[0]) || 64,
          },
        ];
      } catch {
        return [];
      }
    });
    return { signals, icons };
  } catch {
    return { signals: [], icons: [] };
  }
}

// What findLogo returns: the logo without the pixel analysis (tone, solid
// background), which scanWebsite adds once it has the final PNG.
type LogoPick = Omit<
  NonNullable<SiteScanResult["logo"]>,
  "tone" | "hasSolidBackground"
> & { png: Buffer };

async function findLogo(
  fetcher: typeof safeFetch,
  facts: HtmlFacts,
  manifestIcons: { url: string; size: number }[],
): Promise<LogoPick | null> {
  const attempts: {
    source: string;
    fallback: boolean;
    load: () => Promise<Buffer | null>;
  }[] = [];

  for (const candidate of facts.logoCandidates) {
    if (candidate.kind === "svg") {
      attempts.push({
        source: "inline SVG logo",
        fallback: false,
        load: async () => Buffer.from(candidate.svg, "utf-8"),
      });
    } else {
      attempts.push({
        source: `logo image (${new URL(candidate.url).pathname.split("/").pop() || "logo"})`,
        fallback: false,
        load: async () => {
          const res = await tryFetch(fetcher, candidate.url, {
            maxBytes: IMAGE_LIMIT,
            timeoutMs: 8000,
            accept: "image/*",
            allowedContentTypes: IMAGE_TYPES,
          });
          return res?.body ?? null;
        },
      });
    }
  }

  const icons = [...facts.icons, ...manifestIcons].sort(
    (a, b) => b.size - a.size,
  );
  for (const icon of icons.slice(0, 2)) {
    // .ico files can't be decoded by sharp; skip them rather than fail late.
    if (/\.ico(\?|$)/i.test(icon.url)) continue;
    attempts.push({
      source: `site icon (${icon.size}px)`,
      fallback: true,
      load: async () => {
        const res = await tryFetch(fetcher, icon.url, {
          maxBytes: IMAGE_LIMIT,
          timeoutMs: 8000,
          accept: "image/*",
          allowedContentTypes: IMAGE_TYPES,
        });
        return res?.body ?? null;
      },
    });
  }

  for (const attempt of attempts.slice(0, MAX_LOGO_TRIES + 2)) {
    const raw = await attempt.load();
    if (!raw) continue;
    const prepared = await prepareLogo(raw);
    if (!prepared) continue;
    return {
      dataUrl: `data:image/png;base64,${prepared.png.toString("base64")}`,
      width: prepared.width,
      height: prepared.height,
      source: attempt.source,
      fallback: attempt.fallback,
      png: prepared.png,
    };
  }
  return null;
}

function snapToCandidate(
  hex: string,
  candidates: readonly string[],
): string | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  let best: { hex: string; d: number } | null = null;
  for (const candidate of candidates) {
    const c = hexToRgb(candidate);
    if (!c) continue;
    const d = Math.sqrt(
      (rgb.r - c.r) ** 2 + (rgb.g - c.g) ** 2 + (rgb.b - c.b) ** 2,
    );
    if (!best || d < best.d) best = { hex: candidate, d };
  }
  return best && best.d <= SNAP_DISTANCE ? best.hex : null;
}

export async function scanWebsite(
  urlInput: string,
  scope: ScanScope,
  deps: ScanDeps = {},
): Promise<SiteScanResult> {
  const fetcher = deps.fetch ?? safeFetch;
  const reason = deps.reason ?? ReasoningService.run.bind(ReasoningService);
  const warnings: string[] = [];

  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(urlInput.trim());
  const page = await fetchPage(fetcher, normalizeScanUrl(urlInput), hadScheme);
  const html = page.body.toString("utf-8");
  const facts = extractHtmlFacts(html, page.url);

  if (page.truncated)
    warnings.push("The page is large; only its first part was read.");
  if (facts.logoCandidates.length === 0 && facts.icons.length === 0) {
    warnings.push(
      "No logo was found on the page. You can upload one afterwards.",
    );
  }

  // Stylesheets + manifest in parallel; both are optional.
  const [cssResults, manifest] = await Promise.all([
    Promise.all(
      facts.stylesheetUrls.map((url) =>
        tryFetch(fetcher, url, {
          maxBytes: CSS_LIMIT,
          truncate: true,
          timeoutMs: 8000,
          accept: "text/css",
          allowedContentTypes:
            /^text\/css|^text\/plain|^application\/octet-stream/i,
        }),
      ),
    ),
    manifestFacts(fetcher, facts.manifestUrl),
  ]);

  const signals: ColorSignal[] = [];
  const fontCounts = new Map<string, number>();
  const addFonts = (list: { name: string; count: number }[]) => {
    for (const f of list)
      fontCounts.set(f.name, (fontCounts.get(f.name) ?? 0) + f.count);
  };

  if (facts.themeColor)
    signals.push({ hex: facts.themeColor, weight: 50, source: "theme-color" });
  if (facts.tileColor)
    signals.push({ hex: facts.tileColor, weight: 30, source: "tile-color" });
  signals.push(...manifest.signals);

  const inlineCss = extractCssFacts(facts.inlineCss, "inline-css");
  signals.push(...inlineCss.colorSignals);
  addFonts(inlineCss.fonts);
  cssResults.forEach((res, i) => {
    if (!res) return;
    const css = extractCssFacts(res.body.toString("utf-8"), `css${i + 1}`);
    signals.push(...css.colorSignals);
    addFonts(css.fonts);
  });
  for (const name of facts.googleFonts)
    fontCounts.set(name, (fontCounts.get(name) ?? 0) + 20);

  if (cssResults.every((r) => r === null) && facts.stylesheetUrls.length > 0) {
    warnings.push(
      "The site's stylesheets could not be read; colours may be incomplete.",
    );
  }

  // Logo: the strongest colour evidence there is.
  const logo = await findLogo(fetcher, facts, manifest.icons);
  const logoAnalysis = logo ? await analyzeLogo(logo.png) : null;
  if (!logo) {
    warnings.push("No usable logo could be downloaded. Upload one manually.");
  } else {
    if (logo.fallback) {
      warnings.push(
        "Only a small site icon was found, not a full logo. Consider uploading the real logo.",
      );
    }
    if (logoAnalysis?.hasSolidBackground && !logo.fallback) {
      warnings.push(
        "The logo has a solid background, which will show as a box on posts. A transparent PNG or SVG works best.",
      );
    }
    const logoColors = await dominantColors(logo.png, 3);
    logoColors.forEach((hex, i) =>
      signals.push({ hex, weight: 60 - i * 10, source: "logo" }),
    );
  }

  const { chromatic, neutrals } = rankColors(signals);
  if (chromatic.length === 0) {
    warnings.push("No distinct brand colours were found on this site.");
  }

  // Images for the vision model: the logo, then the site's social image.
  const attachments: { mimeType: string; data: string }[] = [];
  const attached: string[] = [];
  if (logo) {
    attachments.push({
      mimeType: "image/png",
      data: logo.png.toString("base64"),
    });
    attached.push("logo");
  }
  if (facts.ogImage) {
    const og = await tryFetch(fetcher, facts.ogImage, {
      maxBytes: IMAGE_LIMIT,
      timeoutMs: 8000,
      accept: "image/*",
      allowedContentTypes: IMAGE_TYPES,
    });
    const jpeg = og ? await prepareVisionImage(og.body) : null;
    if (jpeg) {
      attachments.push({
        mimeType: "image/jpeg",
        data: jpeg.toString("base64"),
      });
      attached.push("hero / social image");
    }
  }

  const fonts = [...fontCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
    .slice(0, 4);

  const { output } = await reason(brandSiteScanDef, {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    brandId: scope.brandId,
    attachments: attachments.length ? attachments : undefined,
    context: {
      siteName: facts.siteName,
      title: facts.title,
      description: facts.description,
      pageLanguage: facts.language,
      colorCandidates: chromatic,
      neutrals: neutrals.map((n) => n.hex),
      fonts,
      attachedImages: attached.length ? attached.join(", ") : "none",
    },
  });

  // The model may only choose among the extracted candidates: anything else
  // is snapped to a candidate within tolerance or dropped, and no colour is
  // allowed in two roles.
  const candidateHexes = chromatic.map((c) => c.hex);
  const used = new Set<string>();
  const validate = (swatches: Swatch[], max: number): Swatch[] => {
    const out: Swatch[] = [];
    for (const swatch of swatches) {
      const hex = snapToCandidate(swatch.hex, candidateHexes);
      if (!hex || used.has(hex)) continue;
      used.add(hex);
      out.push({ hex, name: swatch.name?.slice(0, 40) });
      if (out.length >= max) break;
    }
    return out;
  };
  let primary = validate(output.primaryColors, 3);
  let secondary = validate(output.secondaryColors, 3);
  let accent = validate(output.accentColors, 2);

  // Nothing survived validation (or the model returned nothing): fall back to
  // the top ranked candidates so the user still gets a usable starting point.
  if (primary.length === 0 && candidateHexes.length > 0) {
    used.clear();
    primary = candidateHexes.slice(0, 1).map((hex) => ({ hex }));
    secondary = candidateHexes.slice(1, 3).map((hex) => ({ hex }));
    accent = candidateHexes.slice(3, 4).map((hex) => ({ hex }));
    warnings.push("Colours were chosen by frequency; review them.");
  }

  const {
    primaryColors: _p,
    secondaryColors: _s,
    accentColors: _a,
    ...style
  } = output;
  void _p;
  void _s;
  void _a;

  return {
    url: page.url,
    siteName: facts.siteName,
    title: facts.title,
    description: facts.description,
    logo:
      logo && logoAnalysis
        ? {
            dataUrl: logo.dataUrl,
            width: logo.width,
            height: logo.height,
            source: logo.source,
            fallback: logo.fallback,
            tone: logoAnalysis.tone,
            hasSolidBackground: logoAnalysis.hasSolidBackground,
          }
        : null,
    colors: {
      primary,
      secondary,
      accent,
      neutrals: neutrals.map((n) => n.hex),
    },
    fonts,
    style,
    warnings,
  };
}

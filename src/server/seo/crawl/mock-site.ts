import { gzipSync } from "node:zlib";

import {
  buildRequestHeaders,
  isBodyAllowed,
  type GuardedResponse,
  type GuardedTransport,
} from "@/server/security/guarded-transport";

// Mock kipinin bellek içi sitesi (docs/google-search-console-plan.md SC-F3):
// AGENTELSE_PROVIDER_MODE=mock iken tarayıcı hiçbir siteye gitmez, her alan
// adı için bu belirlenimci sayfaları görür. Sayfalar teknik denetimin her
// dalını tetikleyecek biçimde kurulu (yönlendirme zinciri, noindex, kopya
// içerik, karışık içerik, bozuk JSON-LD, hreflang, robots yasağı, gzip
// sitemap). Prisma yok; testler ve tatbikatlar override'larla oynar.

export const MOCK_VERIFICATION_TOKEN = "mock-verification-token";

const BLOG_POST_COUNT = 8;
const BLOG_POSTS = Array.from(
  { length: BLOG_POST_COUNT },
  (_, index) => `/blog/post-${index + 1}`,
);

export const MOCK_SITE_PATHS: readonly string[] = [
  "/",
  "/pricing",
  "/about",
  "/blog/",
  ...BLOG_POSTS,
  "/dup-a",
  "/dup-b",
  "/noindex-page",
  "/missing",
  "/old-page",
  "/chain-1",
  "/chain-2",
  "/chain-3",
  "/private/secret",
  "/mixed",
  "/schema-broken",
  "/hreflang-en",
  "/robots.txt",
  "/sitemap.xml",
  "/sitemap-pages.xml",
  "/sitemap-posts.xml.gz",
];

export type MockPageOverride = {
  status?: number;
  html?: string;
  headers?: Readonly<Record<string, string>>;
};

export type MockRequestLog = {
  url: string;
  at: number;
  headers: Record<string, string>;
}[];

type MockPage = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

const HTML_TYPE = "text/html; charset=utf-8";
// Sitemap lastmod değerleri sabit: aynı istek hep aynı baytları döner.
const LASTMOD = "2026-09-28";

// --- sayfa içerikleri ---------------------------------------------------------

function htmlPage(input: {
  host: string;
  path: string;
  title: string;
  description: string;
  h1: string;
  body: string;
  head?: string;
}): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${input.title}</title>`,
    `<meta name="description" content="${input.description}">`,
    `<link rel="canonical" href="https://${input.host}${input.path}">`,
    input.head ?? "",
    "</head>",
    "<body>",
    `<h1>${input.h1}</h1>`,
    input.body,
    "</body>",
    "</html>",
  ].join("\n");
}

const WORDS = [
  "growth",
  "brand",
  "audience",
  "content",
  "social",
  "campaign",
  "search",
  "visitors",
  "measure",
  "weekly",
  "story",
  "launch",
  "design",
  "product",
  "customer",
  "market",
  "journey",
  "simple",
  "clear",
  "results",
  "local",
  "season",
  "planning",
  "creative",
  "signal",
  "trust",
  "review",
  "update",
  "team",
  "studio",
  "coffee",
  "travel",
  "garden",
  "kitchen",
  "workshop",
  "morning",
  "evening",
  "summer",
  "winter",
  "river",
  "city",
  "village",
];

// Belirlenimci metin: aynı tohum aynı kelimeleri, farklı tohum farklı
// dizilimi üretir (blog yazıları birbirinin kopyası sayılmasın).
function words(seed: number, count: number): string {
  const out: string[] = [];
  let state = (seed * 2_654_435_761) >>> 0 || 1;
  for (let index = 0; index < count; index += 1) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    out.push(WORDS[(state >>> 8) % WORDS.length]!);
  }
  return out.join(" ");
}

function paragraphs(seed: number, total: number): string {
  const parts: string[] = [];
  for (let index = 0; index * 50 < total; index += 1) {
    parts.push(
      `<p>${words(seed * 31 + index, Math.min(50, total - index * 50))}</p>`,
    );
  }
  return parts.join("\n");
}

function link(href: string, text: string): string {
  return `<a href="${href}">${text}</a>`;
}

function homeHtml(host: string): string {
  const links = [
    link("/pricing", "Pricing"),
    link("/about", "About us"),
    link("/blog/", "Blog"),
    link("/dup-a", "Offer A"),
    link("/dup-b", "Offer B"),
    link("/noindex-page", "Hidden page"),
    link("/missing", "Old campaign"),
    link("/old-page", "Old page"),
    link("/chain-1", "Plans"),
    link("/mixed", "Gallery"),
    link("/schema-broken", "Events"),
    link("/hreflang-en", "English"),
    link("/private/secret", "Members"),
  ];
  // Alan adı www'siz ise www eşine de bir bağlantı (ikiz alan adı bağlantısı).
  if (!host.startsWith("www.")) {
    links.push(link(`https://www.${host}/about`, "About (www)"));
  }
  return htmlPage({
    host,
    path: "/",
    title: "Mock Studio – Social media for small brands",
    description: "A deterministic mock site used by the Agentelse site audit.",
    h1: "Mock Studio",
    head: `<meta name="agentelse-site-verification" content="${MOCK_VERIFICATION_TOKEN}">`,
    body: `<nav>${links.join(" ")}</nav>\n${paragraphs(1, 220)}`,
  });
}

function simplePage(
  host: string,
  path: string,
  title: string,
  seed: number,
  extra: { head?: string; body?: string } = {},
): string {
  return htmlPage({
    host,
    path,
    title,
    description: `${title} at Mock Studio, a deterministic test site.`,
    h1: title,
    head: extra.head,
    body: `${link("/", "Home")}\n${paragraphs(seed, 240)}${extra.body ?? ""}`,
  });
}

function blogIndexHtml(host: string): string {
  const items = BLOG_POSTS.map(
    (path, index) => `<li>${link(path, `Blog post ${index + 1}`)}</li>`,
  ).join("\n");
  return htmlPage({
    host,
    path: "/blog/",
    title: "Mock Studio blog – Notes and stories",
    description: "Every post on the Mock Studio blog.",
    h1: "Blog",
    body: `${link("/", "Home")}\n<ul>\n${items}\n</ul>\n${paragraphs(9, 200)}`,
  });
}

function blogPostHtml(host: string, index: number): string {
  return htmlPage({
    host,
    path: `/blog/post-${index}`,
    title: `Blog post ${index} – Mock Studio notes`,
    description: `Post number ${index} on the Mock Studio blog.`,
    h1: `Blog post ${index}`,
    body: `${link("/blog/", "Blog")}\n${paragraphs(100 + index, 300)}`,
  });
}

function duplicateHtml(host: string, path: string): string {
  // /dup-a ve /dup-b'nin görünen gövdesi ve başlığı birebir aynı; yalnız
  // kanonik kendi adresini gösterir.
  return htmlPage({
    host,
    path,
    title: "Special offer – Mock Studio",
    description: "The same special offer, published twice.",
    h1: "Special offer",
    body: `${link("/", "Home")}\n${paragraphs(77, 240)}`,
  });
}

function robotsTxt(host: string): string {
  return `User-agent: *\nDisallow: /private/\nSitemap: https://${host}/sitemap.xml\n`;
}

function urlset(host: string, paths: readonly string[]): string {
  const entries = paths
    .map(
      (path) =>
        `<url><loc>https://${host}${path}</loc><lastmod>${LASTMOD}</lastmod></url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function sitemapIndex(host: string): string {
  const entries = ["/sitemap-pages.xml", "/sitemap-posts.xml.gz"]
    .map(
      (path) =>
        `<sitemap><loc>https://${host}${path}</loc><lastmod>${LASTMOD}</lastmod></sitemap>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;
}

const SITEMAP_PAGES = [
  "/",
  "/pricing",
  "/about",
  "/blog/",
  "/dup-a",
  "/dup-b",
  "/noindex-page",
  "/old-page",
  "/mixed",
  "/schema-broken",
  "/hreflang-en",
];

function html(status: number, text: string): MockPage {
  return {
    status,
    headers: { "content-type": HTML_TYPE },
    body: Buffer.from(text, "utf8"),
  };
}

function redirect(status: number, location: string): MockPage {
  return { status, headers: { location }, body: Buffer.alloc(0) };
}

function notFound(host: string, path: string): MockPage {
  return html(
    404,
    htmlPage({
      host,
      path,
      title: "Page not found",
      description: "This page does not exist.",
      h1: "Not found",
      body: link("/", "Home"),
    }),
  );
}

// Yolun temel sayfası (override'lardan önce).
function basePage(host: string, path: string): MockPage {
  const post = /^\/blog\/post-(\d+)$/.exec(path);
  if (post) {
    const index = Number(post[1]);
    return index >= 1 && index <= BLOG_POST_COUNT
      ? html(200, blogPostHtml(host, index))
      : notFound(host, path);
  }
  switch (path) {
    case "/":
      return html(200, homeHtml(host));
    case "/pricing":
      return html(
        200,
        simplePage(host, path, "Pricing – Mock Studio plans", 2),
      );
    case "/about":
      return html(
        200,
        simplePage(host, path, "About Mock Studio – Our small team", 3),
      );
    case "/blog/":
      return html(200, blogIndexHtml(host));
    case "/dup-a":
    case "/dup-b":
      return html(200, duplicateHtml(host, path));
    case "/noindex-page":
      return html(
        200,
        simplePage(host, path, "Hidden page – Mock Studio archive", 4, {
          head: '<meta name="robots" content="noindex">',
        }),
      );
    case "/missing":
      return notFound(host, path);
    case "/old-page":
      return redirect(301, "/");
    case "/chain-1":
      return redirect(301, "/chain-2");
    case "/chain-2":
      return redirect(302, "/chain-3");
    case "/chain-3":
      return redirect(301, "/pricing");
    case "/private/secret":
      return html(200, simplePage(host, path, "Members area – Mock Studio", 5));
    case "/mixed":
      return html(
        200,
        simplePage(host, path, "Gallery – Mock Studio work samples", 6, {
          body: `\n<img src="http://${host}/images/gallery.jpg" alt="Gallery">`,
        }),
      );
    case "/schema-broken":
      return html(
        200,
        simplePage(host, path, "Events – Mock Studio workshops", 7, {
          head: '<script type="application/ld+json">{"@context": "https://schema.org", "@type": "Event", "name": </script>',
        }),
      );
    case "/hreflang-en":
      return html(
        200,
        simplePage(host, path, "English edition – Mock Studio", 8, {
          head: [
            `<link rel="alternate" hreflang="en" href="https://${host}/hreflang-en">`,
            `<link rel="alternate" hreflang="tr" href="https://${host}/hreflang-tr">`,
          ].join("\n"),
        }),
      );
    case "/robots.txt":
      return {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: Buffer.from(robotsTxt(host), "utf8"),
      };
    case "/sitemap.xml":
      return {
        status: 200,
        headers: { "content-type": "application/xml; charset=utf-8" },
        body: Buffer.from(sitemapIndex(host), "utf8"),
      };
    case "/sitemap-pages.xml":
      return {
        status: 200,
        headers: { "content-type": "application/xml; charset=utf-8" },
        body: Buffer.from(urlset(host, SITEMAP_PAGES), "utf8"),
      };
    case "/sitemap-posts.xml.gz":
      // Gerçek gzip baytları; Content-Encoding değil, dosyanın kendisi.
      // gzip başlığının zaman alanı sıfır olduğundan baytlar belirlenimcidir.
      return {
        status: 200,
        headers: { "content-type": "application/gzip" },
        body: gzipSync(Buffer.from(urlset(host, BLOG_POSTS), "utf8")),
      };
    default:
      return notFound(host, path);
  }
}

function applyOverride(base: MockPage, override: MockPageOverride): MockPage {
  const status = override.status ?? base.status;
  const headers = { ...base.headers };
  // Yönlendirme olmayan duruma çevrilen sayfada eski Location kalmasın.
  if (status < 300 || status >= 400) delete headers.location;
  if (override.html !== undefined && !headers["content-type"]) {
    headers["content-type"] = HTML_TYPE;
  }
  for (const [name, value] of Object.entries(override.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  const body =
    override.html !== undefined
      ? Buffer.from(override.html, "utf8")
      : base.body;
  return { status, headers, body };
}

// FNV-1a 32 bit; ETag yalnız gövdeye bağlıdır (aynı gövde = aynı ETag).
function fnv1a32Hex(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function mockEtag(body: Uint8Array): string {
  return `"${fnv1a32Hex(body)}"`;
}

// --- taşıyıcı -----------------------------------------------------------------

let moduleOverrides: Readonly<Record<string, MockPageOverride>> | null = null;

// Mock kipindeki siteTransport() bunu okur (tatbikat: ana sayfaya noindex,
// robots.txt'e 'Disallow: /' ya da 500).
export function setMockSiteOverrides(
  overrides: Readonly<Record<string, MockPageOverride>> | null,
): void {
  moduleOverrides = overrides;
}

export function currentMockSiteOverrides(): Readonly<
  Record<string, MockPageOverride>
> | null {
  return moduleOverrides;
}

function lookupOverride(
  overrides: Readonly<Record<string, MockPageOverride>> | undefined,
  url: URL,
): MockPageOverride | null {
  if (!overrides) return null;
  return (
    overrides[`${url.pathname}${url.search}`] ?? overrides[url.pathname] ?? null
  );
}

export function mockSiteTransport(
  options: {
    overrides?: Readonly<Record<string, MockPageOverride>>;
    log?: MockRequestLog;
    now?: () => number;
  } = {},
): GuardedTransport {
  const now = options.now ?? Date.now;
  return async (url, request) => {
    const headers = buildRequestHeaders(request);
    options.log?.push({ url: url.toString(), at: now(), headers });

    const host = url.hostname.toLowerCase();
    const override = lookupOverride(options.overrides, url);
    let page: MockPage;
    if (url.protocol === "http:") {
      // Gerçek siteler gibi http → https (override'lar yalnız https'e uygulanır).
      page = redirect(301, `https://${url.host}${url.pathname}${url.search}`);
    } else {
      const base = basePage(host, url.pathname);
      page = override ? applyOverride(base, override) : base;
    }

    const empty = (bodySkipped: boolean): GuardedResponse => ({
      status: page.status,
      headers: page.headers,
      body: Buffer.alloc(0),
      truncated: false,
      bodySkipped,
      elapsedMs: 0,
      firstByteMs: 0,
    });

    if (page.status >= 300 && page.status < 400) return empty(false);

    if (page.status === 200) {
      const etag = page.headers.etag ?? mockEtag(page.body);
      page = { ...page, headers: { ...page.headers, etag } };
      if (headers["if-none-match"] === etag) {
        page = { status: 304, headers: { etag }, body: Buffer.alloc(0) };
        return empty(false);
      }
    }

    const contentType = page.headers["content-type"] ?? null;
    if (!isBodyAllowed(contentType, request.bodyContentTypes))
      return empty(true);

    const truncated = page.body.length > request.maxBytes;
    return {
      status: page.status,
      headers: page.headers,
      body: truncated ? page.body.subarray(0, request.maxBytes) : page.body,
      truncated,
      bodySkipped: false,
      elapsedMs: 0,
      firstByteMs: 0,
    };
  };
}

import "server-only";

import type { Prisma, SeoSite } from "@prisma/client";

import {
  CRAWL_MIN_INTERVAL_MS,
  ROBOTS_BACKOFF_BASE_MS,
  ROBOTS_BACKOFF_MAX_MS,
  ROBOTS_MAX_BYTES,
  ROBOTS_RETRY_DELAY_MS,
  SEO_CRAWLER_TOKEN,
} from "@/lib/seo/audit-constants";
import {
  hostTwin,
  inScope,
  scopeFromVerifiedDomain,
  type CrawlScope,
} from "@/lib/seo/crawl-url";
import {
  groupFor,
  isAllowed,
  parseRobotsTxt,
  robotsTextHash,
  robotsVerdictForStatus,
  type ParsedRobots,
  type RobotsFetchVerdict,
} from "@/lib/seo/robots-parser";
import { prisma } from "@/lib/prisma";

import { siteFetch, type SiteFetchDeps, type SiteFetchResult } from "./fetcher";

// robots.txt izleme ve tarayıcının robots kapısı (docs/search-health.md
// "Tarayıcı", "Sitemap ve robots"). Google anlamı: 4xx = dosya yok (her şey
// serbest), 429/5xx/ağ hatası = o koşuda tarama durur. Hata 10 sn sonra aynı
// koşuda bir kez yeniden denenir; robotsFailures YALNIZ ikinci deneme de
// başarısızsa artar (tek bir 5xx yanlış CRITICAL üretmez). Yeniden denemeye
// süre kalmadıysa hiçbir şey kaydedilmez, robotsRetryAt = now + 2 dk.

// Bir site koşusunun ortak bağlamı (crawler.ts kurar).
export type SiteRunContext = {
  site: SeoSite;
  scope: CrawlScope;
  projectId: string;
  workspaceId: string;
  domain: string | null;
  linkId: string | null;
  timezone: string;
  now: Date;
  remaining: () => number;
  sleep: (ms: number) => Promise<void>;
  deps: SiteFetchDeps;
  // "https://www.example.com": ana sayfanın son adresinin kökü
  origin: string;
  originHost: string;
  // Köken alan adının robots'u (null: dosya yok ya da okunmadı = serbest)
  robots: ParsedRobots | null;
  // www/apex eşinin robots'u, koşu başına bir kez okunur ("deny": okunamadı)
  twinRobots: Map<string, ParsedRobots | null | "deny">;
  // Her yazım öncesi SeoSite.scopeKey yeniden okunur; değiştiyse koşu durur.
  guard: () => Promise<void>;
};

const RETRY_NEEDS_MS = 15_000;
const NO_RETRY_WAIT_MS = 2 * 60_000;
const HTTP_CHECK_EVERY_MS = 86_400_000;
const HTTP_CHECK_MAX_BYTES = 64_000;
const FAILING: ReadonlySet<RobotsFetchVerdict> = new Set([
  "SERVER_ERROR",
  "UNREACHABLE",
]);

// SC-F6 doğrulayıcısı da aynı kapıyı hafif bir bağlamla kullanır.
export type RobotsGateContext = Pick<
  SiteRunContext,
  "scope" | "deps" | "originHost" | "robots" | "twinRobots"
>;

// robots.txt, sitemap dosyaları ve http denetimi alan adının kökündedir; URL
// önekli mülkte ("/blog/") önek dışında kalırlar. Bu getirmeler alan adı
// (ve www eşi) kapsamıyla yapılır; sayfa kapsamı değişmez.
export function hostScope(
  ctx: Pick<SiteRunContext, "scope">,
  host: string,
): CrawlScope {
  if (ctx.scope.kind !== "GSC_PREFIX") return ctx.scope;
  return scopeFromVerifiedDomain(host.replace(/^www\./, "")) ?? ctx.scope;
}

export function isFailingVerdict(verdict: string | null): boolean {
  return verdict === "SERVER_ERROR" || verdict === "UNREACHABLE";
}

function verdictOf(result: SiteFetchResult): RobotsFetchVerdict {
  if (result.errorKind || result.status === null) return "UNREACHABLE";
  return robotsVerdictForStatus(result.status);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Saklı robots gövdesinden koşunun kuralları (OK değilse serbest).
export function storedRobots(site: SeoSite): ParsedRobots | null {
  if (site.robotsVerdict !== "OK" || !site.robotsBody) return null;
  return parseRobotsTxt(site.robotsBody);
}

// Crawl-delay (≤ 10 sn); pacer en az 1 sn uygular.
export function crawlIntervalMs(ctx: SiteRunContext): number {
  const group = ctx.robots ? groupFor(ctx.robots, SEO_CRAWLER_TOKEN) : null;
  return Math.max(CRAWL_MIN_INTERVAL_MS, group?.crawlDelayMs ?? 0);
}

async function fetchTwinRobots(
  ctx: RobotsGateContext,
  twin: string,
): Promise<ParsedRobots | null | "deny"> {
  const result = await siteFetch(
    `https://${twin}/robots.txt`,
    {
      scope: hostScope(ctx, twin),
      originHost: twin,
      accept: "any",
      maxBytes: ROBOTS_MAX_BYTES,
    },
    ctx.deps,
  );
  const verdict = verdictOf(result);
  if (verdict === "MISSING") return null;
  if (verdict !== "OK" || !result.body) return "deny";
  return parseRobotsTxt(result.body.toString("utf8"));
}

// Her adımda sorulan robots kapısı: köken alan adı kendi saklı robots'una,
// eş alan adı (yalnız yönlendirme adımı) kendi robots.txt'sine bakar; bizim
// belirtecimizin grubu, yoksa "*". Başka alan adı hiç getirilmez.
export function robotsGate(
  ctx: RobotsGateContext,
): (url: string) => Promise<boolean> {
  return async (url: string) => {
    const host = hostOf(url);
    if (!host) return false;
    if (host === ctx.originHost) {
      return isAllowed(ctx.robots, SEO_CRAWLER_TOKEN, url).allowed;
    }
    if (host !== hostTwin(ctx.originHost)) return false;
    let twin = ctx.twinRobots.get(host);
    if (twin === undefined) {
      twin = await fetchTwinRobots(ctx, host);
      ctx.twinRobots.set(host, twin);
    }
    if (twin === "deny") return false;
    return isAllowed(twin, SEO_CRAWLER_TOKEN, url).allowed;
  };
}

export type RobotsRunResult = {
  // Bu koşuda robots başarısız: sitemap, bekçi ve tam tarama atlanır.
  failing: boolean;
  changed: boolean;
};

function backoffMs(failures: number): number {
  return Math.min(
    ROBOTS_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
    ROBOTS_BACKOFF_MAX_MS,
  );
}

async function fetchRobots(ctx: SiteRunContext): Promise<SiteFetchResult> {
  return siteFetch(
    `${ctx.origin}/robots.txt`,
    {
      scope: hostScope(ctx, ctx.originHost),
      originHost: ctx.originHost,
      accept: "any",
      maxBytes: ROBOTS_MAX_BYTES,
    },
    ctx.deps,
  );
}

// Günde bir kez: http://<köken>/ https'e yönleniyor mu (SH16).
async function checkHttpRedirect(
  ctx: SiteRunContext,
): Promise<Prisma.SeoSiteUpdateInput> {
  const last = ctx.site.httpCheckedAt?.getTime() ?? 0;
  if (ctx.now.getTime() - last < HTTP_CHECK_EVERY_MS) return {};
  const url = `http://${ctx.originHost}/`;
  const scope = hostScope(ctx, ctx.originHost);
  if (!inScope(url, scope)) return {};
  const result = await siteFetch(
    url,
    {
      scope,
      originHost: ctx.originHost,
      accept: "any",
      maxBytes: HTTP_CHECK_MAX_BYTES,
      isAllowed: robotsGate(ctx),
    },
    ctx.deps,
  );
  const first = result.hops[0];
  if (!first) return {};
  const second = result.hops[1];
  const redirects =
    first.status >= 300 &&
    first.status < 400 &&
    (second?.url ?? result.finalUrl).startsWith("https://");
  return { httpRedirectsToHttps: redirects, httpCheckedAt: ctx.now };
}

// robots.txt'yi getirir ve SeoSite'a yazar; ctx.robots'u günceller.
export async function refreshRobots(
  ctx: SiteRunContext,
): Promise<RobotsRunResult> {
  let result = await fetchRobots(ctx);
  let verdict = verdictOf(result);
  if (FAILING.has(verdict)) {
    if (ctx.remaining() < RETRY_NEEDS_MS) {
      await ctx.guard();
      await prisma.seoSite.update({
        where: { id: ctx.site.id },
        data: { robotsRetryAt: new Date(ctx.now.getTime() + NO_RETRY_WAIT_MS) },
      });
      ctx.site.robotsRetryAt = new Date(ctx.now.getTime() + NO_RETRY_WAIT_MS);
      return { failing: true, changed: false };
    }
    await ctx.sleep(ROBOTS_RETRY_DELAY_MS);
    result = await fetchRobots(ctx);
    verdict = verdictOf(result);
  }

  if (FAILING.has(verdict)) {
    const failures = ctx.site.robotsFailures + 1;
    const retryAt = new Date(ctx.now.getTime() + backoffMs(failures));
    await ctx.guard();
    const updated = await prisma.seoSite.update({
      where: { id: ctx.site.id },
      data: {
        robotsFailures: failures,
        robotsVerdict: verdict,
        robotsStatus: result.status,
        robotsFetchedAt: ctx.now,
        robotsRetryAt: retryAt,
      },
    });
    const changed = ctx.site.robotsVerdict !== verdict;
    ctx.site = { ...ctx.site, ...pickRobots(updated) };
    return { failing: true, changed };
  }

  // Köken henüz bilinmiyorsa robots.txt'nin son adresi (kapsamda, köken ya da
  // eşi) kökeni belirler; ana sayfa getirilince o kesinleştirir.
  const finalHost = hostOf(result.finalUrl);
  if (
    ctx.site.origin === null &&
    finalHost &&
    finalHost !== ctx.originHost &&
    finalHost === hostTwin(ctx.originHost) &&
    inScope(result.finalUrl, hostScope(ctx, finalHost))
  ) {
    ctx.origin = new URL(result.finalUrl).origin;
    ctx.originHost = finalHost;
  }

  const body =
    verdict === "OK" && result.body ? result.body.toString("utf8") : null;
  const hash = robotsTextHash(body ?? "");
  const previousHash = ctx.site.robotsHash;
  const previousVerdict = ctx.site.robotsVerdict;
  const hashChanged = previousHash !== hash;
  ctx.robots = body ? parseRobotsTxt(body) : null;
  ctx.twinRobots.clear();
  const http = await checkHttpRedirect(ctx);
  await ctx.guard();
  const updated = await prisma.seoSite.update({
    where: { id: ctx.site.id },
    data: {
      robotsFailures: 0,
      robotsRetryAt: null,
      robotsStatus: result.status,
      robotsVerdict: verdict,
      robotsBody: body,
      robotsHash: hash,
      robotsFetchedAt: ctx.now,
      ...(hashChanged && previousHash !== null
        ? { robotsPrevBody: ctx.site.robotsBody, robotsChangedAt: ctx.now }
        : {}),
      ...(ctx.site.origin === null ? { origin: ctx.origin } : {}),
      ...http,
    },
  });
  ctx.site = { ...ctx.site, ...pickRobots(updated), origin: updated.origin };
  return {
    failing: false,
    changed: hashChanged || previousVerdict !== verdict,
  };
}

function pickRobots(site: SeoSite): Partial<SeoSite> {
  return {
    robotsFailures: site.robotsFailures,
    robotsVerdict: site.robotsVerdict,
    robotsStatus: site.robotsStatus,
    robotsHash: site.robotsHash,
    robotsBody: site.robotsBody,
    robotsPrevBody: site.robotsPrevBody,
    robotsFetchedAt: site.robotsFetchedAt,
    robotsChangedAt: site.robotsChangedAt,
    robotsRetryAt: site.robotsRetryAt,
    httpRedirectsToHttps: site.httpRedirectsToHttps,
    httpCheckedAt: site.httpCheckedAt,
  };
}

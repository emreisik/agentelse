import "server-only";

import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";

import { isValidDomain, normalizeDomain } from "@/lib/domain";
import { SEO_VERIFY_TXT_PREFIX } from "@/lib/seo/audit-constants";
import { scopeFromVerifiedDomain } from "@/lib/seo/crawl-url";
import { seoMockMode, seoWorkAllowedFor } from "@/lib/seo/health-flags";
import { extractPageFacts } from "@/lib/seo/html-audit";
import { prisma } from "@/lib/prisma";
import type { GuardedTransport } from "@/server/security/guarded-transport";
import { siteFetch } from "@/server/seo/crawl/fetcher";
import { sharedHostPacer } from "@/server/seo/crawl/pacer";

import { SeoSites } from "./sites";

// Agentelse alan adı doğrulaması (GSC'siz projeler; docs/search-health.md
// "Kapsam ve doğrulama"): https://<alan adı>/ üzerindeki
// <meta name="agentelse-site-verification" content=TOKEN> ya da
// agentelse-site-verification=TOKEN DNS TXT kaydı. Mock kipte ağa çıkmadan
// MOCK olarak doğrulanır. Başarı kapsamı (ensureForProject) yeniden kurar.

export type VerificationDeps = {
  resolveTxt?: (host: string) => Promise<string[][]>;
  transport?: GuardedTransport;
};

export type VerificationResult =
  | { ok: true; method: "META" | "DNS" | "MOCK" }
  | {
      ok: false;
      reason: "no_domain" | "not_found" | "unreachable" | "unavailable";
    };

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const TOKEN_LENGTH = 24;

function randomToken(): string {
  const bytes = randomBytes(TOKEN_LENGTH);
  let token = "";
  for (const byte of bytes) token += BASE32[byte % 32];
  return token;
}

function projectDomain(value: string | null): string | null {
  if (!value?.trim()) return null;
  const domain = normalizeDomain(value);
  return domain && isValidDomain(domain) ? domain : null;
}

// Panelin doğrulama kartı için belirteç; bir kez üretilir. İzin listesi
// dışındaki projede hiçbir şey yazılmaz.
export async function ensureVerifyToken(
  projectId: string,
): Promise<{ token: string; domain: string | null } | null> {
  if (!seoWorkAllowedFor(projectId)) return null;
  const site = await SeoSites.ensureForProject(projectId, new Date(), {
    reset: false,
  });
  if (!site) return null;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { domain: true },
  });
  const domain = projectDomain(project?.domain ?? null);
  if (site.verifyToken) return { token: site.verifyToken, domain };
  await prisma.seoSite.updateMany({
    where: { id: site.id, verifyToken: null },
    data: { verifyToken: randomToken() },
  });
  const fresh = await prisma.seoSite.findUnique({
    where: { id: site.id },
    select: { verifyToken: true },
  });
  return fresh?.verifyToken ? { token: fresh.verifyToken, domain } : null;
}

async function dnsMatches(
  domain: string,
  token: string,
  resolveTxt: (host: string) => Promise<string[][]>,
): Promise<boolean> {
  try {
    const records = await resolveTxt(domain);
    const wanted = `${SEO_VERIFY_TXT_PREFIX}${token}`;
    // Uzun TXT kayıtları parçalı döner; parçalar birleştirilip karşılaştırılır.
    return records.some((chunks) => chunks.join("").trim() === wanted);
  } catch {
    return false;
  }
}

async function metaMatches(
  domain: string,
  token: string,
  transport: GuardedTransport | undefined,
): Promise<"match" | "absent" | "unreachable"> {
  const scope = scopeFromVerifiedDomain(domain);
  if (!scope) return "absent";
  const result = await siteFetch(
    `https://${domain}/`,
    { scope, originHost: null, accept: "html" },
    transport ? { transport, pacer: sharedHostPacer } : undefined,
  );
  if (result.errorKind || result.status === null) return "unreachable";
  if (result.status < 200 || result.status >= 300 || !result.body) {
    return "absent";
  }
  const facts = extractPageFacts(
    result.body.toString("utf8"),
    result.finalUrl,
    {
      truncated: result.truncated,
    },
  );
  return facts.verificationTokens.includes(token) ? "match" : "absent";
}

export async function checkSiteVerification(
  projectId: string,
  deps: VerificationDeps = {},
  now: Date = new Date(),
): Promise<VerificationResult> {
  if (!seoWorkAllowedFor(projectId))
    return { ok: false, reason: "unavailable" };
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { domain: true },
  });
  if (!project) return { ok: false, reason: "unavailable" };
  const domain = projectDomain(project.domain);
  if (!domain) return { ok: false, reason: "no_domain" };
  const site = await SeoSites.ensureForProject(projectId, now, {
    reset: false,
  });
  if (!site) return { ok: false, reason: "unavailable" };

  let method: "META" | "DNS" | "MOCK" | null = null;
  let unreachable = false;
  if (seoMockMode()) {
    method = "MOCK";
  } else if (site.verifyToken) {
    const resolveTxt =
      deps.resolveTxt ?? ((host: string) => dns.resolveTxt(host));
    if (await dnsMatches(domain, site.verifyToken, resolveTxt)) {
      method = "DNS";
    } else {
      const meta = await metaMatches(domain, site.verifyToken, deps.transport);
      if (meta === "match") method = "META";
      unreachable = meta === "unreachable";
    }
  }

  if (method) {
    await prisma.seoSite.update({
      where: { id: site.id },
      data: {
        verifiedDomain: domain,
        verifyMethod: method,
        verifiedAt: now,
        verifyFailures: 0,
        verifyCheckedAt: now,
      },
    });
    // Kapsam şimdi doğrulanmış alan adından kurulur (tarama yeniden kurulur).
    await SeoSites.ensureForProject(projectId, now);
    return { ok: true, method };
  }
  await prisma.seoSite.update({
    where: { id: site.id },
    data: { verifyFailures: { increment: 1 }, verifyCheckedAt: now },
  });
  return { ok: false, reason: unreachable ? "unreachable" : "not_found" };
}

import "server-only";

import { appUrl } from "@/lib/app-url";
import { isExpired, type SeoIdeaConcept } from "@/lib/ideas/concept";
import { normalizeSeoIdeas } from "@/lib/ideas/normalize";
import { IDEA_POOL_STATUSES } from "@/lib/idea-pool";
import { prisma } from "@/lib/prisma";
import { foldForMatch, tokenizeFolded } from "@/lib/text-fold";
import { dayKeyInTimezone } from "@/lib/timezone";
import { gaInsightsModeFor } from "@/lib/website-analytics/analysis/flags";
import { parseGaFindingEvidence } from "@/lib/website-analytics/analysis/stored";
import { safeTimezone } from "@/lib/website-analytics/days";
import { blocksOf, checkText } from "@/lib/works/brand-rules";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import {
  maskGooglePath,
  maskGoogleText,
} from "@/server/integrations/google/pii";
import {
  poolCapacity,
  saveIdeaConcepts,
  type GenerateIdeasResult,
} from "@/server/ideas/idea-engine";
import { readIdeaRows, type IdeaRow } from "@/server/ideas/idea-context";
import { ideaWebsiteDef } from "@/server/reasoning/prompts/idea-website";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AgentelseError } from "@/server/security/errors";
import { primaryGaLink } from "@/server/website-analytics/store";
import { loadBrandRules } from "@/server/works/brand-rule-loader";
import { isModulesEnabled } from "@/server/works/flag";

// "From your website" makale fikirleri (GA-F4, docs/ideas.md): canlı ve gerçek
// GA bulgularından (AN8 site içi arama, AN3 "promote" iyi dönüşen sayfa, AN10
// en çok okunan sayfalar) haftada en çok bir hafif model çağrısı. Havuzda en
// çok 3 website fikri bekler; isteme en çok 11 maskelenmiş dize girer. Mock
// GA verisi hiç fikir üretmez. Fikirlerin kanıt başlıkları rakamsızdır ve
// uygulama içi bulguya bağlanır. idea-modules.ts bu dosyayı içe aktarır: tersi
// döngü olur, o yüzden marka kuralı süzgeci burada yerel kopyadır.

export const WEBSITE_IDEAS_TARGET = 3;

const INTERVAL_MS = 7 * 24 * 3_600_000;
const RETRY_MS = 6 * 3_600_000;
const FINDINGS_LOOKBACK_MS = 14 * 24 * 3_600_000;
const MAX_TERMS = 5;
const MAX_CONVERTING = 3;
const MAX_ENGAGING = 3;
const STRING_MAX = 120;

const POOL = new Set<string>(IDEA_POOL_STATUSES);

type FindingSource = "search" | "converting" | "engaging";

type EvidenceItem = { text: string; findingId: string };

type WebsiteEvidence = {
  terms: (EvidenceItem & { searches: number })[];
  converting: EvidenceItem[];
  engaging: EvidenceItem[];
};

const WHY: Record<FindingSource, string> = {
  search: "Visitors search your site for this.",
  converting: "This topic already brings you leads.",
  engaging: "Readers spend the most time on this topic.",
};

const EVIDENCE_TITLE: Record<FindingSource, string> = {
  search: "From your website: site search",
  converting: "From your website: a page that converts well",
  engaging: "From your website: your most read pages",
};

function empty(): GenerateIdeasResult {
  return { ok: false, reason: "EMPTY" };
}

async function scopeOf(projectId: string) {
  const [project, brand] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    }),
    prisma.brand.findFirst({
      where: { projectId, isDefault: true },
      select: { id: true },
    }),
  ]);
  return project && brand
    ? { workspaceId: project.workspaceId, projectId, brandId: brand.id }
    : null;
}

// Son çağrı başarılıysa haftada bir, başarısızsa 6 saatte bir.
async function dueNow(projectId: string, now: Date): Promise<boolean> {
  const last = await prisma.reasoningCall.findFirst({
    where: { projectId, purpose: ideaWebsiteDef.purpose },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, status: true },
  });
  if (!last) return true;
  const wait = last.status === "OK" ? INTERVAL_MS : RETRY_MS;
  return now.getTime() - last.createdAt.getTime() >= wait;
}

function cleanString(value: string, kind: "path" | "text"): string | null {
  const masked = (
    kind === "path" ? maskGooglePath(value) : maskGoogleText(value)
  )
    .trim()
    .slice(0, STRING_MAX);
  return masked.length > 0 ? masked : null;
}

// Bulgulardan en çok 5 terim, 3 dönüşen ve 3 okunan yol (zaten maskeli
// saklanır; yine de maskelenip kırpılır). Tekrarlar atılır.
function evidenceOf(
  findings: readonly { id: string; evidence: unknown }[],
): WebsiteEvidence {
  const out: WebsiteEvidence = { terms: [], converting: [], engaging: [] };
  const seen = new Set<string>();
  const fresh = (text: string | null): text is string => {
    if (!text) return false;
    const key = foldForMatch(text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  for (const finding of findings) {
    const evidence = parseGaFindingEvidence(finding.evidence);
    if (!evidence) continue;
    if (evidence.rule === "AN8") {
      for (const item of evidence.terms) {
        if (out.terms.length >= MAX_TERMS) break;
        const text = cleanString(item.term, "text");
        if (fresh(text)) {
          out.terms.push({
            text,
            findingId: finding.id,
            searches: item.searches,
          });
        }
      }
    } else if (evidence.rule === "AN3" && evidence.variant === "promote") {
      if (out.converting.length >= MAX_CONVERTING) continue;
      const text = cleanString(evidence.page, "path");
      if (fresh(text)) out.converting.push({ text, findingId: finding.id });
    } else if (evidence.rule === "AN10") {
      for (const page of evidence.pages) {
        if (out.engaging.length >= MAX_ENGAGING) break;
        const text = cleanString(page.path, "path");
        if (fresh(text)) out.engaging.push({ text, findingId: finding.id });
      }
    }
  }
  return out;
}

function sharesWord(keyword: string, path: string): boolean {
  const words = new Set(tokenizeFolded(keyword).filter((w) => w.length > 2));
  return tokenizeFolded(path).some((token) => words.has(token));
}

// Fikrin dayandığı bulgu: arama terimiyle katlanmış eşleşme, yoksa yolda
// ortak sözcük; hiçbiri yoksa sırasıyla dönüşen, okunan sayfa, arama.
function attributionOf(
  keyword: string,
  evidence: WebsiteEvidence,
): { source: FindingSource; findingId: string } | null {
  const folded = foldForMatch(keyword).trim();
  const term = evidence.terms.find((item) => {
    const other = foldForMatch(item.text).trim();
    return other === folded || folded.includes(other) || other.includes(folded);
  });
  if (term) return { source: "search", findingId: term.findingId };
  const converting = evidence.converting.find((item) =>
    sharesWord(keyword, item.text),
  );
  if (converting)
    return { source: "converting", findingId: converting.findingId };
  const engaging = evidence.engaging.find((item) =>
    sharesWord(keyword, item.text),
  );
  if (engaging) return { source: "engaging", findingId: engaging.findingId };
  if (evidence.converting[0]) {
    return {
      source: "converting",
      findingId: evidence.converting[0].findingId,
    };
  }
  if (evidence.engaging[0]) {
    return { source: "engaging", findingId: evidence.engaging[0].findingId };
  }
  if (evidence.terms[0]) {
    return { source: "search", findingId: evidence.terms[0].findingId };
  }
  return null;
}

// generateSeoIdeas'taki marka kuralı süzgecinin yerel kopyası.
async function passBrandRules(
  scope: { projectId: string; brandId: string },
  concepts: readonly SeoIdeaConcept[],
): Promise<SeoIdeaConcept[]> {
  const language = await brandRuleLanguageOf(scope.projectId);
  const rules = await loadBrandRules({ ...scope, language });
  return concepts.filter(
    (concept) =>
      blocksOf(
        checkText(
          `${concept.draft.title}\n${concept.draft.description}`,
          rules,
        ),
      ).length === 0,
  );
}

export async function refreshWebsiteIdeas(input: {
  projectId: string;
  now?: Date;
  rows?: readonly IdeaRow[];
}): Promise<GenerateIdeasResult> {
  const now = input.now ?? new Date();
  const { projectId } = input;
  // Kapılar her sorgudan önce.
  if (gaInsightsModeFor(projectId) !== "on" || !isModulesEnabled()) {
    return empty();
  }
  if (!(await dueNow(projectId, now))) return empty();
  const link = await primaryGaLink(projectId);
  if (!link || link.isMock) return empty();

  const findings = await prisma.gaFinding.findMany({
    where: {
      linkId: link.id,
      mode: "live",
      isMock: false,
      status: { in: ["OPEN", "ACCEPTED"] },
      ruleKey: { in: ["AN8", "AN3", "AN10"] },
      createdAt: { gte: new Date(now.getTime() - FINDINGS_LOOKBACK_MS) },
      ideaIds: { isEmpty: true },
    },
    orderBy: { priority: "desc" },
    select: { id: true, evidence: true },
  });
  const evidence = evidenceOf(findings);
  if (
    evidence.terms.length +
      evidence.converting.length +
      evidence.engaging.length ===
    0
  ) {
    return empty();
  }

  const rows = input.rows ?? (await readIdeaRows(projectId));
  const waiting = rows.filter(
    (row) =>
      POOL.has(row.status) &&
      row.concept?.source === "website" &&
      !isExpired(row.concept, now),
  ).length;
  const room = WEBSITE_IDEAS_TARGET - waiting;
  if (room <= 0) return empty();

  const scope = await scopeOf(projectId);
  if (!scope) return { ok: false, reason: "NO_BRAND" };
  // Önce yer: dolu havuz için model çağrısı yapılmaz.
  const capacity = await poolCapacity({
    scope,
    rows,
    isMock: ReasoningService.isMockMode(),
    now,
    wanted: room,
  });
  const fits = Math.min(room, capacity.free + capacity.retire.length);
  if (fits <= 0) return { ok: false, reason: "FULL" };

  const [brand, articles] = await Promise.all([
    ConstitutionService.getBrandContext(scope.brandId),
    prisma.post.findMany({
      where: { projectId, deliveries: { some: { channel: "seo" } } },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { topic: true },
    }),
  ]);
  const pool = rows.flatMap((row) =>
    row.concept?.module === "seo" ? [row.concept.draft.keyword] : [],
  );
  const run = await ReasoningService.run(ideaWebsiteDef, {
    ...scope,
    context: {
      count: fits,
      today: dayKeyInTimezone(now, safeTimezone(link.timeZone)),
      brand,
      evidence: {
        searches: evidence.terms.map((item) => [item.text, item.searches]),
        convertingPages: evidence.converting.map((item) => item.text),
        engagingPages: evidence.engaging.map((item) => item.text),
      },
      articles: articles.map((post) => post.topic),
      pool,
    },
  }).catch((error: unknown) => {
    if (error instanceof AgentelseError && error.code === "BUDGET_EXCEEDED") {
      return null;
    }
    throw error;
  });
  if (!run) return { ok: false, reason: "BUDGET" };

  const normalized = await passBrandRules(
    scope,
    normalizeSeoIdeas(run.output.ideas, [
      ...pool,
      ...articles.map((post) => post.topic),
    ]),
  );
  const used: string[] = [];
  const concepts: SeoIdeaConcept[] = [];
  for (const concept of normalized.slice(0, fits)) {
    const attribution = attributionOf(concept.draft.keyword, evidence);
    if (!attribution) continue;
    used.push(attribution.findingId);
    concepts.push({
      ...concept,
      source: "website",
      why: WHY[attribution.source],
      evidence: [
        {
          title: EVIDENCE_TITLE[attribution.source],
          url: appUrl(
            `/projects/${projectId}/site#finding-${attribution.findingId}`,
          ).toString(),
        },
      ],
    });
  }

  const result = await saveIdeaConcepts({
    scope,
    concepts,
    rows,
    isMock: run.isMock,
    now,
  });
  if (result.ok) {
    // created[i] concepts[i]'nin fikridir (saveIdeaConcepts sırayı korur).
    const byFinding = new Map<string, string[]>();
    result.created.forEach((ideaId, index) => {
      const findingId = used[index];
      if (!findingId) return;
      byFinding.set(findingId, [...(byFinding.get(findingId) ?? []), ideaId]);
    });
    for (const [id, ideaIds] of byFinding) {
      await prisma.gaFinding.update({
        where: { id },
        data: { ideaIds: { push: ideaIds } },
      });
    }
  }
  return result;
}

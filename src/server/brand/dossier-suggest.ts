import "server-only";

import { BUSINESS_KINDS } from "@/lib/guided-setup/contract";
import { isValidDomain, normalizeDomain } from "@/lib/domain";
import { safeModelText as safeText } from "@/lib/safe-model-text";
import { countryLabel, languageLabel } from "@/lib/locales";
import { prisma } from "@/lib/prisma";
import {
  type DossierSuggestion,
  dossierSuggestDef,
} from "@/server/reasoning/prompts/dossier-suggest";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

// Fills the Brand Dossier fields that setup leaves empty (services, products,
// markets, visual guidelines, and a label-only summary / missing positioning)
// with ONE suggestion call built only from what the brand already told us: its
// name, website address, the business kind and audiences it picked, tone,
// market and language. No page text and nothing a web page wrote is given to the
// model, and nothing it returns is trusted: every string is cleaned, and only
// fields that are STILL empty at write time are filled, so a value a person
// typed (or an earlier setup wrote) is never replaced. The result is recorded as
// an AI suggestion in the audit log, which is what the Brand Brain note reads.

export const DOSSIER_FIELDS = [
  "summary",
  "positioning",
  "services",
  "products",
  "markets",
  "visualGuidelines",
] as const;
export type DossierField = (typeof DOSSIER_FIELDS)[number];

export const AUDIT = {
  attempted: "brand_dossier.autofill_attempted",
  filled: "brand_dossier.autofilled",
} as const;

// An automatic run (after Approve) stops after this many tries for one brand,
// so a failing call is never paid for again and again. A person's own tap on
// the dossier card is never capped here (the action rate-limits it).
export const AUTO_MAX_ATTEMPTS = 2;

export type DossierFillStatus =
  "FILLED" | "NOTHING_TO_FILL" | "SKIPPED" | "EXHAUSTED" | "FAILED";

export type DossierFillResult = {
  status: DossierFillStatus;
  filled: DossierField[];
};

export type DossierFillScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type DossierFillTrigger = "approve" | "button";

const ITEM_MAX = 70;
const SUMMARY_MAX = 280;
const POSITIONING_MAX = 240;
const LIST_MAX: Record<
  "services" | "products" | "markets" | "visualGuidelines",
  number
> = {
  services: 8,
  products: 8,
  markets: 6,
  visualGuidelines: 6,
};

// The business kinds the sheet offers, as the label it writes into `summary`.
const KIND_LABELS = new Set(
  BUSINESS_KINDS.map((kind) => kind.label.trim().toLowerCase()),
);

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function isKindLabel(value: unknown): boolean {
  return (
    typeof value === "string" && KIND_LABELS.has(value.trim().toLowerCase())
  );
}

type DossierRow = {
  summary: string | null;
  positioning: string | null;
  toneOfVoice: string | null;
  targetAudiences: unknown;
  markets: unknown;
  products: unknown;
  services: unknown;
  visualGuidelines: unknown;
  language: string | null;
  country: string | null;
} | null;

// Which fields a suggestion may still fill right now.
export function emptyFieldsOf(dossier: DossierRow): DossierField[] {
  const out: DossierField[] = [];
  // A summary that is only the business-kind label the sheet wrote ("Agency,
  // consulting or education") is a placeholder, not a description.
  if (isBlank(dossier?.summary) || isKindLabel(dossier?.summary))
    out.push("summary");
  if (isBlank(dossier?.positioning)) out.push("positioning");
  for (const key of [
    "services",
    "products",
    "markets",
    "visualGuidelines",
  ] as const) {
    if (isBlank(dossier?.[key])) out.push(key);
  }
  return out;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

// The facts the model sees: short, cleaned strings only.
function factsOf(
  project: {
    name: string;
    domain: string | null;
    language: string;
    country: string;
  },
  brandName: string,
  dossier: DossierRow,
): Record<string, unknown> {
  const clean = (value: unknown, max: number) => safeText(value, max);
  const summary = dossier?.summary ?? null;
  // The website is a validated bare domain (letters, digits, dots, hyphens):
  // the one place a link-shaped string is fine.
  const website =
    project.domain && isValidDomain(project.domain)
      ? normalizeDomain(project.domain)
      : null;
  return {
    brandName: clean(brandName, 80) ?? "",
    website,
    language: languageLabel(dossier?.language || project.language),
    country: countryLabel(dossier?.country || project.country),
    businessKind: isKindLabel(summary) ? clean(summary, 80) : null,
    summary:
      !isBlank(summary) && !isKindLabel(summary) ? clean(summary, 240) : null,
    positioning: clean(dossier?.positioning ?? "", 200),
    audiences: stringList(dossier?.targetAudiences)
      .map((item) => clean(item, 80))
      .filter((item): item is string => item !== null),
    toneOfVoice: clean(dossier?.toneOfVoice ?? "", 160),
    alreadyKnown: {
      services: stringList(dossier?.services),
      products: stringList(dossier?.products),
      markets: stringList(dossier?.markets),
    },
  };
}

function cleanList(raw: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const text = safeText(item, ITEM_MAX);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

export type DossierWrite = {
  summary?: string;
  positioning?: string;
  services?: string[];
  products?: string[];
  markets?: string[];
  visualGuidelines?: string[];
};

// What would be written: only the fields that are empty AND that the model
// answered with something that survived cleaning.
export function writableFrom(
  suggestion: DossierSuggestion,
  fillable: DossierField[],
): DossierWrite {
  const out: DossierWrite = {};
  for (const field of fillable) {
    if (field === "summary") {
      const text = safeText(suggestion.summary, SUMMARY_MAX);
      if (text) out.summary = text;
    } else if (field === "positioning") {
      const text = safeText(suggestion.positioning, POSITIONING_MAX);
      if (text) out.positioning = text;
    } else {
      const items = cleanList(suggestion[field], LIST_MAX[field]);
      if (items.length > 0) out[field] = items;
    }
  }
  return out;
}

export async function suggestDossierFill(
  scope: DossierFillScope,
  options: { trigger: DossierFillTrigger; userId?: string },
): Promise<DossierFillResult> {
  // A mock answer would put made-up text into a real dossier.
  if (ReasoningService.isMockMode()) return { status: "SKIPPED", filled: [] };

  const [project, brand, dossier] = await Promise.all([
    prisma.project.findUnique({
      where: { id: scope.projectId },
      select: { name: true, domain: true, language: true, country: true },
    }),
    prisma.brand.findUnique({
      where: { id: scope.brandId },
      select: { name: true },
    }),
    prisma.brandDossier.findUnique({ where: { brandId: scope.brandId } }),
  ]);
  if (!project || !brand) return { status: "FAILED", filled: [] };

  const gaps = emptyFieldsOf(dossier);
  if (gaps.length === 0) return { status: "NOTHING_TO_FILL", filled: [] };

  if (options.trigger === "approve") {
    const attempts = await prisma.auditLog.count({
      where: { brandId: scope.brandId, action: AUDIT.attempted },
    });
    if (attempts >= AUTO_MAX_ATTEMPTS)
      return { status: "EXHAUSTED", filled: [] };
  }

  const actor = options.userId
    ? { actorType: "USER" as const, actorId: options.userId }
    : { actorType: "SYSTEM" as const };
  // Counted before the call: a failing call is an attempt too.
  await AuditLogRepository.record({
    ...scope,
    ...actor,
    action: AUDIT.attempted,
    entityType: "BrandDossier",
    entityId: scope.brandId,
    metadata: { trigger: options.trigger, gaps },
  });

  let suggestion: DossierSuggestion;
  try {
    const result = await ReasoningService.run(dossierSuggestDef, {
      ...scope,
      context: { facts: factsOf(project, brand.name, dossier) },
    });
    if (result.isMock) return { status: "SKIPPED", filled: [] };
    suggestion = result.output;
  } catch (error) {
    console.error(
      "[dossier-suggest] suggestion call failed:",
      error instanceof Error ? error.message : error,
    );
    return { status: "FAILED", filled: [] };
  }

  // Read again: a person may have typed into the dossier while the model ran.
  const latest = await prisma.brandDossier.findUnique({
    where: { brandId: scope.brandId },
  });
  const fillable = emptyFieldsOf(latest);
  const data = writableFrom(suggestion, fillable);
  const filled = Object.keys(data) as DossierField[];
  if (filled.length === 0) return { status: "NOTHING_TO_FILL", filled: [] };

  if (latest) {
    await prisma.brandDossier.update({
      where: { brandId: scope.brandId },
      data,
    });
  } else {
    await prisma.brandDossier.create({
      data: {
        ...scope,
        ...data,
        language: project.language,
        country: project.country,
      },
    });
  }

  await AuditLogRepository.record({
    ...scope,
    ...actor,
    action: AUDIT.filled,
    entityType: "BrandDossier",
    entityId: scope.brandId,
    metadata: {
      source: "ai_suggested",
      trigger: options.trigger,
      fields: filled,
    },
  });
  return { status: "FILLED", filled };
}

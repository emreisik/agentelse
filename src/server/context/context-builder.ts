import "server-only";

import type { CapabilityKey } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  ContextPolicy,
  type ContextField,
} from "@/server/context/context-policy";
import { resolveBrandStyleContext } from "@/server/media/brand-style-context";

export type BuiltContext = Partial<Record<ContextField, unknown>>;

// Assembles exactly the Brand Brain slice ContextPolicy allows for this
// capability. Agents never read BrandDossier/BrandFact/etc. directly — this
// is the only path from "live brand brain" to "what an execution sees."
export async function buildExecutionContext(
  brandId: string,
  capability: CapabilityKey,
): Promise<BuiltContext> {
  const fields = new Set(ContextPolicy.fieldsFor(capability));
  const context: BuiltContext = {};

  const dossier = await prisma.brandDossier.findUnique({ where: { brandId } });

  if (fields.has("language")) context.language = dossier?.language ?? null;
  if (fields.has("country")) context.country = dossier?.country ?? null;
  if (fields.has("positioning"))
    context.positioning = dossier?.positioning ?? null;
  if (fields.has("toneOfVoice"))
    context.toneOfVoice = dossier?.toneOfVoice ?? null;
  if (fields.has("targetAudiences"))
    context.targetAudiences = dossier?.targetAudiences ?? null;
  if (fields.has("visualGuidelines"))
    context.visualGuidelines = dossier?.visualGuidelines ?? null;
  if (fields.has("approvedColors"))
    context.approvedColors = dossier?.approvedColors ?? null;
  if (fields.has("approvedFonts"))
    context.approvedFonts = dossier?.approvedFonts ?? null;
  if (fields.has("logoAssetId"))
    context.logoAssetId = dossier?.logoAssetId ?? null;
  if (fields.has("products")) context.products = dossier?.products ?? null;
  if (fields.has("services")) context.services = dossier?.services ?? null;

  if (fields.has("visualIdentity")) {
    context.visualIdentity = (
      await resolveBrandStyleContext(brandId)
    ).visualIdentity;
  }

  if (fields.has("brandFacts")) {
    context.brandFacts = await prisma.brandFact.findMany({
      where: { brandId },
      take: 50,
    });
  }

  if (fields.has("approvedClaims")) {
    context.approvedClaims = await prisma.approvedClaim.findMany({
      where: { brandId, active: true },
    });
  }

  if (fields.has("negativeBrief")) {
    context.negativeBrief = await prisma.negativeBriefRule.findMany({
      where: { brandId, active: true },
    });
  }

  if (fields.has("recentApprovedCreatives")) {
    context.recentApprovedCreatives = await prisma.creative.findMany({
      where: { brandId, status: { in: ["APPROVED", "PUBLISHED"] } },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
      orderBy: { updatedAt: "desc" },
      take: 5,
    });
  }

  if (fields.has("competitors")) {
    context.competitors = await prisma.competitor.findMany({
      where: { brandId },
      take: 20,
    });
  }

  if (fields.has("strategySummary")) {
    const latest = await prisma.brandStrategyVersion.findFirst({
      where: { brandId },
      orderBy: { version: "desc" },
    });
    context.strategySummary = latest?.summary ?? null;
  }

  if (fields.has("brandConstitution")) {
    const constitution = await prisma.brandConstitution.findFirst({
      where: { brandId, status: "ACTIVE" },
      orderBy: { version: "desc" },
      select: { version: true, summary: true, payload: true },
    });
    context.brandConstitution = constitution ?? null;
  }

  if (fields.has("brandLearnings")) {
    context.brandLearnings = await prisma.brandLearning.findMany({
      where: { brandId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { insight: true, confidence: true, sourceType: true },
    });
  }

  return context;
}

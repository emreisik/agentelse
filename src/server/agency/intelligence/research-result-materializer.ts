import "server-only";

import type { FactClassification, SignalCategory } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { signalFingerprint } from "@/server/agency/fingerprint";
import { SignalRepository } from "@/server/repositories/signal.repository";

import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { researchExtractionDef } from "@/server/reasoning/prompts/research-extraction";

import { CompetitorMaterializer } from "./competitor-materializer";
import { FindingWriter } from "./finding-writer";

const COMPETITOR_CAPABILITIES: ReadonlySet<string> = new Set([
  "COMPETITOR_RESEARCH",
  "COMPETITOR_MONITORING",
  "COMPETITOR_CHANGE_DETECTION",
]);

// Capabilities whose output IS the deliverable: copy the agency wrote for the
// client, a brief, a plan, a report, a publish or ad action. They used to be
// mined for "findings" like any research report, which cost an LLM call per
// task and filed the agency's own writing back as research evidence that
// insight synthesis then read as facts about the market. Anything not listed
// here (every research and scan capability, and any capability added later)
// is still mined.
const DELIVERABLE_CAPABILITIES: ReadonlySet<string> = new Set([
  "CREATE_SOCIAL_CREATIVE",
  "CREATE_AD_CREATIVE",
  "CREATE_COPY",
  "CREATE_CAPTION",
  "CREATE_CAMPAIGN_BRIEF",
  "CREATE_CONTENT_PLAN",
  "EMAIL_DRAFT",
  "EMAIL_SEND",
  "REPORTING",
  "INSTAGRAM_PUBLISH",
  "TIKTOK_PUBLISH",
  "LINKEDIN_PUBLISH",
  "X_PUBLISH",
  "FACEBOOK_PUBLISH",
  "META_CAMPAIGN_CREATE",
  "META_CAMPAIGN_UPDATE",
  "META_ADSET_CREATE",
  "META_ADSET_UPDATE",
  "META_SAFETY_ACTION",
  "META_LAUNCH",
  "META_AD_CREATE",
  "META_AD_UPDATE",
  "GOOGLE_ADS_CAMPAIGN_CREATE",
  "WEBSITE_UPDATE",
  "PR_OUTREACH",
]);

// Whether a completed task's free-text report should be turned into findings
// with an LLM call.
export function shouldExtractFindings(capability: string): boolean {
  return !DELIVERABLE_CAPABILITIES.has(capability);
}

const VALID_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "VERIFIED_FACT",
  "LIKELY_FACT",
  "ASSUMPTION",
  "CONTRADICTION",
  "UNKNOWN",
  "RECOMMENDATION",
]);

type RawFinding = {
  statement?: unknown;
  classification?: unknown;
  category?: unknown;
  confidence?: unknown;
  sourceUrl?: unknown;
  competitorName?: unknown;
};

type RawSignal = {
  title?: unknown;
  summary?: unknown;
  category?: unknown;
  source?: unknown;
  reliability?: unknown;
};

// Turns a COMPLETED research/scan task's provider result into Findings and
// Signals. Providers (mock or real) return `rawResult.findings` /
// `rawResult.signals`; anything malformed is skipped rather than crashing the
// pipeline — a research task with zero parseable findings simply contributes
// nothing.

// The text arrives in a different field depending on the provider: OpenClaw
// uses `final`, AI providers use `text`.
function extractReportText(raw: Record<string, unknown>): string | null {
  for (const key of ["final", "text", "summary"]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 80) return value;
  }
  return null;
}

async function extractFindingsFromReport(
  scope: { workspaceId: string; projectId: string; brandId: string },
  capability: string,
  report: string,
): Promise<RawFinding[]> {
  try {
    const { output } = await ReasoningService.run(researchExtractionDef, {
      ...scope,
      // Don't let very long reports bloat the prompt; the beginning is
      // already the densest part.
      context: { capability, report: report.slice(0, 20_000) },
    });
    // FindingWriter rule: VERIFIED_FACT can't be written without evidence.
    // The model can say "verified" without giving a source URL — instead of
    // relaxing the rule, we downgrade the classification by one notch; the
    // claim is preserved but the evidence chain stays intact.
    return output.findings.map((finding) =>
      finding.classification === "VERIFIED_FACT" && !finding.sourceUrl
        ? { ...finding, classification: "LIKELY_FACT" as const }
        : finding,
    );
  } catch (error) {
    console.error(
      `[research-materializer] Failed to extract findings from the ${capability} report`,
      error,
    );
    return [];
  }
}

export const ResultMaterializer = {
  async materializeTask(taskId: string): Promise<{
    findings: number;
    signals: number;
  }> {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        executionJobs: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!task || task.status !== "COMPLETED") {
      return { findings: 0, signals: 0 };
    }

    const job = task.executionJobs[0];
    const raw = (job?.rawResult ?? {}) as Record<string, unknown>;
    const isMock = raw.isMock === true;

    const scope = {
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      brandId: task.brandId,
    };

    let findingCount = 0;
    let rawFindings = Array.isArray(raw.findings)
      ? (raw.findings as RawFinding[])
      : [];

    // The real OpenClaw agent doesn't return structured `findings`; it
    // returns a markdown report (rawResult.final). If there's no structure
    // but there is text, we convert the report into findings — without this
    // step, the entire research would silently vanish and the rest of the
    // chain would run on empty data.
    if (rawFindings.length === 0 && shouldExtractFindings(task.capability)) {
      const report = extractReportText(raw);
      if (report) {
        rawFindings = await extractFindingsFromReport(
          scope,
          task.capability,
          report,
        );
      }
    }
    if (rawFindings.length > 0) {
      const drafts = rawFindings
        .filter(
          (f) =>
            typeof f.statement === "string" &&
            typeof f.classification === "string" &&
            VALID_CLASSIFICATIONS.has(f.classification),
        )
        .map((f) => ({
          sourceType: "RESEARCH_TASK" as const,
          sourceTaskId: task.id,
          category: typeof f.category === "string" ? f.category : undefined,
          statement: f.statement as string,
          classification: f.classification as FactClassification,
          confidence:
            typeof f.confidence === "number" ? f.confidence : undefined,
          sourceUrl: typeof f.sourceUrl === "string" ? f.sourceUrl : undefined,
          isMock,
        }));
      const written = await FindingWriter.writeMany(scope, drafts);
      findingCount = written.length;

      // In addition to the generic Finding rows above, competitor-research
      // capabilities also get materialized into the dedicated Competitor/
      // CompetitorSnapshot/CompetitorChange/CompetitorInsight tables — see
      // competitor-materializer.ts. Best-effort: a materialization failure
      // must not roll back the Finding writes that already succeeded.
      if (COMPETITOR_CAPABILITIES.has(task.capability)) {
        const competitorFindings = rawFindings
          .filter(
            (f) =>
              typeof f.statement === "string" &&
              typeof f.competitorName === "string" &&
              f.competitorName.trim().length > 0,
          )
          .map((f) => ({
            competitorName: f.competitorName as string,
            statement: f.statement as string,
            confidence:
              typeof f.confidence === "number" ? f.confidence : undefined,
          }));
        if (competitorFindings.length > 0) {
          try {
            await CompetitorMaterializer.materialize(
              scope,
              task.id,
              competitorFindings,
            );
          } catch (error) {
            console.error(
              `[research-materializer] Competitor materialization failed for task ${task.id}:`,
              error instanceof Error ? error.message : error,
            );
          }
        }
      }
    }

    let signalCount = 0;
    const rawSignals = Array.isArray(raw.signals)
      ? (raw.signals as RawSignal[])
      : [];
    for (const s of rawSignals) {
      if (typeof s.title !== "string" || typeof s.category !== "string") {
        continue;
      }
      const source =
        typeof s.source === "string" ? s.source : `task:${task.capability}`;
      const category = normalizeSignalCategory(s.category);
      const result = await SignalRepository.create({
        ...scope,
        source,
        category,
        title: s.title,
        summary: typeof s.summary === "string" ? s.summary : undefined,
        reliability:
          typeof s.reliability === "number" ? s.reliability : undefined,
        freshness: 1,
        fingerprint: signalFingerprint({
          category,
          source,
          title: s.title,
        }),
        sourceTaskId: task.id,
      });
      if (!result.duplicate) signalCount += 1;
    }

    return { findings: findingCount, signals: signalCount };
  },
};

const SIGNAL_CATEGORIES = new Set([
  "COMPETITOR",
  "PRODUCT_LAUNCH",
  "TECHNOLOGY",
  "SEO",
  "SOCIAL_TREND",
  "PAID_ADVERTISING",
  "MEDIA",
  "CREATOR",
  "PARTNERSHIP",
  "EVENT",
  "OFFLINE",
  "CUSTOMER",
  "MARKET",
  "CULTURE",
  "PERFORMANCE",
  "OTHER",
]);

function normalizeSignalCategory(value: string): SignalCategory {
  const upper = value.toUpperCase();
  return (SIGNAL_CATEGORIES.has(upper) ? upper : "OTHER") as SignalCategory;
}

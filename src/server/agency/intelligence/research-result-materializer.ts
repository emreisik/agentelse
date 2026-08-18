import "server-only";

import type { FactClassification, SignalCategory } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { signalFingerprint } from "@/server/agency/fingerprint";
import { SignalRepository } from "@/server/repositories/signal.repository";

import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { researchExtractionDef } from "@/server/reasoning/prompts/research-extraction";

import { FindingWriter } from "./finding-writer";

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

// Sağlayıcıya göre metin farklı alanda gelir: OpenClaw `final`, AI
// sağlayıcıları `text`.
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
      // Çok uzun raporlar prompt'u şişirmesin; başı zaten en yoğun kısım.
      context: { capability, report: report.slice(0, 20_000) },
    });
    // FindingWriter kuralı: VERIFIED_FACT kanıtsız yazılamaz. Model kaynak
    // URL vermeden "doğrulanmış" diyebiliyor — kuralı gevşetmek yerine
    // sınıflandırmayı bir kademe indiriyoruz, iddia korunur ama kanıt
    // zinciri bozulmaz.
    return output.findings.map((finding) =>
      finding.classification === "VERIFIED_FACT" && !finding.sourceUrl
        ? { ...finding, classification: "LIKELY_FACT" as const }
        : finding,
    );
  } catch (error) {
    console.error(
      `[research-materializer] ${capability} raporundan bulgu çıkarılamadı`,
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

    // Gerçek OpenClaw ajanı yapılandırılmış `findings` döndürmez; markdown
    // bir rapor döndürür (rawResult.final). Yapı yoksa ama metin varsa
    // raporu bulgulara çeviririz — bu adım olmadan tüm araştırma sessizce
    // kaybolur ve zincirin geri kalanı boş veriyle çalışır.
    if (rawFindings.length === 0) {
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

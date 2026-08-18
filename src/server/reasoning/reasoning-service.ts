import "server-only";

import { z } from "zod";

import {
  geminiModelForTier,
  isGeminiConfigured,
  runGeminiStructured,
} from "@/server/reasoning/gemini-client";
import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { ReasoningCallRepository } from "@/server/repositories/reasoning-call.repository";
import { estimateReasoningCostUsd } from "@/server/reasoning/gemini-pricing";
import { HubConnectError } from "@/server/security/errors";

import type { ReasoningDef, ReasoningInput, ReasoningResult } from "./types";

type ReasoningMode = "mock" | "auto";

function resolveMode(): ReasoningMode {
  const raw = process.env.HUBCONNECT_REASONING_MODE;
  if (raw === "mock") return raw;
  return "auto";
}

function shouldMock(): boolean {
  // Varsayılan daima gerçek: mock yalnızca açıkça istendiğinde devreye girer
  // (testler ve seed script'leri HUBCONNECT_REASONING_MODE=mock ayarlar).
  // API anahtarı yoksa sessizce mock'a düşmek yerine çağrı açıkça hata verir.
  return resolveMode() === "mock";
}

// The single entry point for every engine-internal LLM call. Deliberately NOT
// routed through Task/ExecutionJob (signals/insights are not tasks — spec §16)
// but still budget-capped per project per day and fully audited via
// ReasoningCall + AuditLog rows.

// Projenin dili/pazarı her prompt'a tek noktadan enjekte edilir. Tek tek
// prompt dosyalarına yazmak yerine burada: aksi halde bir prompt eklendiğinde
// unutuluyor ve çıktı sessizce İngilizce dönüyordu (hedefler, denetimler ve
// anayasa fiilen böyle üretilmişti).
const localeCache = new Map<string, string>();

async function localeDirective(projectId: string): Promise<string> {
  const cached = localeCache.get(projectId);
  if (cached !== undefined) return cached;

  const project = await prisma.project
    .findUnique({
      where: { id: projectId },
      select: { language: true, country: true },
    })
    .catch(() => null);

  const language = project?.language || "tr";
  const country = project?.country || "TR";
  const directive = [
    `Write EVERY string in your JSON output in the language with code "${language}".`,
    `The brand operates in the market with country code "${country}" — keep terminology, examples and cultural references relevant to it.`,
    "Field names stay in English; only the values are translated. Do not mix languages.",
  ].join(" ");

  localeCache.set(projectId, directive);
  return directive;
}

export const ReasoningService = {
  isMockMode: shouldMock,

  async run<TOut>(
    def: ReasoningDef<TOut>,
    input: ReasoningInput,
  ): Promise<ReasoningResult<TOut>> {
    const mock = shouldMock();
    // def.model, prompt bazında model seçimine izin verir (ağır sentezler
    // için Pro, sık çalışan ucuz adımlar için Flash). Tanımsızsa proje
    // geneli varsayılan kullanılır.
    const model = mock ? "mock" : (def.model ?? geminiModelForTier(def.tier));
    const startedAt = Date.now();

    // Budget gate first — mock calls cost 0 but still count, so a runaway
    // loop is detected identically in both modes.
    await AutonomyPolicyRepository.checkAndIncrement(
      {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
      },
      "reasoningCalls",
    );

    try {
      let output: TOut;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;

      if (mock) {
        output = def.schema.parse(def.buildMock(input.context));
      } else {
        if (!isGeminiConfigured()) {
          throw new HubConnectError(
            "PROVIDER_UNAVAILABLE",
            `Reasoning ${def.purpose}: GEMINI_API_KEY is not configured`,
          );
        }
        const prompt = def.buildPrompt(input.context);
        const directive = await localeDirective(input.projectId);
        const result = await runGeminiStructured({
          model,
          system: `${directive}\n\n${prompt.system}`,
          // Talimat hem başta hem sonda: yalnızca sistem prompt'una
          // konduğunda uzun prompt'larda güvenilir izlenmiyordu ve çıktının
          // bir kısmı İngilizce dönüyordu.
          user: `${prompt.user}\n\n${directive}`,
          jsonSchema: z.toJSONSchema(def.schema),
          maxOutputTokens: def.maxTokens ?? 8192,
          attachments: input.attachments,
        });
        output = def.schema.parse(result.raw);
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
      }

      // Maliyet çağrı başına hesaplanır ve hem kaydın kendisine hem de
      // günlük toplama yazılır — dailyBudgetUsd sınırının çalışabilmesi
      // için sayacın gerçek harcamayı taşıması gerekiyor.
      const costUsd = mock
        ? 0
        : estimateReasoningCostUsd({ model, inputTokens, outputTokens });

      const call = await ReasoningCallRepository.record({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        purpose: def.purpose,
        model,
        isMock: mock,
        inputTokens,
        outputTokens,
        costUsd,
        durationMs: Date.now() - startedAt,
        status: "OK",
      });

      if (costUsd > 0) {
        // Sayaç zaten yukarıda artırıldı; burada yalnızca maliyet eklenir.
        await AutonomyPolicyRepository.checkAndIncrement(
          {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            brandId: input.brandId,
          },
          "reasoningCalls",
          0,
          costUsd,
        ).catch(() => undefined);
      }

      await AuditLogRepository.record({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actorType: "SYSTEM",
        action: `reasoning.${def.purpose}`,
        entityType: "ReasoningCall",
        entityId: call.id,
        metadata: { isMock: mock, model },
      });

      return { output, isMock: mock, reasoningCallId: call.id };
    } catch (error) {
      if (
        error instanceof HubConnectError &&
        error.code === "BUDGET_EXCEEDED"
      ) {
        throw error;
      }
      await ReasoningCallRepository.record({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        purpose: def.purpose,
        model,
        isMock: mock,
        durationMs: Date.now() - startedAt,
        status: "ERROR",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
};

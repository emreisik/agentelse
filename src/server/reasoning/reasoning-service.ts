import "server-only";

import { z } from "zod";

import { getEnv } from "@/lib/env";
import {
  geminiModelForTier,
  isGeminiConfigured,
  runGeminiStructured,
} from "@/server/reasoning/gemini-client";
import {
  isOpenAIConfigured,
  openaiModelForTier,
  runOpenAIStructured,
} from "@/server/reasoning/openai-client";
import { runOpenAIStructuredWithSearch } from "@/server/reasoning/openai-search-client";
import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { ReasoningCallRepository } from "@/server/repositories/reasoning-call.repository";
import { estimateReasoningCostUsd } from "@/server/reasoning/reasoning-pricing";
import { AgentelseError } from "@/server/security/errors";

import type { ReasoningDef, ReasoningInput, ReasoningResult } from "./types";

type ReasoningMode = "mock" | "auto";

function resolveMode(): ReasoningMode {
  const raw = process.env.AGENTELSE_REASONING_MODE;
  if (raw === "mock") return raw;
  return "auto";
}

function shouldMock(): boolean {
  // The default is always real: mock only kicks in when explicitly
  // requested (tests and seed scripts set AGENTELSE_REASONING_MODE=mock).
  // If there's no API key, the call errors explicitly instead of silently
  // falling back to mock.
  return resolveMode() === "mock";
}

// The single entry point for every engine-internal LLM call. Deliberately NOT
// routed through Task/ExecutionJob (signals/insights are not tasks — spec §16)
// but still budget-capped per project per day and fully audited via
// ReasoningCall + AuditLog rows.

// The project's language/market is injected into every prompt from a
// single point. Here, rather than in each individual prompt file:
// otherwise it kept getting forgotten when a new prompt was added, and the
// output silently came back in English (goals, audits and the constitution
// had actually been generated this way).
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
    // Which backend handles the call — Gemini by default, OpenAI when
    // REASONING_PROVIDER=openai. Both implement the same structured-call
    // contract, so nothing below (or in any prompt file) branches on it
    // except model selection and the actual call.
    const provider = mock ? "gemini" : getEnv().REASONING_PROVIDER;
    // def.model allows model selection on a per-prompt basis (Pro for
    // heavy syntheses, Flash for cheap, frequently-run steps). If
    // undefined, the active provider's tier default is used. Note that a
    // pinned def.model is provider-specific — a def pinning a Gemini model
    // effectively opts out of the provider switch.
    const model = mock
      ? "mock"
      : (def.model ??
        (provider === "openai"
          ? openaiModelForTier(def.tier)
          : geminiModelForTier(def.tier)));
    // The backend is ultimately decided by the model's family, so a def
    // that pins e.g. a Gemini model keeps working even when the
    // project-wide provider is OpenAI (and vice versa).
    const backend = model.startsWith("gpt-") ? "openai" : "gemini";
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
      let webSearchCalls: number | undefined;

      if (mock) {
        output = def.schema.parse(def.buildMock(input.context));
      } else {
        const configured =
          backend === "openai" ? isOpenAIConfigured() : isGeminiConfigured();
        if (!configured) {
          throw new AgentelseError(
            "PROVIDER_UNAVAILABLE",
            `Reasoning ${def.purpose}: ${
              backend === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"
            } is not configured`,
          );
        }
        const prompt = def.buildPrompt(input.context);
        const directive = await localeDirective(input.projectId);
        // Live web search is an OpenAI Responses feature; a def that asks for
        // it on another backend simply runs without.
        const runStructured =
          backend === "openai"
            ? def.webSearch
              ? runOpenAIStructuredWithSearch
              : runOpenAIStructured
            : runGeminiStructured;
        const result = await runStructured({
          model,
          system: `${directive}\n\n${prompt.system}`,
          // The directive goes both at the start and at the end: when
          // placed only in the system prompt, it wasn't reliably followed
          // on long prompts and part of the output came back in English.
          user: `${prompt.user}\n\n${directive}`,
          jsonSchema: z.toJSONSchema(def.schema),
          maxOutputTokens: def.maxTokens ?? 8192,
          attachments: input.attachments,
        });
        output = def.schema.parse(result.raw);
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
        webSearchCalls = (result as { webSearchCalls?: number }).webSearchCalls;
      }

      // Cost is calculated per call and written to both the record itself
      // and the daily aggregate — the counter needs to carry actual
      // spending for the dailyBudgetUsd cap to work.
      const costUsd = mock
        ? 0
        : estimateReasoningCostUsd({
            model,
            inputTokens,
            outputTokens,
            webSearchCalls,
          });

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
        // The counter was already incremented above; only the cost is added here.
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
        metadata: {
          isMock: mock,
          model,
          ...(webSearchCalls ? { webSearchCalls } : {}),
        },
      });

      return { output, isMock: mock, reasoningCallId: call.id };
    } catch (error) {
      if (error instanceof AgentelseError && error.code === "BUDGET_EXCEEDED") {
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

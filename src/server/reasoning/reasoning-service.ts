import "server-only";

import { z } from "zod";

import {
  isOpenAIConfigured,
  openaiModelForTier,
  runOpenAIStructured,
} from "@/server/reasoning/openai-client";
import { runOpenAIStructuredWithSearch } from "@/server/reasoning/openai-search-client";
import { SUPPORTED_LANGUAGES } from "@/lib/locales";
import { prisma } from "@/lib/prisma";
import { gatedAiCall } from "@/server/billing/call-gate";
import {
  NO_PLAN_LIMIT,
  PLAN_ALLOWANCE_LIMIT,
} from "@/server/billing/quota-errors";
import {
  ASSUMED_SEARCH_CALLS,
  PROMPT_OVERHEAD_CHARS,
  estimateTextCallMicros,
} from "@/server/billing/cost-estimate";
import { moduleOf, runWithUsageScope } from "@/server/billing/usage-context";
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

async function localeDirective(
  projectId: string,
  languageOverride?: string,
): Promise<string> {
  // SC-F6: desteklenmeyen kod yok sayılır; ülke yine projeden gelir.
  const override =
    languageOverride &&
    SUPPORTED_LANGUAGES.some((l) => l.code === languageOverride)
      ? languageOverride
      : undefined;
  const cacheKey = `${projectId}|${override ?? ""}`;
  const cached = localeCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const project = await prisma.project
    .findUnique({
      where: { id: projectId },
      select: { language: true, country: true },
    })
    .catch(() => null);

  const language = override || project?.language || "tr";
  const country = project?.country || "TR";
  const directive = [
    `Write EVERY string in your JSON output in the language with code "${language}".`,
    `The brand operates in the market with country code "${country}" — keep terminology, examples and cultural references relevant to it.`,
    "Field names stay in English; only the values are translated. Do not mix languages.",
  ].join(" ");

  localeCache.set(cacheKey, directive);
  return directive;
}

// A call the plan could not pay for leaves a "BLOCKED" row, because the engines
// that sweep for work (insight synthesis, idea refill, ...) throttle themselves on
// the last ReasoningCall of a project: with no row at all they would pick the same
// stalled tenant again on every tick and starve everybody behind it. A blocked
// attempt counts as a failed one there (retried after an hour). Health reads only
// "ERROR" rows, so this is not noise on the System Health screen. At most one row
// per project and purpose every ten minutes.
const BLOCKED_ROW_EVERY_MS = 10 * 60_000;
const blockedNoted = new Map<string, number>();

async function noteAllowanceRefusal(
  def: { purpose: string },
  input: ReasoningInput,
  error: unknown,
): Promise<void> {
  if (!(error instanceof AgentelseError) || error.code !== "BUDGET_EXCEEDED") {
    return;
  }
  const limit = (error.meta as { limit?: unknown } | undefined)?.limit;
  if (limit !== PLAN_ALLOWANCE_LIMIT && limit !== NO_PLAN_LIMIT) return;
  const key = `${input.projectId}|${def.purpose}`;
  const now = Date.now();
  const last = blockedNoted.get(key);
  if (last !== undefined && now - last < BLOCKED_ROW_EVERY_MS) return;
  if (blockedNoted.size > 5_000) blockedNoted.clear();
  blockedNoted.set(key, now);
  await ReasoningCallRepository.record({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    brandId: input.brandId,
    purpose: def.purpose,
    model: "blocked",
    isMock: false,
    durationMs: 0,
    status: "BLOCKED",
    errorMessage: "plan allowance",
  }).catch(() => undefined);
}

export const ReasoningService = {
  isMockMode: shouldMock,

  // Plan allowance gate (docs/billing-tasks.md), OUTSIDE everything below: a call
  // the plan cannot pay for is refused before it touches the project's daily
  // counters (a refused call must not use up the day's call count) and before any
  // model is called. Inside a job that already holds a reservation the call simply
  // joins it. Mock mode and BILLING_MODE=off run exactly as they always did.
  async run<TOut>(
    def: ReasoningDef<TOut>,
    input: ReasoningInput,
  ): Promise<ReasoningResult<TOut>> {
    if (shouldMock()) return ReasoningService.runUngated(def, input);
    try {
      return await gatedAiCall(
        {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          module: moduleOf(def.purpose),
          source: "reasoning",
          purpose: def.purpose,
          estimateMicros: () =>
            estimateTextCallMicros({
              model: def.model ?? openaiModelForTier(def.tier),
              // The prompt is built from the context; a fixed margin covers the
              // system prompt. Attached files ride as pictures/PDFs, not as text.
              inputChars:
                JSON.stringify(input.context ?? {}).length +
                (input.attachments?.length ?? 0) * 6_000 +
                PROMPT_OVERHEAD_CHARS,
              maxOutputTokens: def.maxTokens ?? 8192,
              searchCalls: def.webSearch ? ASSUMED_SEARCH_CALLS : 0,
            }),
        },
        () => ReasoningService.runUngated(def, input),
      );
    } catch (error) {
      await noteAllowanceRefusal(def, input, error);
      throw error;
    }
  },

  async runUngated<TOut>(
    def: ReasoningDef<TOut>,
    input: ReasoningInput,
  ): Promise<ReasoningResult<TOut>> {
    const mock = shouldMock();
    // def.model allows model selection on a per-prompt basis (a bigger model
    // for heavy syntheses, a smaller one for cheap, frequently-run steps). If
    // undefined, the tier default is used.
    const model = mock ? "mock" : (def.model ?? openaiModelForTier(def.tier));
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
        if (!isOpenAIConfigured()) {
          throw new AgentelseError(
            "PROVIDER_UNAVAILABLE",
            `Reasoning ${def.purpose}: OPENAI_API_KEY is not configured`,
          );
        }
        const prompt = def.buildPrompt(input.context);
        const directive = await localeDirective(
          input.projectId,
          input.language,
        );
        const runStructured = def.webSearch
          ? runOpenAIStructuredWithSearch
          : runOpenAIStructured;
        // Billing scope: every paid call below (including the doubled-budget
        // retry) is attributed to this workspace/project and purpose.
        const result = await runWithUsageScope(
          {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            source: "reasoning",
            purpose: def.purpose,
            module: moduleOf(def.purpose),
          },
          () =>
            runStructured({
              model,
              system: `${directive}\n\n${prompt.system}`,
              // The directive goes both at the start and at the end: when
              // placed only in the system prompt, it wasn't reliably followed
              // on long prompts and part of the output came back in English.
              user: `${prompt.user}\n\n${directive}`,
              jsonSchema: z.toJSONSchema(def.schema),
              maxOutputTokens: def.maxTokens ?? 8192,
              attachments: input.attachments,
            }),
        );
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

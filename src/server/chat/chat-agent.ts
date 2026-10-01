import "server-only";

import { CommandService } from "@/server/commands/command-service";
import {
  limitNoticeFromError,
  limitNoticeReplyText,
} from "@/server/commands/limit-notice";
import { getEnv } from "@/lib/env";
import { brandCoreOf } from "@/server/brand-twin/brand-twin";
import { QuickDiscoveryService } from "@/server/brand/quick-discovery";
import { memoryForPrompt } from "@/server/memory/relevance";
import { ensureProjectActive } from "@/server/projects/activation";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { estimateReasoningCostUsd } from "@/server/reasoning/reasoning-pricing";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import {
  CommandRepository,
  type CommandAttachment,
  type CommandReplyStatus,
} from "@/server/repositories/command.repository";
import { ReasoningCallRepository } from "@/server/repositories/reasoning-call.repository";
import { AgentelseError, isAgentelseError } from "@/server/security/errors";
import {
  SESSION_LIMITS,
  remainingBudgetUsd,
  sessionForPrompt,
} from "@/server/work-session/session";
import { WorkSessionService } from "@/server/work-session/work-session-service";
import type { IdeaEventCardData } from "@/types/idea-event-card";

import { buildHistoryInput, buildUserInput, trimHistory } from "./history";
import { loadNextSteps } from "@/server/agency/journey/snapshot";
import { buildContext } from "./context";
import {
  workChannelStates,
  workSummaryFrom,
  workTitleFrom,
} from "@/lib/works/work";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { WorkRepository } from "@/server/repositories/work.repository";
import { getProjectTimezone, todayInTimezone } from "./content-plan";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import {
  MAX_OPTION_SLOTS,
  describePlanSlots,
  latestPlanBrief,
  layoutPlanSlots,
} from "@/lib/works/plan-layout";
import { parsePlanBrief, stripPlanBriefMarker } from "@/lib/plan-brief";
import { createBrandRulesGetter } from "@/server/works/brand-rule-loader";
import { loadRecentHistoryFiles } from "./history-files";
import { createMockChatModel } from "./mock-chat-model";
import {
  chatModelName,
  isChatModelConfigured,
  openaiChatModel,
} from "./openai-chat-client";
import { buildContextMessage, CHAT_INSTRUCTIONS } from "./prompt";
import {
  RunGuard,
  STOP_NOTICES,
  canonicalJson,
  type StopReason,
} from "./run-guard";
import {
  toOpenAITools,
  toolsForPhase,
  type ChatTool,
  type SessionHandle,
  type ToolContext,
  type ToolOutcome,
} from "./tools";
import { logTurnTiming } from "./turn-timing";
import type { ChatModel, ChatModelEvent, ChatStreamEvent } from "./types";

// How long the first reply waits for the brand scan (site pages + a few web
// searches + one model call). Past this the reply goes ahead without it.
const QUICK_DISCOVERY_WAIT_MS = 75_000;
const MAX_OUTPUT_TOKENS = 8192;
// ~25k tokens of prior conversation; the rest of the window is left for the
// brand context, attachments, tool round trips and the reply.
const HISTORY_CHAR_BUDGET = 100_000;

export type ChatAgentInput = {
  workspaceId: string;
  projectId: string;
  userId: string;
  message: string;
  ideaId?: string;
  // The Work this turn belongs to (WORKS_UI). The route has already checked it
  // belongs to the project.
  workId?: string;
  attachments?: CommandAttachment[];
  // Base64 bodies shown to the model only (same order as `attachments`);
  // never persisted on the Command row.
  attachmentBodies?: { mimeType: string; data: string }[];
  // Aborted when the client hits Stop / disconnects: cancels the in-flight
  // model stream so no further tokens are paid for.
  signal?: AbortSignal;
};

type ParsedArgs = { ok: true; value: unknown } | { ok: false; error: string };

function parseArgs(tool: ChatTool, raw: string): ParsedArgs {
  let json: unknown;
  try {
    json = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, error: "Arguments were not valid JSON." };
  }
  const parsed = tool.schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Arguments did not match the schema: ${parsed.error.message}`,
    };
  }
  return { ok: true, value: parsed.data };
}

// The streaming, tool-calling chat engine (spec: "ChatGPT-style" agent loop).
// Replaces ChatService.turn's single blocking JSON call:
//   1. the Command row is created FIRST, so a dropped connection never loses
//      the client's message;
//   2. the model streams its reply token by token and may call tools, each of
//      which wraps existing services (CommandService.submit, setup, ...), so
//      every business gate keeps working unchanged;
//   3. the finished reply + card are written back to the same Command row.
// Yields ChatStreamEvents; the route handler turns them into SSE frames.
export async function* runChatAgent(
  input: ChatAgentInput,
  deps: { model?: ChatModel } = {},
): AsyncGenerator<ChatStreamEvent> {
  const startedAt = Date.now();

  const command = await CommandRepository.create({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    ideaId: input.ideaId,
    workId: input.workId,
    source: "WEB",
    rawText: input.message,
    createdByUserId: input.userId,
    attachments: input.attachments,
  });
  yield { type: "start", commandId: command.id };

  const replyParts: string[] = [];
  // Text of the model turn currently streaming; folded into replyParts when
  // the turn completes, but still part of the reply if the stream is cut.
  let inFlight = "";
  const appended: string[] = [];
  let status: CommandReplyStatus = "ANSWERED";
  let card: IdeaEventCardData | undefined;
  // Works: a tool already stored its card on the Command (re-read after the
  // work), so a later card of the turn must not replace it in persist().
  let cardPersisted = false;
  // What this message may do (rounds, work actions, cost...) and what it has
  // done so far; see run-guard.ts. Widened when the message belongs to a work
  // session.
  const guard = new RunGuard();
  // The work session this message belongs to: loaded with the context, or
  // opened by start_work_session. Its spend is charged to it at the end.
  const sessionRef: SessionHandle = {};
  let suggestionItems: string[] | undefined;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let modelRan = false;
  // Where the time of this turn goes (logged once, see logTurnTiming): the
  // work before the first model call, the wait for the first token, the model
  // loop, and the writes after it.
  const timing = {
    modelStartedAt: 0,
    firstTokenAt: 0,
    modelEndedAt: 0,
    rounds: 0,
    tools: [] as string[],
  };
  let brandId: string | undefined;
  let settled = false;
  const modelName = ReasoningService.isMockMode() ? "mock" : chatModelName();

  // What the model calls of this message have cost so far.
  const turnCostUsd = () =>
    modelName === "mock"
      ? 0
      : estimateReasoningCostUsd({
          model: modelName,
          inputTokens,
          outputTokens,
        });

  const replyText = () =>
    [...replyParts, inFlight.trim(), ...appended]
      .filter(Boolean)
      .join("\n\n")
      .trim();

  // ReasoningCall + cost + audit, mirroring ReasoningService.run so the chat
  // shows up in the same usage dashboards and budget counters as before.
  async function recordUsage(ok: boolean, errorMessage?: string) {
    if (!modelRan || !brandId) return;
    logTurnTiming({
      ok,
      startedAt,
      ...timing,
      inputTokens,
      cachedInputTokens,
      outputTokens,
    });
    const mock = modelName === "mock";
    const costUsd = turnCostUsd();
    const scope = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId,
    };
    // The work session this message belonged to is charged for it (its own
    // ceiling, on top of the daily counters below).
    if (sessionRef.id) {
      await WorkSessionService.addSpend(scope, sessionRef.id, costUsd).catch(
        (error) => {
          console.error("[chat-agent] failed to record session spend:", error);
        },
      );
    }
    try {
      const call = await ReasoningCallRepository.record({
        ...scope,
        purpose: "chat.turn",
        model: modelName,
        isMock: mock,
        inputTokens: inputTokens || undefined,
        outputTokens: outputTokens || undefined,
        costUsd,
        durationMs: Date.now() - startedAt,
        status: ok ? "OK" : "ERROR",
        errorMessage,
      });
      if (costUsd > 0) {
        await AutonomyPolicyRepository.checkAndIncrement(
          scope,
          "reasoningCalls",
          0,
          costUsd,
        ).catch(() => undefined);
      }
      await AuditLogRepository.record({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actorType: "SYSTEM",
        action: "reasoning.chat.turn",
        entityType: "ReasoningCall",
        entityId: call.id,
        metadata: { isMock: mock, model: modelName },
      });
    } catch (error) {
      console.error("[chat-agent] failed to record usage:", error);
    }
  }

  async function persist(text: string, replyStatus: CommandReplyStatus) {
    await CommandRepository.recordReply(command.id, text, replyStatus);
    if (card && !cardPersisted) {
      await CommandRepository.attachParsedIntent(
        command.id,
        { card },
        input.projectId,
        brandId,
      ).catch((error) => {
        console.error("[chat-agent] failed to attach card:", error);
      });
    }
    if (input.workId) {
      // The sidebar subtitle: the card's headline, else the reply's first words.
      const cardTitle =
        card && "title" in card && typeof card.title === "string"
          ? card.title
          : null;
      // A failed or stopped turn never overwrites it with an error text
      // ("I can't generate a reply right now: <provider error>") or "(stopped)".
      const headline = cardTitle ?? (replyStatus === "ERROR" ? null : text);
      if (headline !== null) {
        await WorkRepository.touch(input.projectId, input.workId, {
          summary: workSummaryFrom(headline),
        }).catch(() => undefined);
      }
    }
  }

  try {
    // A project that has not run (or finished) setup is activated here rather
    // than turned away: buildContext reads the status right after, so this
    // turn already sees ACTIVE. Paused / closed projects stay as they are and
    // come back as ON_HOLD (read-only tools). A failure must not take the
    // whole turn down; the phase then simply reads as ON_HOLD.
    await ensureProjectActive(input.projectId).catch((error) => {
      console.error("[chat-agent] ensureProjectActive failed:", error);
    });

    // First conversation with a brand the agency knows nothing about yet:
    // read its public website (and a little of the web) before answering, so
    // this very reply is written by someone who knows what the brand is. The
    // client sees it happen; it is bounded, and if it does not finish in time
    // the turn goes on without it and the scan completes in the background.
    let brandScan: "completed" | "unavailable" | undefined;
    const { CHAT_REASONING_EFFORT, CHAT_WEB_SEARCH, GUIDED_SETUP } = getEnv();
    // The hardened scan (fence, scrub, late-landing merge) only while the
    // feature is on; with it off the call is exactly what it always was.
    const discovery = await QuickDiscoveryService.claim(input.projectId, {
      guided: GUIDED_SETUP,
    }).catch((error) => {
      console.error("[chat-agent] quick discovery claim failed:", error);
      return null;
    });
    if (discovery) {
      yield {
        type: "tool.start",
        name: "quick_discovery",
        label: "Getting to know your brand…",
      };
      const scan = await QuickDiscoveryService.runWithin(
        discovery,
        QUICK_DISCOVERY_WAIT_MS,
      );
      brandScan = scan.status === "DONE" ? "completed" : "unavailable";
      yield {
        type: "tool.end",
        name: "quick_discovery",
        ok: scan.status === "DONE",
      };
    }

    const work = input.workId
      ? await WorkRepository.get(input.projectId, input.workId)
      : null;
    // The route checked this Work, but it may be gone since (deleted in
    // another tab): never fall back to the plain tool list for it.
    if (input.workId && !work) {
      throw new AgentelseError("NOT_FOUND", "This Work no longer exists.");
    }
    if (work) {
      // The title and ordering are the user's own words, available at once.
      await WorkRepository.touch(input.projectId, work.id, {
        // The wizard's machine line is not part of the title.
        titleIfDefault: workTitleFrom(stripPlanBriefMarker(input.message)),
      }).catch(() => undefined);
    }
    const context = await buildContext(input.projectId, input.ideaId, {
      recall: true,
      session: true,
      workId: work?.id,
    });
    brandId = context.brandId;
    const scope = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: context.brandId,
    };
    // A message that continues a live work session runs under its allowance.
    if (context.workSession) {
      sessionRef.id = context.workSession.id;
      guard.enterSession(remainingBudgetUsd(context.workSession.session));
    }

    // Budget gate first, exactly like ReasoningService.run: a runaway loop is
    // caught by the same per-project daily counters. Throws BUDGET_EXCEEDED,
    // handled below as a limit-notice card.
    await AutonomyPolicyRepository.checkAndIncrement(scope, "reasoningCalls");

    const mock = ReasoningService.isMockMode();
    if (!mock && !isChatModelConfigured()) {
      throw new AgentelseError(
        "PROVIDER_UNAVAILABLE",
        "Chat: OPENAI_API_KEY is not configured",
      );
    }
    const model: ChatModel =
      deps.model ??
      (mock ? createMockChatModel(input.message) : openaiChatModel);

    const streamQueue: ChatStreamEvent[] = [];
    let wakeStream: (() => void) | undefined;

    const toolCtx: ToolContext = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: context.brandId,
      userId: input.userId,
      ideaId: input.ideaId,
      work: work ?? undefined,
      commandId: command.id,
      message: input.message,
      attachments: input.attachments,
      phase: context.projectPhase,
      session: sessionRef,
      // Works only: lazy, no query until a tool asks.
      getBrandRules: work
        ? createBrandRulesGetter({
            projectId: input.projectId,
            brandId: context.brandId,
            language: context.project.language || "tr",
          })
        : undefined,
      // Events a running tool wants the client to see NOW (image previews).
      // Drained by the tool loop below while execute() is still pending.
      emit: (event) => {
        streamQueue.push(event);
        wakeStream?.();
      },
    };
    const tools = toolsForPhase(context.projectPhase, {
      guidedSetup: GUIDED_SETUP,
      ...(work ? { works: true } : {}),
    });
    const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
    const openaiTools = [
      ...toOpenAITools(tools),
      // Hosted tool: OpenAI runs the search itself, results just flow into
      // the reply. Opt-in (CHAT_WEB_SEARCH) and real models only.
      ...(CHAT_WEB_SEARCH && !mock ? [{ type: "web_search" as const }] : []),
    ];

    const historyFiles = await loadRecentHistoryFiles(
      context.recent,
      command.id,
      input.projectId,
    ).catch(() => new Map());

    const timezone = await getProjectTimezone(input.projectId);
    const workForPrompt = work
      ? {
          title: work.title,
          channels: workChannelStates(
            work.channels,
            await getChannelConnections(input.projectId).catch(() => ({})),
          ).map((state) => ({
            label: state.label,
            connected: state.connected,
          })),
        }
      : undefined;
    // Works: the brief of this message, else the newest earlier brief of the
    // Work (a typed change such as "more playful" carries none). The slots
    // note and the plan tool both read it.
    let worksPlanSlots: string[] | undefined;
    let worksPlanFromEarlierBrief = false;
    let worksPlanTooLarge = false;
    if (work) {
      const currentBrief = parsePlanBrief(input.message);
      const planBrief =
        currentBrief ??
        latestPlanBrief(
          context.recent
            .filter((row) => row.source === "WEB")
            .map((row) => row.rawText),
        );
      toolCtx.planBriefFallback = currentBrief ? undefined : planBrief;
      if (planBrief) {
        const slots = layoutPlanSlots({
          brief: planBrief,
          today: todayInTimezone(timezone),
          nowLocalTime: utcToZonedDateTimeLocal(new Date(), timezone).slice(
            11,
            16,
          ),
        });
        if (slots.length >= 1 && slots.length <= MAX_OPTION_SLOTS) {
          // The note numbers the lines itself; describePlanSlots already did.
          worksPlanSlots = describePlanSlots(slots).map((line) =>
            line.replace(/^\d+\.\s/, ""),
          );
          worksPlanFromEarlierBrief = !currentBrief;
        } else if (slots.length > MAX_OPTION_SLOTS) {
          worksPlanTooLarge = true;
        }
      }
    }
    // What is waiting on the client's content plan (never throws: [] when
    // there is nothing or the read failed).
    const nextSteps = work
      ? await loadNextSteps(input.projectId, { workId: work.id })
      : await loadNextSteps(input.projectId);

    const conversation = [
      {
        role: "developer" as const,
        content: buildContextMessage({
          project: context.project,
          // Brand Core, and (separately) the memory that matters right now.
          brand: brandCoreOf(context.brand),
          memory: context.memory ? memoryForPrompt(context.memory) : undefined,
          state: context.state,
          agency: context.agency,
          pending: context.pending,
          workSession: context.workSession
            ? sessionForPrompt(context.workSession.session)
            : undefined,
          phase: context.projectPhase,
          enrichment: context.setupWaiting,
          brandScan,
          // The note only where the tool is really offered (not ON_HOLD).
          guidedSetup: tools.some((tool) => tool.name === "start_guided_setup"),
          nextSteps: nextSteps.map((step) => step.title),
          work: workForPrompt,
          ...(worksPlanSlots
            ? { worksPlanSlots, worksPlanFromEarlierBrief }
            : {}),
          ...(worksPlanTooLarge ? { worksPlanTooLarge } : {}),
          today: todayInTimezone(timezone),
          timezone,
          language: context.project.language || "tr",
          country: context.project.country || "TR",
        }),
      },
      ...trimHistory(
        buildHistoryInput(context.recent, command.id, historyFiles),
        HISTORY_CHAR_BUDGET,
      ),
      // Works only: what the cards on screen say. After the history and before
      // the user input, so the history prefix stays append-only (cache).
      ...(context.cardDigestNote
        ? [{ role: "developer" as const, content: context.cardDigestNote }]
        : []),
      buildUserInput(input.message, input.attachmentBodies),
    ];

    let terminated = false;
    // An end-turn card exists: the rest of its round is answered, not run.
    let endedByCard = false;
    let stopReason: StopReason | undefined;

    // Decides whether a tool call the model made may run, and with what
    // arguments; otherwise what the model is told instead. The order matters:
    // an unavailable tool, a sensitive one after outside content, no action
    // left, unparsable arguments, and only then the checks that need the
    // arguments (a repeat, a decision that is not first).
    const admitCall = (call: {
      name: string;
      arguments: string;
    }): { refused: unknown } | { tool: ChatTool; args: unknown } => {
      const tool = toolMap.get(call.name);
      if (!tool) {
        return {
          refused: {
            error: `Unknown or currently unavailable tool "${call.name}".`,
          },
        };
      }
      if (tool.sensitive && toolCtx.tainted) {
        // This turn already read content from outside the conversation, and
        // this tool changes lasting state. Refused without running, and
        // without using up the turn's one work action.
        return {
          refused: {
            outcome: "blocked_external_content",
            note: "Not done: this message already used content from outside the conversation (a web search or stored research), and this action changes something lasting. Ask the client to confirm it in their own words in their next message.",
          },
        };
      }
      // The one-work-per-turn invariant (larger inside a work session): a work
      // call past the allowance never executes, so a turn can't create
      // duplicate tasks.
      const noAction = guard.slotBlock(tool);
      if (noAction) return { refused: { error: noAction } };
      const parsed = parseArgs(tool, call.arguments);
      if (!parsed.ok) return { refused: { error: parsed.error } };
      // Reserves the action before it runs: even if the tool throws halfway,
      // the work may already exist, so it still counts.
      const denied = guard.admit(tool, canonicalJson(parsed.value));
      if (denied) return { refused: { error: denied } };
      return { tool, args: parsed.value };
    };

    for (let round = 0; !terminated; round += 1) {
      const early = guard.beforeRound(round);
      if (early) {
        stopReason = early;
        break;
      }
      if (round > 0 && guard.inSession) {
        // Every further round of a work session's message is another model
        // call; it counts on the project's daily limit like the first one.
        try {
          await AutonomyPolicyRepository.checkAndIncrement(
            scope,
            "reasoningCalls",
          );
        } catch (error) {
          if (isAgentelseError(error) && error.code === "BUDGET_EXCEEDED") {
            stopReason = "daily";
            break;
          }
          throw error;
        }
      }

      modelRan = true;
      timing.rounds += 1;
      timing.modelStartedAt ||= Date.now();
      inFlight = "";
      let completed: Extract<ChatModelEvent, { type: "completed" }> | undefined;

      for await (const event of model.stream({
        model: modelName,
        instructions: CHAT_INSTRUCTIONS,
        input: conversation,
        tools: openaiTools,
        effort: CHAT_REASONING_EFFORT,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        signal: input.signal,
      })) {
        if (event.type === "text.delta") {
          timing.firstTokenAt ||= Date.now();
          // Text from a later round (the wrap-up after a tool ran) starts a
          // new paragraph instead of gluing onto the lead-in.
          const separator =
            inFlight === "" && replyParts.length > 0 ? "\n\n" : "";
          inFlight += event.text;
          yield { type: "text.delta", text: separator + event.text };
        } else {
          completed = event;
        }
      }

      if (inFlight.trim()) replyParts.push(inFlight.trim());
      inFlight = "";
      timing.modelEndedAt = Date.now();
      if (!completed) break;
      inputTokens += completed.inputTokens ?? 0;
      cachedInputTokens += completed.cachedInputTokens ?? 0;
      outputTokens += completed.outputTokens ?? 0;
      if (completed.functionCalls.length === 0) break;
      timing.tools.push(...completed.functionCalls.map((call) => call.name));

      // A work session's message that has used up its cost or context
      // allowance stops here, before the calls of this round run.
      const stop = guard.afterRound({
        roundInputTokens: completed.inputTokens ?? 0,
        turnCostUsd: turnCostUsd(),
      });
      if (stop) {
        stopReason = stop;
        break;
      }

      conversation.push(...completed.output);
      // OpenAI's hosted search ran inside the model turn: everything it
      // brought back is outside content.
      if (completed.output.some((item) => item.type === "web_search_call")) {
        toolCtx.tainted = true;
      }

      for (const call of completed.functionCalls) {
        if (endedByCard) {
          // `terminated` is only read by the outer round loop, so without this
          // the parallel calls of the same round would all still run.
          conversation.push({
            type: "function_call_output",
            call_id: call.callId,
            output: JSON.stringify({
              error:
                "A card is already shown for this message, so this call was not run. Do not call more tools.",
            }),
          });
          continue;
        }
        const gate = admitCall(call);
        let result: unknown;
        let outcome: ToolOutcome | undefined;

        if ("refused" in gate) {
          result = gate.refused;
        } else {
          const { tool, args } = gate;
          yield { type: "tool.start", name: tool.name, label: tool.label };
          let ok = true;
          try {
            // Run the tool, but keep forwarding events it emits while it
            // works (an image render takes a minute; the client should
            // watch it sharpen, not stare at a spinner).
            const run: {
              done: boolean;
              failed: boolean;
              value?: ToolOutcome;
              error?: unknown;
            } = { done: false, failed: false };
            tool.execute(args, toolCtx).then(
              (value) => {
                run.value = value;
                run.done = true;
                wakeStream?.();
              },
              (error: unknown) => {
                run.error = error;
                run.failed = true;
                run.done = true;
                wakeStream?.();
              },
            );
            while (!run.done) {
              while (streamQueue.length) yield streamQueue.shift()!;
              if (run.done) break;
              await new Promise<void>((resolve) => {
                wakeStream = resolve;
                // Re-check after registering: an event or completion may
                // have landed between the checks above and this line.
                if (streamQueue.length || run.done) resolve();
              });
              wakeStream = undefined;
            }
            while (streamQueue.length) yield streamQueue.shift()!;
            if (run.failed) throw run.error;
            outcome = run.value!;
            result = outcome.result;
            // The tool refused before doing anything: its work action goes
            // back, so the model's corrected retry is not answered with "one
            // action per message" (capped, see RunGuard.release).
            if (outcome.nothingDone && !outcome.card) {
              guard.release(tool, canonicalJson(args));
            }
            if (tool.external) toolCtx.tainted = true;
          } catch (error) {
            ok = false;
            // PROVIDER_UNAVAILABLE from INSIDE a tool is not "the chat has
            // no API key" (that is the chat model's own failure, handled
            // in the outer catch): it is typically the execution router
            // refusing a circuit-broken provider (e.g. openai-creative).
            // The limit card would blame a missing key and hide the
            // real cause, so such errors are reported as tool failures.
            const notice =
              isAgentelseError(error) && error.code === "PROVIDER_UNAVAILABLE"
                ? null
                : limitNoticeFromError(error);
            if (notice) {
              console.error(
                `[chat-agent] tool ${tool.name} blocked (${notice.reason}):`,
                error instanceof Error ? error.message : error,
              );
              outcome = {
                status: "ERROR",
                card: notice,
                result: {
                  outcome: "blocked",
                  explanation: limitNoticeReplyText(notice),
                },
              };
              result = outcome.result;
            } else {
              console.error(
                `[chat-agent] tool ${tool.name} failed:`,
                error instanceof Error ? error.message : error,
              );
              result = {
                error:
                  isAgentelseError(error) &&
                  error.code === "PROVIDER_UNAVAILABLE"
                    ? "The service that runs this action is temporarily unavailable on our side. Tell the client honestly that it could not run right now (not a problem with their request) and that it needs a fix on the server; do not blame their API key."
                    : "The action failed. Tell the client honestly and suggest trying again shortly.",
              };
              status = "ERROR";
            }
          }
          yield { type: "tool.end", name: tool.name, ok };
          if (outcome?.status) status = outcome.status;
          if (outcome?.card) {
            card = outcome.card;
            yield { type: "card", card: outcome.card };
          }
          if (outcome?.appendReply) appended.push(outcome.appendReply);
          if (outcome?.suggestions?.length && !card) {
            suggestionItems = outcome.suggestions;
          }
          if (outcome?.cardPersisted === true) cardPersisted = true;
          // In a Work a terminal tool's card (the wizard, a question) ends
          // the round like an end-turn card, so a later tool call of the same
          // round cannot replace it. Without a Work nothing changes.
          const endsByCard =
            !!outcome?.card &&
            (outcome.endTurn === true || (!!work && tool.kind === "terminal"));
          if (tool.kind === "terminal" || endsByCard) terminated = true;
          if (endsByCard) endedByCard = true;
          // start_work_session opened (or found) a session: from here on this
          // message runs under its allowance.
          if (sessionRef.id && !guard.inSession) {
            guard.enterSession(SESSION_LIMITS.maxSpendUsd);
          }
        }

        conversation.push({
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify(result),
        });
      }

      // suggest_replies only decorates a reply that is already written. Another
      // round would resend the whole context (~10k tokens, several seconds) just
      // to hand the model a result it has nothing to add to.
      if (
        replyParts.length > 0 &&
        completed.functionCalls.every((call) => call.name === "suggest_replies")
      ) {
        break;
      }
    }

    // A work session's message that was cut short says why, and how to go on.
    // (An ordinary message that ran out of rounds stays silent, as before.)
    if (stopReason && guard.inSession) appended.push(STOP_NOTICES[stopReason]);

    // Deterministic text the app owns (approval note, form link) goes after
    // the model's own words; streamed so the client shows what is persisted.
    for (const [index, extra] of appended.entries()) {
      const hasPrevious = replyParts.length > 0 || index > 0;
      yield {
        type: "text.delta",
        text: `${hasPrevious ? "\n\n" : ""}${extra}`,
      };
    }
    let reply = replyText();
    if (!reply) {
      reply = "Got it.";
      yield { type: "text.delta", text: reply };
    }

    // Every turn that never went through CommandService.submit still owes
    // the "command.received" audit row submit would have written.
    if (guard.workActions === 0) {
      await AuditLogRepository.record({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actorType: "USER",
        actorId: input.userId,
        action: "command.received",
        entityType: "Command",
        entityId: command.id,
        metadata: { source: "WEB", intentKind: "CHAT" },
      });
    }

    await persist(reply, status);
    settled = true;
    await recordUsage(true);
    if (suggestionItems) yield { type: "suggestions", items: suggestionItems };
    yield { type: "done", commandId: command.id, status, reply, card };
  } catch (error) {
    const cancelled =
      input.signal?.aborted ||
      (isAgentelseError(error) && error.code === "CANCELLED");

    if (cancelled) {
      // Stop pressed: keep whatever the client already saw. Nobody is
      // listening any more, so nothing is yielded.
      await persist(replyText() || "(stopped)", replyText() ? status : "ERROR");
      settled = true;
      await recordUsage(false, "cancelled by client");
      return;
    }

    const notice = limitNoticeFromError(error);
    if (notice) {
      // A recognized block (cap/budget hit, provider key missing, provider
      // rate-limited/timed out): no fallback work — it would hit the same
      // wall — just the limit-notice card explaining why.
      card = notice;
      // The card deliberately hides the cause from the client, so without
      // this the real reason (missing key vs. 401 vs. exhausted quota) would
      // be unrecoverable.
      console.error(
        `[chat-agent] blocked (${notice.reason}):`,
        error instanceof Error ? error.message : error,
      );
      const text = limitNoticeReplyText(notice);
      await persist(text, "ERROR");
      settled = true;
      await recordUsage(
        false,
        error instanceof Error ? error.message : String(error),
      );
      yield { type: "card", card: notice };
      yield { type: "error", code: "LIMIT", message: text, card: notice };
      return;
    }

    console.error(
      "[chat-agent] turn failed:",
      error instanceof Error ? error.message : error,
    );
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Nothing visible happened yet and no work exists: same last-resort as
    // the legacy engine — let the rule-based parser try to queue the work so
    // the message isn't wasted. After any tool ran we must NOT do this
    // (duplicate work), and after text streamed the fallback text would
    // contradict what the client already read.
    // (Never inside a Work: its cards own the turn, a queued rule-based task
    // would be a loose piece off the calendar.)
    if (guard.workActions === 0 && !replyText() && !input.workId) {
      try {
        const fallback = await CommandService.submit({
          workspaceId: input.workspaceId,
          source: "WEB",
          rawText: input.message,
          actorType: "USER",
          userId: input.userId,
          knownProjectId: input.projectId,
          ideaId: input.ideaId,
          attachments: input.attachments,
          existingCommandId: command.id,
        });
        const planned = fallback.status === "PLANNED";
        const text = planned
          ? "Got your request as a task. (The AI reply couldn't be generated right now, but the work was still queued.)"
          : `I can't generate a reply right now: ${errorMessage}. Please try again.`;
        await persist(text, planned ? "PLANNED" : "ERROR");
        settled = true;
        await recordUsage(false, errorMessage);
        yield { type: "text.delta", text };
        yield {
          type: "done",
          commandId: command.id,
          status: planned ? "PLANNED" : "ERROR",
          reply: text,
        };
        return;
      } catch (fallbackError) {
        console.error("[chat-agent] fallback failed:", fallbackError);
      }
    }

    const partial = replyText();
    const text =
      partial ||
      `I can't generate a reply right now: ${errorMessage}. Please try again.`;
    await persist(text, partial ? status : "ERROR");
    settled = true;
    await recordUsage(false, errorMessage);
    yield { type: "error", code: "FAILED", message: errorMessage };
  } finally {
    // The consumer stopped iterating mid-stream (connection dropped without
    // the abort signal firing first): still keep what was produced.
    if (!settled) {
      await persist(
        replyText() || "(stopped)",
        replyText() ? status : "ERROR",
      ).catch(() => undefined);
      await recordUsage(false, "consumer stopped").catch(() => undefined);
    }
  }
}

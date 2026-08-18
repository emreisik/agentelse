import type { ProviderExecutionStatus } from "@/server/execution/types";
import { detectHumanInputRequest } from "@/server/execution/providers/openclaw/openclaw-errors";
import type { OpenClawAgentResult } from "@/server/execution/providers/openclaw/openclaw-types";

export function normalizeOpenClawAgentResult(
  result: OpenClawAgentResult,
): ProviderExecutionStatus {
  if (!result.ok) {
    return {
      status: "FAILED",
      errorCode: result.status === "timeout" ? "TIMEOUT" : undefined,
      errorMessage: result.error.message,
      retryable: result.status === "timeout",
      isMock: false,
    };
  }

  const humanInputCode = detectHumanInputRequest(result.finalText);
  if (humanInputCode) {
    return {
      status: "WAITING_HUMAN",
      errorCode: humanInputCode,
      rawResult: { final: result.finalText, sessionId: result.sessionId },
      isMock: false,
    };
  }

  return {
    status: "COMPLETED",
    rawResult: {
      final: result.finalText,
      sessionId: result.sessionId,
      model: result.model,
      provider: result.provider,
      costUsd: result.costUsd,
    },
    isMock: false,
  };
}

import "server-only";

import { prisma } from "@/lib/prisma";

export type RecordReasoningCallInput = {
  workspaceId: string;
  projectId?: string;
  brandId?: string;
  purpose: string;
  model: string;
  isMock: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs: number;
  // BLOCKED: refused by the plan allowance before any model was called
  // (reasoning-service.ts). Not an error: System Health reads only ERROR.
  status: "OK" | "ERROR" | "BLOCKED";
  errorMessage?: string;
};

export const ReasoningCallRepository = {
  record(input: RecordReasoningCallInput) {
    return prisma.reasoningCall.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        purpose: input.purpose,
        model: input.model,
        isMock: input.isMock,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costUsd: input.costUsd,
        durationMs: input.durationMs,
        status: input.status,
        errorMessage: input.errorMessage,
      },
    });
  },

  listForProject(projectId: string, limit = 100) {
    return prisma.reasoningCall.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },
};

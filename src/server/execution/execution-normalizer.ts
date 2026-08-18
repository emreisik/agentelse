import type {
  ExecutionJobStatus,
  HumanInterventionInputType,
  HumanInterventionType,
} from "@prisma/client";

import type { ErrorCode } from "@/server/security/errors";
import type { ProviderExecutionStatus } from "@/server/execution/types";

const ERROR_CODE_TO_INTERVENTION: Partial<
  Record<
    ErrorCode,
    { type: HumanInterventionType; inputType: HumanInterventionInputType }
  >
> = {
  OTP_REQUIRED: { type: "OTP_REQUIRED", inputType: "OTP" },
  MFA_REQUIRED: { type: "MFA_REQUIRED", inputType: "OTP" },
  LOGIN_REQUIRED: { type: "LOGIN_REQUIRED", inputType: "MANUAL_BROWSER" },
  CAPTCHA_REQUIRED: { type: "CAPTCHA_REQUIRED", inputType: "MANUAL_BROWSER" },
  HUMAN_ACTION_REQUIRED: {
    type: "MANUAL_BROWSER_REQUIRED",
    inputType: "MANUAL_BROWSER",
  },
};

export type NormalizedExecutionOutcome = {
  jobStatus: ExecutionJobStatus;
  humanIntervention?: {
    type: HumanInterventionType;
    inputType: HumanInterventionInputType;
  };
};

// A provider claiming "completed" is not the same as Hub Connect trusting
// it — this only maps provider vocabulary to the job state machine.
// ExecutionVerification (a separate, independent check) decides whether the
// claimed outcome actually happened (spec section 45).
export function normalizeProviderStatus(
  status: ProviderExecutionStatus,
  requiresVerification: boolean,
): NormalizedExecutionOutcome {
  switch (status.status) {
    case "COMPLETED":
      return { jobStatus: requiresVerification ? "VERIFYING" : "COMPLETED" };
    case "FAILED":
      return { jobStatus: "FAILED" };
    case "WAITING_HUMAN": {
      const mapping = status.errorCode
        ? ERROR_CODE_TO_INTERVENTION[status.errorCode as ErrorCode]
        : undefined;
      return {
        jobStatus: "WAITING_HUMAN",
        humanIntervention: mapping ?? {
          type: "MANUAL_BROWSER_REQUIRED",
          inputType: "MANUAL_BROWSER",
        },
      };
    }
    case "PENDING":
    case "RUNNING":
    default:
      return { jobStatus: "RUNNING" };
  }
}

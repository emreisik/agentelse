import "server-only";

import { getEnv } from "@/lib/env";
import { AgentelseError } from "@/server/security/errors";

// Platform operator: the person who runs Agentelse itself. /health and its
// actions are platform-wide (every tenant's dead letters, provider circuit
// breakers, Meta quotas), so they belong to the operator, not to every
// workspace member (docs/meta-ads-plan.md F1). OPERATOR_USER_IDS is a
// comma-separated list of user ids.
export function operatorUserIds(): string[] {
  return getEnv()
    .OPERATOR_USER_IDS.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function isPlatformOperator(userId: string): boolean {
  return operatorUserIds().includes(userId);
}

export function requirePlatformOperator(userId: string): void {
  if (!isPlatformOperator(userId)) {
    throw new AgentelseError(
      "PERMISSION_DENIED",
      "Only the platform operator can do this.",
    );
  }
}

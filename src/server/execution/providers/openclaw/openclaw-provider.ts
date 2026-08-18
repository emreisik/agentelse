import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { BrowserProfileRepository } from "@/server/repositories/browser-profile.repository";
import { ExecutionPolicy } from "@/server/execution/execution-policy";
import { OpenClawClient } from "@/server/execution/providers/openclaw/openclaw-client";
import { normalizeOpenClawAgentResult } from "@/server/execution/providers/openclaw/openclaw-normalizer";
import type { OpenClawAgentResult } from "@/server/execution/providers/openclaw/openclaw-types";
import type {
  ExecutionAcceptedResult,
  ExecutionPolicyContext,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

// Capabilities OpenClaw's browser-capable agents can serve once a browser
// automation skill (e.g. @felipegoulu/browser-control) is installed on the
// target agent. See src/server/execution/providers/openclaw/ for the full
// integration notes.
const OPENCLAW_CAPABILITIES: ReadonlySet<CapabilityKey> =
  new Set<CapabilityKey>([
    "WEB_RESEARCH",
    "WEB_BROWSING",
    // Public-web research family — same browsing shape as WEB_RESEARCH.
    // Without these the only implementation was MockOpenClawProvider, so
    // every discovery/scan task either produced mock findings or (with the
    // mock fleet excluded) dead-lettered with PROVIDER_UNAVAILABLE.
    "BRAND_DISCOVERY",
    "SIGNAL_SCAN",
    "SEO_RESEARCH",
    "PRODUCT_RESEARCH",
    "MEDIA_RESEARCH",
    "CULTURAL_RESEARCH",
    "CREATOR_RESEARCH",
    "PARTNERSHIP_RESEARCH",
    "ADVERTISING_RESEARCH",
    "REVIEW_RESEARCH",
    "TECHNOLOGY_RESEARCH",
    "COMPETITOR_CHANGE_DETECTION",
    "MEASUREMENT_CHECK",
    "DATA_EXTRACTION",
    "SCREENSHOT_CAPTURE",
    "COMPETITOR_RESEARCH",
    "COMPETITOR_MONITORING",
    "SOCIAL_RESEARCH",
    "SOCIAL_ACCOUNT_SETUP",
    "SOCIAL_PROFILE_AUDIT",
    "INSTAGRAM_PUBLISH",
    "TIKTOK_PUBLISH",
    "LINKEDIN_PUBLISH",
    "X_PUBLISH",
    "META_ADS_ANALYSIS",
    "GOOGLE_ADS_ANALYSIS",
    "ANALYTICS_ANALYSIS",
    "VERIFY_EXTERNAL_ACTION",
  ]);

type StoredRun = { agentId: string; result: OpenClawAgentResult };

const store = new Map<string, StoredRun>();

function buildTaskPrompt(capability: CapabilityKey, payload: unknown): string {
  const input = (payload ?? {}) as Record<string, unknown>;
  const request =
    typeof input.request === "string" ? input.request : JSON.stringify(input);
  const platform =
    typeof input.platform === "string" ? ` Platform: ${input.platform}.` : "";
  return `[Agentelse task — capability: ${capability}]${platform} ${request}`;
}

export class OpenClawProvider implements ExecutionProvider {
  readonly key = "openclaw";
  readonly type: ExecutionProviderType = "OPENCLAW";
  private readonly client = new OpenClawClient();

  get isConfigured(): boolean {
    return this.client.isConfigured;
  }

  async canExecute(
    capability: CapabilityKey,
    context: ExecutionPolicyContext,
  ): Promise<boolean> {
    if (!this.isConfigured) return false;
    if (!OPENCLAW_CAPABILITIES.has(capability)) return false;
    // A profile is mandatory only where policy binds the capability to one
    // (logged-in surfaces: publishing, ad accounts, analytics). Public-web
    // research runs on the project's agent without a dedicated profile.
    if (!ExecutionPolicy.requiresBrowserProfile(capability)) return true;
    return Boolean(context.browserProfileId);
  }

  // openclaw agent --agent <id> --message ... --json is synchronous, so this
  // runs the full turn inline and caches the outcome — getStatus() below
  // just reads it back, same pattern as the mock providers use.
  async execute(request: ExecutionRequest): Promise<ExecutionAcceptedResult> {
    const agentId = await this.resolveAgentId(request.context);
    const result = await this.client.runAgentTurn({
      agentId,
      message: buildTaskPrompt(request.capability, request.payload),
      sessionKey: request.correlationId,
    });

    store.set(request.correlationId, { agentId, result });

    return { executionReference: request.correlationId, isMock: false };
  }

  async getStatus(
    executionReference: string,
  ): Promise<ProviderExecutionStatus> {
    const record = store.get(executionReference);
    if (!record) {
      return {
        status: "FAILED",
        errorMessage: "Unknown OpenClaw execution reference",
        isMock: false,
      };
    }
    return normalizeOpenClawAgentResult(record.result);
  }

  // Continues the same OpenClaw session (same sessionKey) with the human's
  // answer as the next message — this is how an OTP/2FA value actually
  // reaches the paused browser-control run.
  async resume(
    executionReference: string,
    input: { value: string },
  ): Promise<void> {
    const record = store.get(executionReference);
    if (!record) return;

    const result = await this.client.runAgentTurn({
      agentId: record.agentId,
      message: input.value,
      sessionKey: executionReference,
    });

    store.set(executionReference, { agentId: record.agentId, result });
  }

  private async resolveAgentId(
    context: ExecutionPolicyContext,
  ): Promise<string> {
    const env = getEnv();
    const fallback = env.OPENCLAW_DEFAULT_AGENT_ID;
    if (!context.browserProfileId) return fallback;

    const profile = await BrowserProfileRepository.findByIdInProject(
      context.browserProfileId,
      context.projectId,
    );
    // externalProfileId is where a BrowserProfile records its matching
    // `openclaw agents add <id>` id; the profile slug and the project slug
    // are the conventional fallbacks. Each candidate is checked against the
    // agents actually configured in OpenClaw — an unmatched id used to reach
    // the CLI and fail the whole task with `Unknown agent id "<slug>"`.
    const project = await prisma.project.findUnique({
      where: { id: context.projectId },
      select: { slug: true },
    });
    const candidates = [
      profile?.externalProfileId,
      profile?.slug,
      project?.slug,
    ].filter((id): id is string => Boolean(id));
    const [preferred] = candidates;
    if (!preferred) return fallback;

    const configured = await this.client.listAgentIds();
    // Empty set = the list could not be read; trust the candidate rather
    // than silently rerouting every project to the shared default agent.
    if (configured.size === 0) return preferred;

    return candidates.find((id) => configured.has(id)) ?? fallback;
  }
}

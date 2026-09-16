import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { BrowserProfileRepository } from "@/server/repositories/browser-profile.repository";
import { ExecutionPolicy } from "@/server/execution/execution-policy";
import { OpenClawGatewayClient } from "@/server/execution/providers/openclaw/openclaw-gateway-client";
import { normalizeOpenClawAgentResult } from "@/server/execution/providers/openclaw/openclaw-normalizer";
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

type StoredRun = { agentId: string; sessionKey: string; runId: string };

const store = new Map<string, StoredRun>();

// Renders one payload field as a "Label: value" line, or null if the field
// is absent/empty — used below to surface whatever concrete data a
// capability's planner attached (signal-universe.ts's `sources`,
// measurement-engine.ts's `postUrl`/`platformPostId`/`campaignId`, etc.)
// instead of silently dropping it.
function formatContextLine(label: string, value: unknown): string | null {
  if (Array.isArray(value)) {
    const items = value.filter(
      (item): item is string | number =>
        typeof item === "string" || typeof item === "number",
    );
    return items.length > 0 ? `${label}: ${items.join(", ")}` : null;
  }
  if (typeof value === "string")
    return value.trim() ? `${label}: ${value}` : null;
  if (typeof value === "number" || typeof value === "boolean")
    return `${label}: ${value}`;
  return null;
}

// Brand Brain's `competitors` context field (context-builder.ts) is a list
// of Competitor rows ({ name, domain, ... }) — rendered as "Name (domain)".
function formatCompetitors(brandContext: unknown): string | null {
  if (!brandContext || typeof brandContext !== "object") return null;
  const competitors = (brandContext as Record<string, unknown>).competitors;
  if (!Array.isArray(competitors) || competitors.length === 0) return null;
  const names = competitors
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const { name, domain } = entry as Record<string, unknown>;
      if (typeof name !== "string" || !name) return null;
      return typeof domain === "string" && domain
        ? `${name} (${domain})`
        : name;
    })
    .filter((name): name is string => Boolean(name));
  return names.length > 0 ? `Known competitors: ${names.join(", ")}` : null;
}

// Every field this reads is deliberately explicit rather than a generic
// dump of the whole payload: `brandContext` in particular can carry large
// nested objects (brandConstitution, recentApprovedCreatives, ...) that
// would bloat the prompt unpredictably as ContextPolicy grows — only the
// specific fields worth surfacing to the agent are pulled out here.
function buildTaskPrompt(capability: CapabilityKey, payload: unknown): string {
  const input = (payload ?? {}) as Record<string, unknown>;
  const request =
    typeof input.request === "string" ? input.request : JSON.stringify(input);
  const platform =
    typeof input.platform === "string" ? ` Platform: ${input.platform}.` : "";

  const contextLines = [
    formatContextLine("Sources to check", input.sources),
    formatContextLine("Post URL", input.postUrl),
    formatContextLine("Platform post ID", input.platformPostId),
    formatContextLine("Campaign ID", input.campaignId),
    formatCompetitors(input.brandContext),
  ].filter((line): line is string => line !== null);

  const context =
    contextLines.length > 0 ? `\nContext: ${contextLines.join(". ")}.` : "";

  // Confirmed against production (2026-09-16): given a request with real,
  // concrete names/sources but no explicit tool-use directive, this agent
  // answered in ~10s with a plausible-sounding but entirely fabricated
  // report — no web_search/browser tool call appeared in the Gateway logs
  // between the request and the reply. Concrete data alone doesn't make it
  // use its tools; it has to be told to.
  const directive =
    "\nUse your web_search/web_fetch/browser tool(s) to actually check the " +
    "above — do not answer from your own general knowledge. If a source " +
    "returns nothing or can't be reached, say so plainly rather than " +
    "inventing a plausible-sounding result.";

  return `[Agentelse task — capability: ${capability}]${platform} ${request}${context}${directive}`;
}

export class OpenClawProvider implements ExecutionProvider {
  readonly key = "openclaw";
  readonly type: ExecutionProviderType = "OPENCLAW";

  get isConfigured(): boolean {
    return OpenClawGatewayClient.isConfigured;
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

  // Non-blocking: only waits for the Gateway to ACCEPT the run (a
  // round-trip over an already-open WebSocket, not a full agent turn) —
  // unlike the old CLI-subprocess model, this does NOT block the calling
  // ExecutionWorker tick for however long the browser task takes.
  // getStatus() below is what ExecutionWorker.pollRunningJobs() then calls
  // repeatedly until a terminal Gateway event arrives.
  async execute(request: ExecutionRequest): Promise<ExecutionAcceptedResult> {
    const agentId = await this.resolveAgentId(request.context);
    const { runId } = await OpenClawGatewayClient.startAgentRun({
      agentId,
      message: buildTaskPrompt(request.capability, request.payload),
      sessionKey: request.correlationId,
      idempotencyKey: request.correlationId,
    });

    store.set(request.correlationId, {
      agentId,
      sessionKey: request.correlationId,
      runId,
    });

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

    const state = OpenClawGatewayClient.getRunState(
      record.runId,
      getEnv().OPENCLAW_TIMEOUT_SECONDS,
    );
    if (state.kind === "running") {
      return { status: "RUNNING", isMock: false };
    }
    return normalizeOpenClawAgentResult(state.result);
  }

  // Sends the human's answer as a follow-up message on the same OpenClaw
  // session (same sessionKey) — this is how an OTP/2FA value actually
  // reaches a paused browser-control run. Starts a new Gateway run against
  // that session, so the stored runId is updated to the new one; getStatus()
  // picks it up on the next poll exactly like a fresh execute() would.
  async resume(
    executionReference: string,
    input: { value: string },
  ): Promise<void> {
    const record = store.get(executionReference);
    if (!record) return;

    const { runId } = await OpenClawGatewayClient.sendFollowUp({
      agentId: record.agentId,
      sessionKey: record.sessionKey,
      message: input.value,
    });

    store.set(executionReference, { ...record, runId });
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

    const configured = await OpenClawGatewayClient.listAgentIds();
    // Empty set = the list could not be read; trust the candidate rather
    // than silently rerouting every project to the shared default agent.
    if (configured.size === 0) return preferred;

    return candidates.find((id) => configured.has(id)) ?? fallback;
  }
}

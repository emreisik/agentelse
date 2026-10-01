import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import type {
  ExecutionAcceptedResult,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

import {
  buildMockResearchFindings,
  buildMockScanSignals,
  isResearchCapability,
} from "./mock-research-results";

type MockExecutionRecord = {
  capability: CapabilityKey;
  stage: "waiting_otp" | "waiting_captcha" | "completed";
  result: Record<string, unknown>;
};

// Every result carries isMock: true and a demo-labelled payload so the UI
// never confuses this with a real research/browser action (spec section 84).
const store = new Map<string, MockExecutionRecord>();

// Publish/campaign-write capabilities are owned by MockPublishingProvider so
// the CREATE -> REVIEW -> APPROVE -> PUBLISH -> VERIFY pipeline stays
// observable as a distinct provider, matching spec section 84's 4 mocks.
const OWNED_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "BRAND_DISCOVERY",
  "WEB_RESEARCH",
  "WEB_BROWSING",
  "DATA_EXTRACTION",
  "SCREENSHOT_CAPTURE",
  "COMPETITOR_RESEARCH",
  "COMPETITOR_MONITORING",
  "COMPETITOR_CHANGE_DETECTION",
  "SOCIAL_RESEARCH",
  "SOCIAL_ACCOUNT_SETUP",
  "SOCIAL_PROFILE_AUDIT",
  "SEO_RESEARCH",
  "META_ADS_ANALYSIS",
  "GOOGLE_ADS_ANALYSIS",
  "ANALYTICS_ANALYSIS",
  "VERIFY_EXTERNAL_ACTION",
  // Agency OS deep-discovery / continuous-loop capabilities
  "PRODUCT_RESEARCH",
  "MEDIA_RESEARCH",
  "CULTURAL_RESEARCH",
  "CREATOR_RESEARCH",
  "PARTNERSHIP_RESEARCH",
  "ADVERTISING_RESEARCH",
  "REVIEW_RESEARCH",
  "TECHNOLOGY_RESEARCH",
  "SIGNAL_SCAN",
  "MEASUREMENT_CHECK",
]);

function buildMockResult(
  capability: CapabilityKey,
  payload: unknown,
): Record<string, unknown> {
  const input = (payload ?? {}) as Record<string, unknown>;
  const base: Record<string, unknown> = {
    isMock: true,
    capability,
    note: "MOCK research execution — no real browser session or web search was used.",
    input,
    screenshotUrl: "mock://screenshot/placeholder.png",
  };
  // Research capabilities return structured findings (and SIGNAL_SCAN returns
  // signals) in the shape ResultMaterializer consumes — derived from the
  // request payload, never hardcoded brand content.
  if (isResearchCapability(capability)) {
    base.findings = buildMockResearchFindings(capability, payload);
  }
  if (capability === "SIGNAL_SCAN") {
    base.signals = buildMockScanSignals(payload);
  }
  if (capability === "MEASUREMENT_CHECK") {
    base.observation = {
      checkedAt: new Date().toISOString(),
      observedState: "mock-observed",
      metrics: { impressions: 0, engagement: 0 },
    };
  }
  return base;
}

export class MockResearchProvider implements ExecutionProvider {
  readonly key = "mock-research";
  readonly type: ExecutionProviderType = "AI";
  readonly isConfigured = true;

  async canExecute(capability: CapabilityKey): Promise<boolean> {
    return OWNED_CAPABILITIES.has(capability);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionAcceptedResult> {
    const input = (request.payload ?? {}) as Record<string, unknown>;

    // Demo hook for MVP scenario 2 (section 75): creating a TikTok account
    // triggers a simulated OTP challenge so the human-intervention flow
    // can be exercised end-to-end without a real browser.
    const needsOtp =
      request.capability === "SOCIAL_ACCOUNT_SETUP" &&
      input.platform === "TIKTOK";
    const needsCaptcha = input.forceCaptcha === true;

    store.set(request.correlationId, {
      capability: request.capability,
      stage: needsOtp
        ? "waiting_otp"
        : needsCaptcha
          ? "waiting_captcha"
          : "completed",
      result: buildMockResult(request.capability, request.payload),
    });

    return { executionReference: request.correlationId, isMock: true };
  }

  async getStatus(
    executionReference: string,
  ): Promise<ProviderExecutionStatus> {
    const record = store.get(executionReference);
    if (!record) {
      return {
        status: "FAILED",
        errorMessage: "Unknown mock execution reference",
        isMock: true,
      };
    }

    if (record.stage === "waiting_otp") {
      return {
        status: "WAITING_HUMAN",
        errorCode: "OTP_REQUIRED",
        rawResult: record.result,
        isMock: true,
      };
    }
    if (record.stage === "waiting_captcha") {
      return {
        status: "WAITING_HUMAN",
        errorCode: "CAPTCHA_REQUIRED",
        rawResult: record.result,
        isMock: true,
      };
    }
    return {
      status: "COMPLETED",
      rawResult: { ...record.result, completed: true },
      isMock: true,
    };
  }

  async resume(
    executionReference: string,
    input: { value: string },
  ): Promise<void> {
    const record = store.get(executionReference);
    if (!record) return;
    record.stage = "completed";
    record.result = {
      ...record.result,
      humanProvidedValueAccepted: Boolean(input.value),
    };
  }

  async cancel(executionReference: string): Promise<void> {
    store.delete(executionReference);
  }
}

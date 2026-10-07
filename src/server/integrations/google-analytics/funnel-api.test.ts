import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildFunnelRequest } from "@/lib/website-analytics/funnel/request";

// Bu dosyanın kanıtladığı (GA-F8 huni istemcisi): gerçek modda
// GA_FUNNEL_ALPHA kapalıyken FunnelUnavailableError atılır ve ağa ve sayaca
// gidilmez; açıkken istek v1alpha adresine Bearer token ile gider; mock mod
// ağa hiç çıkmaz ve aynı girdiyle aynı yanıtı verir. Mülk kimliği adreste
// kodlanır.

const mocks = vi.hoisted(() => ({
  googleFetchJson: vi.fn(),
  recordGaApiOutcome: vi.fn(),
}));

vi.mock("@/server/integrations/google/http", () => ({
  googleFetchJson: mocks.googleFetchJson,
}));
vi.mock("@/server/website-analytics/api-counters", () => ({
  recordGaApiOutcome: mocks.recordGaApiOutcome,
}));

const { FunnelUnavailableError, runGaFunnelReport } = await import(
  "./funnel-api"
);

const request = buildFunnelRequest(
  {
    isOpen: false,
    steps: [
      { name: "Visit", kind: "event", value: "page_view" },
      { name: "Lead", kind: "event", value: "generate_lead" },
    ],
  },
  { startDate: "2026-09-09", endDate: "2026-10-06" },
);

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_AGENCY", "true");
  vi.stubEnv("GA_FUNNEL", "true");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "live");
  mocks.googleFetchJson.mockReset();
  mocks.recordGaApiOutcome.mockReset();
});

describe("runGaFunnelReport real mode", () => {
  it("refuses without the alpha kill switch and makes no call", async () => {
    vi.stubEnv("GA_FUNNEL_ALPHA", "");
    await expect(
      runGaFunnelReport("token", "123", request),
    ).rejects.toBeInstanceOf(FunnelUnavailableError);
    expect(mocks.googleFetchJson).not.toHaveBeenCalled();
    expect(mocks.recordGaApiOutcome).not.toHaveBeenCalled();
  });

  it("posts to the v1alpha URL with a Bearer token", async () => {
    vi.stubEnv("GA_FUNNEL_ALPHA", "true");
    const raw = { funnelTable: { rows: [] } };
    mocks.googleFetchJson.mockResolvedValue(raw);
    expect(await runGaFunnelReport("tok-1", "98/7", request)).toBe(raw);
    const [url, init, options] = mocks.googleFetchJson.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://analyticsdata.googleapis.com/v1alpha/properties/98%2F7:runFunnelReport",
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer tok-1" },
    });
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect(options).toEqual({ kind: "report" });
    expect(mocks.recordGaApiOutcome).toHaveBeenCalledWith("ok");
  });

  it("counts a Google error once and rethrows it", async () => {
    vi.stubEnv("GA_FUNNEL_ALPHA", "true");
    const { GoogleApiError } = await import(
      "@/server/integrations/google/errors"
    );
    const error = new GoogleApiError("busy", "RESOURCE_EXHAUSTED", {
      httpStatus: 429,
    });
    mocks.googleFetchJson.mockRejectedValue(error);
    await expect(runGaFunnelReport("t", "1", request)).rejects.toBe(error);
    expect(mocks.recordGaApiOutcome).toHaveBeenCalledWith(error.errorClass);
  });
});

describe("runGaFunnelReport mock mode", () => {
  beforeEach(() => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
  });

  it("works offline even with the kill switch off", async () => {
    vi.stubEnv("GA_FUNNEL_ALPHA", "");
    const raw = (await runGaFunnelReport("t", "123", request)) as {
      funnelTable: { rows: { dimensionValues: { value: string }[] }[] };
    };
    expect(mocks.googleFetchJson).not.toHaveBeenCalled();
    expect(raw.funnelTable.rows.map((row) => row.dimensionValues[0]?.value)).toEqual([
      "1. Visit",
      "2. Lead",
    ]);
  });

  it("is deterministic and funnel-shaped", async () => {
    const a = await runGaFunnelReport("t", "123", request);
    const b = await runGaFunnelReport("other-token", "123", request);
    expect(a).toEqual(b);
    const other = await runGaFunnelReport(
      "t",
      "123",
      buildFunnelRequest(
        {
          isOpen: false,
          steps: [
            { name: "Cart", kind: "event", value: "add_to_cart" },
            { name: "Buy", kind: "event", value: "purchase" },
          ],
        },
        { startDate: "2026-09-09", endDate: "2026-10-06" },
      ),
    );
    expect(other).not.toEqual(a);
  });
});

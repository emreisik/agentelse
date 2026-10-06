import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: günlük sağlık kontrolü kopan izni, kaybolan mülk
// erişimini ve süresi dolan bağlantıyı zamanlanmış işler bozulmadan önce
// işaretler; günde bir kez çalışır ve metadata'yı anahtar anahtar yazar.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  executeRaw: vi.fn(),
  getFreshGoogleAccessToken: vi.fn(),
  listGa4Properties: vi.fn(),
  listSearchConsoleSites: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: { findMany: mocks.findMany },
    $executeRaw: mocks.executeRaw,
  },
}));
vi.mock("@/server/integrations/google-token", () => ({
  getFreshGoogleAccessToken: mocks.getFreshGoogleAccessToken,
}));
vi.mock("@/server/integrations/google-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/integrations/google-client")
  >()),
  listGa4Properties: mocks.listGa4Properties,
  listSearchConsoleSites: mocks.listSearchConsoleSites,
}));

const { GoogleConnectionHealth, healthStateForErrorClass, isHealthCheckDue } =
  await import("./google-connection-health");
const { GoogleApiError } = await import("@/server/integrations/google/errors");

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

function gaCredential(metadata: Record<string, unknown> = {}) {
  return {
    id: "cred-ga",
    provider: "google_analytics",
    encryptedSecret: "enc",
    metadata: { selectedGa4PropertyId: "123", ...metadata },
  };
}

function writtenState(): string {
  // Etiketli şablon: değerler sırayla [json, id].
  const call = mocks.executeRaw.mock.calls[0] as unknown[];
  return JSON.parse(call[1] as string).state;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeRaw.mockResolvedValue(1);
  mocks.getFreshGoogleAccessToken.mockResolvedValue("at");
  mocks.listGa4Properties.mockResolvedValue([
    { propertyId: "123", propertyName: "Web", accountName: "Acme" },
  ]);
});

describe("pure rules", () => {
  it("maps Google error classes to connection states", () => {
    expect(healthStateForErrorClass("AUTH")).toBe("NEEDS_RECONNECT");
    expect(healthStateForErrorClass("SCOPE_MISSING")).toBe("NEEDS_PERMISSION");
    expect(healthStateForErrorClass("PERMISSION")).toBe("ACCESS_LOST");
    expect(healthStateForErrorClass("NOT_FOUND")).toBe("GONE");
    expect(healthStateForErrorClass("QUOTA_DAILY")).toBe("RATE_LIMITED");
    expect(healthStateForErrorClass("SERVER_ERROR")).toBe("CHECK_FAILED");
  });

  it("checks each connection once a day", () => {
    expect(isHealthCheckDue(undefined, NOW)).toBe(true);
    expect(
      isHealthCheckDue(
        { state: "OK", checkedAt: "2026-10-06T00:00:00.000Z" },
        NOW,
      ),
    ).toBe(false);
    expect(
      isHealthCheckDue(
        { state: "OK", checkedAt: "2026-10-05T11:00:00.000Z" },
        NOW,
      ),
    ).toBe(true);
  });
});

describe("GoogleConnectionHealth.runDue", () => {
  it("records a healthy connection", async () => {
    mocks.findMany.mockResolvedValue([gaCredential()]);
    expect(await GoogleConnectionHealth.runDue(5, NOW)).toBe(1);
    expect(writtenState()).toBe("OK");
  });

  it("flags a property the account can no longer see", async () => {
    mocks.findMany.mockResolvedValue([gaCredential()]);
    mocks.listGa4Properties.mockResolvedValue([
      { propertyId: "999", propertyName: "Other", accountName: "Acme" },
    ]);
    await GoogleConnectionHealth.runDue(5, NOW);
    expect(writtenState()).toBe("ACCESS_LOST");
  });

  it("flags a removed permission", async () => {
    mocks.findMany.mockResolvedValue([gaCredential()]);
    mocks.listGa4Properties.mockRejectedValue(
      new GoogleApiError("insufficient", "PERMISSION_DENIED", {
        httpStatus: 403,
        reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
      }),
    );
    await GoogleConnectionHealth.runDue(5, NOW);
    expect(writtenState()).toBe("NEEDS_PERMISSION");
  });

  it("skips connections checked today and respects the limit", async () => {
    mocks.findMany.mockResolvedValue([
      gaCredential({
        googleHealth: { state: "OK", checkedAt: "2026-10-06T08:00:00.000Z" },
      }),
      { ...gaCredential(), id: "cred-2" },
      { ...gaCredential(), id: "cred-3" },
    ]);
    expect(await GoogleConnectionHealth.runDue(1, NOW)).toBe(1);
    expect(mocks.getFreshGoogleAccessToken).toHaveBeenCalledTimes(1);
    expect(mocks.getFreshGoogleAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cred-2" }),
    );
  });
});

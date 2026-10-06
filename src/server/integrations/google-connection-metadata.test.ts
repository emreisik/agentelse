import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: yeniden bağlanmak (OAuth ya da "Use existing
// connection") hâlâ erişilebilen seçimi ve tarama kayıtlarını korur, artık
// görülemeyen seçimi temizler; kopma işareti ve eski token'ın sağlık kaydı
// düşer, bağlanan hesabın kimliği yazılır.

const fetchGa4PropertyList = vi.fn();
const fetchSearchConsoleSiteList = vi.fn();
vi.mock("@/server/integrations/google-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/integrations/google-client")
  >()),
  fetchGa4PropertyList,
  fetchSearchConsoleSiteList,
}));

const { buildGoogleConnectionMetadata } =
  await import("./google-connection-metadata");

const account = { connectedEmail: "owner@example.com", googleSub: "sub-1" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildGoogleConnectionMetadata", () => {
  it("keeps a property still in the list and the scan bookkeeping, drops stale marks", async () => {
    fetchGa4PropertyList.mockResolvedValue({
      ga4Properties: [
        { propertyId: "123", propertyName: "Web", accountName: "Acme" },
      ],
    });

    const metadata = await buildGoogleConnectionMetadata(
      "analytics",
      "access-token",
      account,
      {
        selectedGa4PropertyId: "123",
        selectedGa4PropertyName: "Web",
        lastAnalyticsScanAt: "2026-10-05T00:00:00.000Z",
        ga4ListError: "old failure",
        disconnectedAt: "2026-10-01T00:00:00.000Z",
        googleHealth: {
          state: "ACCESS_LOST",
          checkedAt: "2026-10-04T00:00:00.000Z",
        },
      },
    );

    expect(fetchGa4PropertyList).toHaveBeenCalledWith("access-token");
    expect(metadata).toMatchObject({
      ...account,
      selectedGa4PropertyId: "123",
      selectedGa4PropertyName: "Web",
      lastAnalyticsScanAt: "2026-10-05T00:00:00.000Z",
    });
    expect(metadata).not.toHaveProperty("disconnectedAt");
    expect(metadata).not.toHaveProperty("googleHealth");
    expect("ga4ListError" in metadata && metadata.ga4ListError).toBeFalsy();
  });

  it("clears a site the account can no longer see and keeps the list failure", async () => {
    fetchSearchConsoleSiteList.mockResolvedValue({
      searchConsoleSites: [],
      gscListError: "Search Console API is not enabled",
    });

    const metadata = await buildGoogleConnectionMetadata(
      "search_console",
      "access-token",
      account,
      { selectedSearchConsoleSite: "sc-domain:gone.com" },
    );

    expect(metadata).toMatchObject({
      ...account,
      searchConsoleSites: [],
      gscListError: "Search Console API is not enabled",
    });
    expect(
      "selectedSearchConsoleSite" in metadata &&
        metadata.selectedSearchConsoleSite,
    ).toBeFalsy();
  });
});

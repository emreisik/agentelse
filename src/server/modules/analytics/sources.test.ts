import { describe, expect, it } from "vitest";

import { sourceStatesFrom, type CredentialRow } from "./sources";

// The brief's live state follows the readers' own rules, so it never offers a
// source the report would fail to read.

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function row(
  provider: string,
  metadata: unknown,
  status = "ACTIVE",
): CredentialRow {
  return { provider, status, metadata, accountLabel: null };
}

describe("sourceStatesFrom", () => {
  it("is not connected without rows", () => {
    expect(sourceStatesFrom([], NOW)).toEqual({
      instagram: { status: "not_connected", account: null },
      metaAds: { status: "not_connected", account: null },
      ga4: { status: "not_connected", account: null },
      searchConsole: { status: "not_connected", account: null },
    });
  });

  it("is connected only with the account, ad account, property or site picked", () => {
    const states = sourceStatesFrom(
      [
        row("instagram", {
          login: "instagram",
          instagramAccount: { id: "1784", username: "biduniq" },
          pages: [],
        }),
        row("meta_ads", {
          selectedAdAccountId: "act_1",
          selectedAdAccountName: "Biduniq Ads",
          pages: [],
          adAccounts: [],
        }),
        row("google_analytics", { ga4Properties: [] }),
        row("google_search_console", {
          searchConsoleSites: [],
          selectedSearchConsoleSite: "sc-domain:biduniq.com",
        }),
      ],
      NOW,
    );
    expect(states).toEqual({
      instagram: { status: "connected", account: "@biduniq" },
      metaAds: { status: "connected", account: "Biduniq Ads" },
      ga4: { status: "setup", account: null },
      searchConsole: { status: "connected", account: "biduniq.com" },
    });
  });

  it("says when a connection expired, and ignores a switched-off one", () => {
    const states = sourceStatesFrom(
      [
        row("instagram", {
          login: "instagram",
          instagramAccount: { id: "1784" },
          pages: [],
          longLivedTokenExpiresAt: "2026-10-01T00:00:00Z",
        }),
        row("meta_ads", { selectedAdAccountId: "act_1" }, "EXPIRED"),
        row("google_analytics", { selectedGa4PropertyId: "1" }, "REVOKED"),
        row("google_search_console", null),
      ],
      NOW,
    );
    expect(states.instagram.status).toBe("expired");
    expect(states.metaAds.status).toBe("expired");
    expect(states.ga4.status).toBe("not_connected");
    expect(states.searchConsole.status).toBe("setup");
  });
});

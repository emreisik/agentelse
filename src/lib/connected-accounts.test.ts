import { describe, expect, it } from "vitest";

import {
  buildConnectedAccounts,
  type ConnectedAccountsInput,
} from "./connected-accounts";

const none: ConnectedAccountsInput = {
  instagram: { connected: false },
  facebookPage: null,
  metaAds: { connected: false },
  ga4: { linked: false, selected: false },
  searchConsole: { linked: false, selected: false },
  website: null,
  others: {},
};

const states = (input: ConnectedAccountsInput) =>
  Object.fromEntries(
    buildConnectedAccounts(input).map((a) => [a.key, a.state]),
  );

describe("buildConnectedAccounts", () => {
  it("lists the six standard accounts in the order the card shows them", () => {
    expect(buildConnectedAccounts(none).map((a) => a.label)).toEqual([
      "Instagram",
      "Facebook",
      "Meta Ads",
      "GA4",
      "Search Console",
      "Website",
    ]);
  });

  it("nothing linked: every account is off, the website too when none is set", () => {
    expect(states(none)).toEqual({
      instagram: "off",
      facebook: "off",
      "meta-ads": "off",
      ga4: "off",
      "search-console": "off",
      website: "off",
    });
  });

  it("a linked account is connected and carries its own name", () => {
    const accounts = buildConnectedAccounts({
      ...none,
      instagram: { connected: true, label: "@webhealth" },
      facebookPage: { name: "Web Health" },
      metaAds: { connected: true, label: "Web Health Ads" },
      website: "webhealth.com.tr",
    });
    expect(accounts[0]).toMatchObject({
      state: "connected",
      detail: "@webhealth",
    });
    expect(accounts[1]).toMatchObject({
      state: "connected",
      detail: "Web Health",
    });
    expect(accounts[2]).toMatchObject({
      state: "connected",
      detail: "Web Health Ads",
    });
    expect(accounts[5]).toMatchObject({
      state: "active",
      detail: "webhealth.com.tr",
    });
  });

  it("a name is never shown for an account that is not connected", () => {
    const [instagram, , metaAds] = buildConnectedAccounts({
      ...none,
      instagram: { connected: false, label: "@stale" },
      metaAds: { connected: false, label: "stale" },
    });
    expect(instagram?.detail).toBeUndefined();
    expect(metaAds?.detail).toBeUndefined();
  });

  it("Google accounts need a property / site chosen: linked without one is 'setup'", () => {
    expect(
      states({
        ...none,
        ga4: { linked: true, selected: false },
        searchConsole: {
          linked: true,
          selected: true,
          label: "sc-domain:webhealth.com.tr",
        },
      }),
    ).toMatchObject({ ga4: "setup", "search-console": "connected" });
    // Chosen but the link is gone: off, not connected.
    expect(
      states({ ...none, ga4: { linked: false, selected: true } }).ga4,
    ).toBe("off");
  });

  it("a Google connection whose sign-in lapsed is 'reconnect', not off", () => {
    const accounts = buildConnectedAccounts({
      ...none,
      searchConsole: {
        linked: false,
        selected: false,
        expired: true,
        label: "sc-domain:webhealth.com.tr",
      },
    });
    expect(accounts[4]).toMatchObject({
      key: "search-console",
      state: "reconnect",
      detail: "sc-domain:webhealth.com.tr",
    });
    expect(accounts[3]?.state).toBe("off");
  });

  it("TikTok, LinkedIn and X show up only once connected", () => {
    expect(buildConnectedAccounts(none)).toHaveLength(6);
    const accounts = buildConnectedAccounts({
      ...none,
      others: {
        tiktok: { connected: true, label: "@web" },
        linkedin: { connected: false },
        x: { connected: true },
      },
    });
    expect(accounts.slice(6).map((a) => [a.label, a.state])).toEqual([
      ["TikTok", "connected"],
      ["X", "connected"],
    ]);
  });
});

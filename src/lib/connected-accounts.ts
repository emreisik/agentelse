// The "Bağlı hesaplar" card: where the brand's accounts stand, one line each.
// Pure (the loader in src/server/integrations/connected-accounts.ts reads the
// records and hands the facts here), so the wording of each state is testable.

export const CONNECTED_ACCOUNT_KEYS = [
  "instagram",
  "facebook",
  "meta-ads",
  "ga4",
  "search-console",
  "website",
  "tiktok",
  "linkedin",
  "x",
] as const;
export type ConnectedAccountKey = (typeof CONNECTED_ACCOUNT_KEYS)[number];

// connected — linked and usable; active — the website is set (nothing to
// link); setup — linked, but a choice is missing (which GA4 property, which
// Search Console site); off — not linked.
export type ConnectedAccountState = "connected" | "active" | "setup" | "off";

export type ConnectedAccount = {
  key: ConnectedAccountKey;
  label: string;
  state: ConnectedAccountState;
  // The account's own name (@handle, page, property), when known.
  detail?: string;
};

export type ConnectedAccountsInput = {
  instagram: { connected: boolean; label?: string };
  // The Page selected in the Facebook integration; null = none.
  facebookPage: { name?: string } | null;
  metaAds: { connected: boolean; label?: string };
  ga4: { linked: boolean; selected: boolean; label?: string };
  searchConsole: { linked: boolean; selected: boolean; label?: string };
  website: string | null;
  // Shown only once connected: they are not part of the standard set.
  others: Partial<
    Record<"tiktok" | "linkedin" | "x", { connected: boolean; label?: string }>
  >;
};

const OTHER_LABEL = { tiktok: "TikTok", linkedin: "LinkedIn", x: "X" } as const;

function google(
  key: "ga4" | "search-console",
  label: string,
  account: { linked: boolean; selected: boolean; label?: string },
): ConnectedAccount {
  if (!account.linked) return { key, label, state: "off" };
  return account.selected
    ? { key, label, state: "connected", detail: account.label }
    : { key, label, state: "setup" };
}

export function buildConnectedAccounts(
  input: ConnectedAccountsInput,
): ConnectedAccount[] {
  const accounts: ConnectedAccount[] = [
    {
      key: "instagram",
      label: "Instagram",
      state: input.instagram.connected ? "connected" : "off",
      detail: input.instagram.connected ? input.instagram.label : undefined,
    },
    {
      key: "facebook",
      label: "Facebook",
      state: input.facebookPage ? "connected" : "off",
      detail: input.facebookPage?.name,
    },
    {
      key: "meta-ads",
      label: "Meta Ads",
      state: input.metaAds.connected ? "connected" : "off",
      detail: input.metaAds.connected ? input.metaAds.label : undefined,
    },
    google("ga4", "GA4", input.ga4),
    google("search-console", "Search Console", input.searchConsole),
    {
      key: "website",
      label: "Website",
      state: input.website ? "active" : "off",
      detail: input.website ?? undefined,
    },
  ];
  for (const key of ["tiktok", "linkedin", "x"] as const) {
    const other = input.others[key];
    if (other?.connected) {
      accounts.push({
        key,
        label: OTHER_LABEL[key],
        state: "connected",
        detail: other.label,
      });
    }
  }
  return accounts;
}

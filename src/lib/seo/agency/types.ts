// SC-F9 ortak tipleri (istemci güvenli: yalnız tip, değer yok).

export type SiteRole = "PRIMARY" | "SECONDARY";

export type BqBadge =
  | "OFF"
  | "DRAFT"
  | "VERIFIED"
  | "ACTIVE"
  | "PAUSED"
  | "ERROR"
  | "BUDGET";

export type ProjectSiteView = {
  linkId: string;
  siteUrl: string;
  siteLabel: string;
  role: SiteRole;
  isMock: boolean;
  health: string;
  lastFinalDate: string | null;
  backfillDone: boolean;
  bigQuery: BqBadge;
  // GscSiteLink.permissionLevel === "siteOwner"
  isOwner: boolean;
};

export type ViewedSite = {
  agency: boolean;
  sites: ProjectSiteView[];
  viewed: ProjectSiteView | null;
  isPrimaryView: boolean;
};

export type AddSiteCode =
  | "NOT_ALLOWED"
  | "NOT_CONNECTED"
  | "NOT_IN_ACCOUNT"
  | "UNVERIFIED"
  | "ALREADY_ADDED"
  | "IS_PRIMARY"
  | "LIMIT"
  | "OTHER_MODE";

export type BqCounters = {
  sources: number;
  active: number;
  error: number;
  budget: number;
  paused: number;
  periodsImported7d: number;
  bytesBilledThisMonth: number;
};

export type SplitCounters = {
  open: number;
  applied: number;
  evaluating: number;
  evaluated30d: { worked: number; didnt: number; inconclusive: number };
  expired30d: number;
};

export type ShareCounters = {
  active: number;
  created7d: number;
  viewed7d: number;
  brandedWorkspaces: number;
};

export type GscAgencyCounters = {
  extraSites: number;
  pageGroupRuleSets: number;
  bigQuery: BqCounters | null;
  splitTests: SplitCounters | null;
  shares: ShareCounters | null;
};

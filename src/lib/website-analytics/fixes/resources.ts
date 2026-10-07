// GA-F7: Analytics Admin API yazma istemcisinin kaynak türleri (yalnız tür,
// çalışma zamanı kodu yok). Parser'lar admin-parse.ts'te, istemci
// src/server/integrations/google-analytics/admin-write.ts'te.

export type GaKeyEventResource = {
  name: string;
  eventName: string;
  countingMethod: string | null;
  custom: boolean;
  deletable: boolean;
};

export type GaRetentionResource = {
  eventDataRetention: string;
  resetUserDataOnNewActivity: boolean;
};

export type GaEnhancedMeasurementResource = {
  name: string;
  streamEnabled: boolean;
  scrollsEnabled: boolean;
  outboundClicksEnabled: boolean;
  siteSearchEnabled: boolean;
  videoEngagementEnabled: boolean;
  fileDownloadsEnabled: boolean;
  formInteractionsEnabled: boolean;
  pageChangesEnabled: boolean;
  searchQueryParameter: string;
  uriQueryParameter: string | null;
};

// planFix formInteractionsEnabled'ı hiçbir zaman set etmez; tür yalnız
// alanı yazabilmek için (ör. geri alma yaması) içerir.
export type GaEnhancedMeasurementPatch = Partial<
  Pick<
    GaEnhancedMeasurementResource,
    | "streamEnabled"
    | "scrollsEnabled"
    | "outboundClicksEnabled"
    | "siteSearchEnabled"
    | "fileDownloadsEnabled"
    | "formInteractionsEnabled"
    | "searchQueryParameter"
  >
>;

export type GaChannelGroupResource = {
  name: string;
  displayName: string;
  description: string | null;
  systemDefined: boolean;
  ruleCount: number;
};

export type GaChannelGroupRule = {
  displayName: string;
  expression: {
    filter: {
      fieldName: string;
      stringFilter: {
        matchType: "PARTIAL_REGEXP" | "FULL_REGEXP" | "CONTAINS" | "EXACT";
        value: string;
      };
    };
  };
};

export type GaChannelGroupCreate = {
  displayName: string;
  description: string;
  groupingRule: GaChannelGroupRule[];
};

export type GaAnnotationResource = {
  name: string;
  title: string;
  description: string | null;
  // YYYY-MM-DD; tarih aralığı ya da eksik tarih için null.
  day: string | null;
  color: string | null;
  systemGenerated: boolean;
};

// day: YYYY-MM-DD; Google'a annotationDate {year,month,day} olarak gider.
export type GaAnnotationCreate = {
  title: string;
  description: string;
  day: string;
  color: "BLUE";
};

export type GaChangeHistoryChange = {
  resource: string;
  action: "CREATED" | "UPDATED" | "DELETED" | "UNKNOWN";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

// Eylemi yapanın e-postası bilerek taşınmaz (Limited Use): yalnız tür.
export type GaChangeHistoryEvent = {
  id: string;
  changeTime: string;
  actorType: "USER" | "SYSTEM" | "SUPPORT" | "UNKNOWN";
  changes: GaChangeHistoryChange[];
};

import type { GaAdminWriter } from "./admin-write";

// GA-F7: Analytics Admin yazma istemcisi için gerçek biçimli sabit örnekler
// (yalnız test verisi, çalışma zamanı kodu yok). Her kayıt bir yöntemin tam
// istek beklentisini (HTTP yöntemi, URL, gövde, tekrar davranışı), örnek bir
// Google yanıtını (bilinmeyen ek alanlarla), ayrıştırılmış beklenen sonucu ve
// biçim kaymış bir yanıtı taşır. "doğrulanmalı" notu olan her biçim Google'ın
// başvuru belgesinden henüz doğrulanmamıştır (docs/website-fixes.md kontrol
// listesi: v1alpha'yı açmadan önce API Explorer'da bir test mülkünde dene).

export const FX_PROPERTY = "123456789";
export const FX_STREAM = "5551212";
export const FX_ACCOUNT = "98765";
export const FX_TOKEN = "fixture-access-token";

const BETA = "https://analyticsadmin.googleapis.com/v1beta";
const ALPHA = "https://analyticsadmin.googleapis.com/v1alpha";

export type GaAdminFixture = {
  method: keyof GaAdminWriter;
  api: "v1beta" | "v1alpha";
  call: (writer: GaAdminWriter) => Promise<unknown>;
  request: {
    http: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    // null: gövde yok.
    body: unknown;
    // false: oluşturma çağrısı, 5xx'te tekrar edilmez.
    retried: boolean;
  };
  // Google'ın döndüreceği örnek gövde (DELETE için null).
  response: unknown;
  // İstemcinin döndürmesi gereken ayrıştırılmış sonuç (DELETE için undefined).
  expected: unknown;
  // Biçim kaymış gövde: çağrı UNEXPECTED_SHAPE fırlatmalı. DELETE'te yok.
  drifted: unknown;
};

const keyEventRaw = {
  name: `properties/${FX_PROPERTY}/keyEvents/11`,
  eventName: "generate_lead",
  createTime: "2026-10-06T09:00:00.123Z",
  deletable: true,
  custom: true,
  countingMethod: "ONCE_PER_EVENT",
  defaultValue: { numericValue: 5, currencyCode: "EUR" },
  futureField: { nested: true },
};
const keyEventParsed = {
  name: `properties/${FX_PROPERTY}/keyEvents/11`,
  eventName: "generate_lead",
  countingMethod: "ONCE_PER_EVENT",
  custom: true,
  deletable: true,
};

const retentionRaw = {
  name: `properties/${FX_PROPERTY}/dataRetentionSettings`,
  eventDataRetention: "FOURTEEN_MONTHS",
  resetUserDataOnNewActivity: true,
  futureField: 1,
};
const retentionParsed = {
  eventDataRetention: "FOURTEEN_MONTHS",
  resetUserDataOnNewActivity: true,
};

// doğrulanmalı: alan adları (scrollsEnabled, outboundClicksEnabled,
// siteSearchEnabled, fileDownloadsEnabled, formInteractionsEnabled,
// videoEngagementEnabled, pageChangesEnabled, searchQueryParameter,
// uriQueryParameter) v1alpha başvurusundan hatırlanan adlardır.
const enhancedPath = `properties/${FX_PROPERTY}/dataStreams/${FX_STREAM}/enhancedMeasurementSettings`;
const enhancedRaw = {
  name: enhancedPath,
  streamEnabled: true,
  scrollsEnabled: true,
  outboundClicksEnabled: true,
  siteSearchEnabled: true,
  videoEngagementEnabled: false,
  fileDownloadsEnabled: true,
  formInteractionsEnabled: false,
  pageChangesEnabled: false,
  searchQueryParameter: "q,s,search,query,keyword",
  uriQueryParameter: "utm_term",
  futureField: "x",
};
const enhancedParsed = {
  name: enhancedPath,
  streamEnabled: true,
  scrollsEnabled: true,
  outboundClicksEnabled: true,
  siteSearchEnabled: true,
  videoEngagementEnabled: false,
  fileDownloadsEnabled: true,
  formInteractionsEnabled: false,
  pageChangesEnabled: false,
  searchQueryParameter: "q,s,search,query,keyword",
  uriQueryParameter: "utm_term",
};
// Kayma: yanıt tek bir ek sarmalayıcı altında geliyor (name üst düzeyde yok).
const enhancedDrift = { enhancedMeasurementSettings: enhancedRaw };

// doğrulanmalı: kanal grubu kuralındaki fieldName ('eachScopeSource') ve
// stringFilter/matchType biçimi.
const channelGroupBody = {
  displayName: "AI assistants",
  description: "Visits from AI assistants",
  groupingRule: [
    {
      displayName: "AI assistants",
      expression: {
        filter: {
          fieldName: "eachScopeSource",
          stringFilter: {
            matchType: "PARTIAL_REGEXP" as const,
            value: "chatgpt\\.com|perplexity\\.ai",
          },
        },
      },
    },
  ],
};
const channelGroupRaw = {
  name: `properties/${FX_PROPERTY}/channelGroups/7`,
  displayName: "AI assistants",
  description: "Visits from AI assistants",
  groupingRule: channelGroupBody.groupingRule,
  systemDefined: false,
  primary: false,
  futureField: [1, 2],
};
const channelGroupParsed = {
  name: `properties/${FX_PROPERTY}/channelGroups/7`,
  displayName: "AI assistants",
  description: "Visits from AI assistants",
  systemDefined: false,
  ruleCount: 1,
};

// doğrulanmalı: not başlığı sınırı ve renk enum'u (BLUE), annotationDate biçimi.
const annotationRaw = {
  name: `properties/${FX_PROPERTY}/reportingDataAnnotations/3`,
  title: "Agentelse: autumn sale launched",
  description: "Added by Agentelse",
  color: "BLUE",
  systemGenerated: false,
  annotationDate: { year: 2026, month: 10, day: 6 },
  futureField: null,
};
const annotationParsed = {
  name: `properties/${FX_PROPERTY}/reportingDataAnnotations/3`,
  title: "Agentelse: autumn sale launched",
  description: "Added by Agentelse",
  day: "2026-10-06",
  color: "BLUE",
  systemGenerated: false,
};

// doğrulanmalı: searchChangeHistoryEvents yanıt biçimi (resource, action,
// resourceBeforeChange/resourceAfterChange sarmalayıcıları; keyEvent mi
// conversionEvent mi döndüğü) ve actor alanları. userActorEmail ayrıştırmada
// atılır.
const historyRaw = {
  changeHistoryEvents: [
    {
      id: "4801",
      changeTime: "2026-10-06T08:30:00Z",
      actorType: "USER",
      userActorEmail: "owner@example.com",
      changesFiltered: false,
      changes: [
        {
          resource: `properties/${FX_PROPERTY}/keyEvents/2`,
          action: "DELETED",
          resourceBeforeChange: {
            keyEvent: { name: `properties/${FX_PROPERTY}/keyEvents/2`, eventName: "generate_lead" },
          },
        },
      ],
    },
  ],
  nextPageToken: "100",
};
const historyParsed = {
  events: [
    {
      id: "4801",
      changeTime: "2026-10-06T08:30:00Z",
      actorType: "USER" as const,
      changes: [
        {
          resource: `properties/${FX_PROPERTY}/keyEvents/2`,
          action: "DELETED" as const,
          before: {
            keyEvent: {
              name: `properties/${FX_PROPERTY}/keyEvents/2`,
              eventName: "generate_lead",
            },
          },
          after: null,
        },
      ],
    },
  ],
  nextPageToken: "100",
};

export const EARLIEST = new Date("2026-10-05T00:00:00.000Z");
export const LATEST = new Date("2026-10-06T12:00:00.000Z");

export const GA_ADMIN_FIXTURES: GaAdminFixture[] = [
  {
    method: "listKeyEvents",
    api: "v1beta",
    call: (w) => w.listKeyEvents(FX_PROPERTY),
    request: {
      http: "GET",
      url: `${BETA}/properties/${FX_PROPERTY}/keyEvents?pageSize=200`,
      body: null,
      retried: true,
    },
    response: { keyEvents: [keyEventRaw], nextPageToken: "" },
    expected: [keyEventParsed],
    drifted: { keyEvents: [{ eventName: "generate_lead" }] },
  },
  {
    method: "createKeyEvent",
    api: "v1beta",
    call: (w) => w.createKeyEvent(FX_PROPERTY, "generate_lead"),
    request: {
      http: "POST",
      url: `${BETA}/properties/${FX_PROPERTY}/keyEvents`,
      body: { eventName: "generate_lead", countingMethod: "ONCE_PER_EVENT" },
      retried: false,
    },
    response: keyEventRaw,
    expected: keyEventParsed,
    drifted: { keyEvent: keyEventRaw },
  },
  {
    method: "deleteKeyEvent",
    api: "v1beta",
    call: (w) => w.deleteKeyEvent(`properties/${FX_PROPERTY}/keyEvents/11`),
    request: {
      http: "DELETE",
      url: `${BETA}/properties/${FX_PROPERTY}/keyEvents/11`,
      body: null,
      retried: true,
    },
    response: {},
    expected: undefined,
    drifted: null,
  },
  {
    method: "getDataRetention",
    api: "v1beta",
    call: (w) => w.getDataRetention(FX_PROPERTY),
    request: {
      http: "GET",
      url: `${BETA}/properties/${FX_PROPERTY}/dataRetentionSettings`,
      body: null,
      retried: true,
    },
    response: retentionRaw,
    expected: retentionParsed,
    drifted: { name: retentionRaw.name, retention: "FOURTEEN_MONTHS" },
  },
  {
    method: "updateDataRetention",
    api: "v1beta",
    call: (w) => w.updateDataRetention(FX_PROPERTY, "FOURTEEN_MONTHS"),
    request: {
      http: "PATCH",
      url: `${BETA}/properties/${FX_PROPERTY}/dataRetentionSettings?updateMask=eventDataRetention`,
      body: { eventDataRetention: "FOURTEEN_MONTHS" },
      retried: true,
    },
    response: retentionRaw,
    expected: retentionParsed,
    drifted: {},
  },
  {
    method: "getEnhancedMeasurement",
    api: "v1alpha",
    call: (w) => w.getEnhancedMeasurement(FX_PROPERTY, FX_STREAM),
    request: {
      http: "GET",
      url: `${ALPHA}/${enhancedPath}`,
      body: null,
      retried: true,
    },
    response: enhancedRaw,
    expected: enhancedParsed,
    drifted: enhancedDrift,
  },
  {
    method: "updateEnhancedMeasurement",
    api: "v1alpha",
    // İstek anahtarları bilerek karışık sırada verilir: updateMask sabit sırada olmalı.
    call: (w) =>
      w.updateEnhancedMeasurement(FX_PROPERTY, FX_STREAM, {
        searchQueryParameter: "q,s,search,query,keyword",
        fileDownloadsEnabled: true,
        scrollsEnabled: true,
        siteSearchEnabled: true,
      }),
    request: {
      http: "PATCH",
      url: `${ALPHA}/${enhancedPath}?updateMask=scrollsEnabled,siteSearchEnabled,fileDownloadsEnabled,searchQueryParameter`,
      body: {
        scrollsEnabled: true,
        siteSearchEnabled: true,
        fileDownloadsEnabled: true,
        searchQueryParameter: "q,s,search,query,keyword",
      },
      retried: true,
    },
    response: enhancedRaw,
    expected: enhancedParsed,
    drifted: enhancedDrift,
  },
  {
    method: "listChannelGroups",
    api: "v1alpha",
    call: (w) => w.listChannelGroups(FX_PROPERTY),
    request: {
      http: "GET",
      url: `${ALPHA}/properties/${FX_PROPERTY}/channelGroups?pageSize=200`,
      body: null,
      retried: true,
    },
    response: { channelGroups: [channelGroupRaw] },
    expected: [channelGroupParsed],
    drifted: { channelGroups: "none" },
  },
  {
    method: "createChannelGroup",
    api: "v1alpha",
    call: (w) => w.createChannelGroup(FX_PROPERTY, channelGroupBody),
    request: {
      http: "POST",
      url: `${ALPHA}/properties/${FX_PROPERTY}/channelGroups`,
      body: channelGroupBody,
      retried: false,
    },
    response: channelGroupRaw,
    expected: channelGroupParsed,
    drifted: { channelGroup: channelGroupRaw },
  },
  {
    method: "deleteChannelGroup",
    api: "v1alpha",
    call: (w) => w.deleteChannelGroup(`properties/${FX_PROPERTY}/channelGroups/7`),
    request: {
      http: "DELETE",
      url: `${ALPHA}/properties/${FX_PROPERTY}/channelGroups/7`,
      body: null,
      retried: true,
    },
    response: {},
    expected: undefined,
    drifted: null,
  },
  {
    method: "listAnnotations",
    api: "v1alpha",
    call: (w) => w.listAnnotations(FX_PROPERTY),
    request: {
      http: "GET",
      url: `${ALPHA}/properties/${FX_PROPERTY}/reportingDataAnnotations?pageSize=200`,
      body: null,
      retried: true,
    },
    response: { reportingDataAnnotations: [annotationRaw] },
    expected: [annotationParsed],
    drifted: { reportingDataAnnotations: [{ title: "no name" }] },
  },
  {
    method: "createAnnotation",
    api: "v1alpha",
    call: (w) =>
      w.createAnnotation(FX_PROPERTY, {
        title: "Agentelse: autumn sale launched",
        description: "Added by Agentelse",
        day: "2026-10-06",
        color: "BLUE",
      }),
    request: {
      http: "POST",
      url: `${ALPHA}/properties/${FX_PROPERTY}/reportingDataAnnotations`,
      body: {
        title: "Agentelse: autumn sale launched",
        description: "Added by Agentelse",
        color: "BLUE",
        annotationDate: { year: 2026, month: 10, day: 6 },
      },
      retried: false,
    },
    response: annotationRaw,
    expected: annotationParsed,
    drifted: { annotation: annotationRaw },
  },
  {
    method: "deleteAnnotation",
    api: "v1alpha",
    call: (w) =>
      w.deleteAnnotation(`properties/${FX_PROPERTY}/reportingDataAnnotations/3`),
    request: {
      http: "DELETE",
      url: `${ALPHA}/properties/${FX_PROPERTY}/reportingDataAnnotations/3`,
      body: null,
      retried: true,
    },
    response: {},
    expected: undefined,
    drifted: null,
  },
  {
    method: "searchChangeHistory",
    api: "v1beta",
    call: (w) =>
      w.searchChangeHistory({
        accountId: FX_ACCOUNT,
        propertyId: FX_PROPERTY,
        earliest: EARLIEST,
        latest: LATEST,
        pageToken: "0",
        pageSize: 500,
      }),
    request: {
      http: "POST",
      url: `${BETA}/accounts/${FX_ACCOUNT}:searchChangeHistoryEvents`,
      body: {
        property: `properties/${FX_PROPERTY}`,
        earliestChangeTime: "2026-10-05T00:00:00.000Z",
        latestChangeTime: "2026-10-06T12:00:00.000Z",
        pageSize: 200,
        pageToken: "0",
      },
      retried: true,
    },
    response: historyRaw,
    expected: historyParsed,
    drifted: { changeHistoryEvents: { id: "4801" } },
  },
];

import { MetaApiError } from "./errors";

// Meta hata kataloğu (docs/meta-ads-plan.md §3.6). Tek karar kaynağı koddur:
// alt kod önce, sonra kod, sonra çağrı ailesi. Mesaj metnine bakılmaz.

export type MetaErrorClass =
  | "TRANSIENT"
  | "RATE_LIMIT"
  | "CHANGE_LIMIT"
  | "VOLUME_LIMIT"
  | "AUTH"
  | "PERMISSION"
  | "APP_ACCESS"
  | "VALIDATION"
  | "POLICY"
  | "ACCOUNT"
  | "STATE"
  | "CREATIVE_SOURCE_GONE"
  | "TERMS_REQUIRED"
  | "INSIGHTS_SIZE"
  | "VERSION"
  | "UNKNOWN";

// Çağrının ait olduğu aile: aynı kod ailesine göre farklı anlama gelir
// (ör. insights'ta kod 1 "veriyi azalt" demektir).
export type MetaCallFamily = "ads_management" | "ads_insights" | "graph";

// Otomatik davranış: kısa tekrar yalnız okumada ve yalnız TRANSIENT'te.
export type MetaErrorAction =
  | "RETRY_READ" // okumada kısa tekrar; yazmada önce uzlaştırma
  | "WAIT_FOR_RESET" // kota: blok süresi kadar bekle, kısa tekrar yok
  | "DEFER" // değişiklik sınırı: sonraki saate/güne ertele
  | "STOP_CREATES" // yalnız yeni reklam oluşturma durur
  | "RECONNECT" // bağlantı EXPIRED, kullanıcı yeniden bağlanır
  | "FIX_INPUT" // tekrar yok; spec düzeltilir
  | "STOP_AND_NOTIFY" // yazma durur, kullanıcı/operatör uyarılır
  | "REFRESH_STATE" // ayna yenilenir, karar SUPERSEDED
  | "SPLIT_RANGE" // insights: aralık bölünür
  | "OPERATOR"; // operatör alarmı

export type MetaErrorClassification = {
  class: MetaErrorClass;
  action: MetaErrorAction;
  // Kullanıcıya gösterilecek İngilizce metin (Meta'nın kendi metni yoksa).
  userMessage: string;
  // Global `meta-api` sağlığını düşürür mü? Yalnız Meta genelindeki geçici
  // arızalar; kiracıya özgü hatalar (yetki, doğrulama, hesap) hesap düzeyinde
  // kalır.
  degradesProvider: boolean;
};

const SUBCODE_CLASS: Readonly<Record<number, MetaErrorClass>> = {
  1504043: "TRANSIENT",
  2490547: "TRANSIENT",
  1504022: "RATE_LIMIT",
  1504039: "RATE_LIMIT",
  2446079: "RATE_LIMIT",
  1487742: "RATE_LIMIT",
  5044001: "RATE_LIMIT",
  1487632: "CHANGE_LIMIT",
  1885172: "CHANGE_LIMIT",
  1487225: "VOLUME_LIMIT",
  458: "AUTH",
  459: "AUTH",
  460: "AUTH",
  463: "AUTH",
  464: "AUTH",
  467: "AUTH",
  492: "PERMISSION",
  3191001: "PERMISSION",
  1815199: "PERMISSION",
  1885183: "APP_ACCESS",
  1885272: "VALIDATION",
  1885650: "VALIDATION",
  1885621: "VALIDATION",
  2446307: "VALIDATION",
  4834011: "VALIDATION",
  2446383: "VALIDATION",
  2446509: "VALIDATION",
  1815946: "VALIDATION",
  1487694: "VALIDATION",
  2446394: "VALIDATION",
  3858082: "VALIDATION",
  3858152: "VALIDATION",
  3858634: "VALIDATION",
  3858636: "VALIDATION",
  1340029: "VALIDATION",
  1870165: "VALIDATION",
  1885204: "VALIDATION",
  1885029: "VALIDATION",
  2490155: "CREATIVE_SOURCE_GONE",
  2446289: "CREATIVE_SOURCE_GONE",
  1487472: "CREATIVE_SOURCE_GONE",
  1885557: "CREATIVE_SOURCE_GONE",
  2859024: "TERMS_REQUIRED",
  1870090: "TERMS_REQUIRED",
  1870092: "TERMS_REQUIRED",
  1870034: "TERMS_REQUIRED",
  1404078: "POLICY",
  2859015: "POLICY",
  1404163: "POLICY",
  2490427: "POLICY",
  2490468: "POLICY",
  2708008: "POLICY",
  2446880: "ACCOUNT",
  1487007: "STATE",
  1487033: "STATE",
  1487056: "STATE",
  1487566: "STATE",
  1885088: "STATE",
  1487990: "STATE",
  // 100/33: nesne yok (ya da erişim yok). Çağıran ebeveyni okuyarak ayırır;
  // varsayılan STATE (aynada `goneAt`).
  33: "STATE",
  1487534: "INSIGHTS_SIZE",
  1504018: "INSIGHTS_SIZE",
  1504038: "INSIGHTS_SIZE",
  1504045: "INSIGHTS_SIZE",
  1504041: "INSIGHTS_SIZE",
};

function classOfCode(code: number, family: MetaCallFamily): MetaErrorClass {
  if (code === 1)
    return family === "ads_insights" ? "INSIGHTS_SIZE" : "TRANSIENT";
  if (code === 2 || code === -2 || code === 3910001) return "TRANSIENT";
  if (code === 4 || code === 17 || code === 32 || code === 613) {
    return "RATE_LIMIT";
  }
  if (code >= 80000 && code <= 80014) return "RATE_LIMIT";
  if (code === 102 || code === 190) return "AUTH";
  if (code === 270 || code === 272) return "APP_ACCESS";
  if (
    code === 3 ||
    code === 10 ||
    code === 294 ||
    (code >= 200 && code <= 299)
  ) {
    return "PERMISSION";
  }
  if (code === 368) return "POLICY";
  if (code === 2635) return "VERSION";
  if (code === 100) return "VALIDATION";
  return "UNKNOWN";
}

const CLASS_DEFAULTS: Readonly<
  Record<
    MetaErrorClass,
    { action: MetaErrorAction; userMessage: string; degradesProvider: boolean }
  >
> = {
  TRANSIENT: {
    action: "RETRY_READ",
    userMessage: "Meta is having a temporary problem. We'll try again shortly.",
    degradesProvider: true,
  },
  RATE_LIMIT: {
    action: "WAIT_FOR_RESET",
    userMessage: "Meta asked us to slow down. Updates resume in a few minutes.",
    degradesProvider: false,
  },
  CHANGE_LIMIT: {
    action: "DEFER",
    userMessage:
      "Meta limits how often this can change. It's scheduled for later.",
    degradesProvider: false,
  },
  VOLUME_LIMIT: {
    action: "STOP_CREATES",
    userMessage:
      "This ad account reached Meta's limit for ads. Archive old ads to add new ones.",
    degradesProvider: false,
  },
  AUTH: {
    action: "RECONNECT",
    userMessage: "Reconnect Meta Ads: your connection expired.",
    degradesProvider: false,
  },
  PERMISSION: {
    action: "STOP_AND_NOTIFY",
    userMessage:
      "Agentelse doesn't have permission to manage this ad account. Reconnect and allow it.",
    degradesProvider: false,
  },
  APP_ACCESS: {
    action: "OPERATOR",
    userMessage: "Meta hasn't approved Agentelse for this yet.",
    degradesProvider: false,
  },
  VALIDATION: {
    action: "FIX_INPUT",
    userMessage:
      "Meta didn't accept these settings. Check the highlighted field.",
    degradesProvider: false,
  },
  POLICY: {
    action: "STOP_AND_NOTIFY",
    userMessage:
      "Meta blocked this for policy reasons. Review Account Quality in Meta.",
    degradesProvider: false,
  },
  ACCOUNT: {
    action: "STOP_AND_NOTIFY",
    userMessage:
      "Your ad account can't run ads right now. Check its status and payment in Meta.",
    degradesProvider: false,
  },
  STATE: {
    action: "REFRESH_STATE",
    userMessage:
      "This campaign has ended, was archived or no longer exists in Meta.",
    degradesProvider: false,
  },
  CREATIVE_SOURCE_GONE: {
    action: "FIX_INPUT",
    userMessage:
      "The post behind this ad is gone or can't be promoted. Pick another post.",
    degradesProvider: false,
  },
  TERMS_REQUIRED: {
    action: "STOP_AND_NOTIFY",
    userMessage: "Accept Meta's terms for this feature to continue.",
    degradesProvider: false,
  },
  INSIGHTS_SIZE: {
    action: "SPLIT_RANGE",
    userMessage:
      "Meta returned too much data at once. Reading it in smaller parts.",
    degradesProvider: false,
  },
  VERSION: {
    action: "OPERATOR",
    userMessage: "Something went wrong at Meta.",
    degradesProvider: false,
  },
  UNKNOWN: {
    action: "STOP_AND_NOTIFY",
    userMessage: "Something went wrong at Meta.",
    degradesProvider: false,
  },
};

export function classifyMetaError(
  error: unknown,
  family: MetaCallFamily = "ads_management",
): MetaErrorClassification {
  if (!(error instanceof MetaApiError)) {
    return { class: "UNKNOWN", ...CLASS_DEFAULTS.UNKNOWN };
  }
  const code = error.metaErrorCode;
  const subcode = error.metaErrorSubcode;
  const httpStatus = error.details.httpStatus;

  let klass: MetaErrorClass = "UNKNOWN";
  if (subcode !== undefined && SUBCODE_CLASS[subcode]) {
    klass = SUBCODE_CLASS[subcode]!;
    // 200/1870034 is terms; 190/492 a missing Page role (not an expired token).
  } else if (code !== undefined) {
    klass = classOfCode(code, family);
  } else if (httpStatus === undefined || httpStatus >= 500) {
    // Ağ hatası ya da 5xx: Meta'ya ulaşılamadı.
    klass = "TRANSIENT";
  }
  if (klass === "UNKNOWN" && error.details.isTransient) klass = "TRANSIENT";

  const defaults = CLASS_DEFAULTS[klass];
  return {
    class: klass,
    action: defaults.action,
    userMessage: defaults.userMessage,
    degradesProvider: defaults.degradesProvider,
  };
}

// Kullanıcıya gösterilecek metin: Meta'nın kendi açıklaması varsa o, yoksa
// katalog metni ve iz için fbtrace_id.
export function metaUserMessage(error: unknown): string {
  const classification = classifyMetaError(error);
  if (error instanceof MetaApiError) {
    if (error.details.userMessage) return error.details.userMessage;
    if (classification.class === "UNKNOWN" && error.details.fbtraceId) {
      return `${classification.userMessage} (ref: ${error.details.fbtraceId})`;
    }
  }
  return classification.userMessage;
}

// ExecutionJob.errorCode için yapısal kod: "META:VALIDATION:100/1885272".
// Sağlayıcı sağlığı (provider-health.service.ts) bunu okur.
export function metaErrorCode(error: unknown): string | undefined {
  if (!(error instanceof MetaApiError)) return undefined;
  const { class: klass } = classifyMetaError(error);
  const code = error.metaErrorCode ?? "net";
  return `META:${klass}:${code}${error.metaErrorSubcode ? `/${error.metaErrorSubcode}` : ""}`;
}

export function parseMetaErrorCode(
  errorCode: string | null | undefined,
): MetaErrorClass | null {
  if (!errorCode?.startsWith("META:")) return null;
  const klass = errorCode.split(":")[1] as MetaErrorClass | undefined;
  return klass && klass in CLASS_DEFAULTS ? klass : null;
}

export function metaClassDegradesProvider(klass: MetaErrorClass): boolean {
  return CLASS_DEFAULTS[klass].degradesProvider;
}

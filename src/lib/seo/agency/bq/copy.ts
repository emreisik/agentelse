import {
  BQ_ERROR_TEXT,
  type BqErrorCode,
} from "@/server/integrations/google/bigquery/errors";

// BigQuery dışa aktarımının sabit İngilizce metinleri ve doğrulama tipleri
// (docs/search-agency.md). Ham Google/BigQuery mesajı hiçbir yerde saklanmaz
// ya da gösterilmez; kullanıcıya yalnız bu metinler gider.

export type BqSourceErrorCode =
  | BqErrorCode
  | "NOT_OWNER"
  | "SITE_MISMATCH"
  | "NO_EXPORT_DATA"
  | "EXPORT_LATE"
  | "PERIOD_TOO_BIG";

export const BQ_SOURCE_ERROR_TEXT: Readonly<Record<BqSourceErrorCode, string>> =
  {
    ...BQ_ERROR_TEXT,
    NOT_OWNER:
      "Only the Search Console property owner can connect a BigQuery export.",
    SITE_MISMATCH: "The export tables don't contain this Search Console property.",
    NO_EXPORT_DATA:
      "The export tables are empty. The first data usually appears within 48 hours after you turn the export on in Search Console.",
    EXPORT_LATE:
      "The export hasn't delivered new data for several days. Check the export in Search Console.",
    PERIOD_TOO_BIG:
      "A weekly import is larger than your per-query cap. Raise the cap to import it.",
  };

const BQ_SOURCE_ERROR_CODES = Object.keys(
  BQ_SOURCE_ERROR_TEXT,
) as BqSourceErrorCode[];

export function isBqSourceErrorCode(value: unknown): value is BqSourceErrorCode {
  return (
    typeof value === "string" &&
    (BQ_SOURCE_ERROR_CODES as string[]).includes(value)
  );
}

export const BQ_SETUP_STEPS: readonly string[] = [
  "In Search Console open Settings, then Bulk data export. Choose your Google Cloud project and a dataset. Only the property owner can do this.",
  "In Google Cloud grant the Agentelse service account BigQuery Data Viewer on that dataset and BigQuery Job User on the project.",
  "Billing must be enabled on the Cloud project. Queries run in your project and are billed to it; the cost cap below limits them.",
  "The export starts on the day you turn it on. Older history stays from the Search Console API.",
];

export const BQ_REMOVE_NOTE =
  "Imported numbers stay until you delete stored data or disconnect Search Console.";

export type BqVerifyStepKey =
  | "ownership"
  | "service_account"
  | "dataset"
  | "tables"
  | "site_match"
  | "export_data"
  | "cost_estimate"
  | "reconcile";

export type BqVerifyStep = {
  key: BqVerifyStepKey;
  label: string;
  state: "ok" | "warn" | "fail" | "skipped";
  detail: string | null;
};

export type BqVerifyResult = {
  ok: boolean;
  steps: BqVerifyStep[];
  errorCode: BqSourceErrorCode | null;
};

export const BQ_VERIFY_STEP_LABEL: Readonly<Record<BqVerifyStepKey, string>> = {
  ownership: "You own this Search Console property",
  service_account: "Service account is ready",
  dataset: "Dataset is readable",
  tables: "Export tables exist",
  export_data: "Export has data",
  site_match: "Export contains this property",
  cost_estimate: "Cost estimate",
  reconcile: "Numbers match the Search Console API",
};

export const BQ_VERIFY_STEP_KEYS: readonly BqVerifyStepKey[] = [
  "ownership",
  "service_account",
  "dataset",
  "tables",
  "site_match",
  "export_data",
  "cost_estimate",
  "reconcile",
];

// Kısa kullanıcı iletileri (eylemler ve görünüm).
export const BQ_MESSAGE = {
  notAllowed: "BigQuery export isn't available for this project here.",
  managersOnly: "Only workspace owners and admins can change this.",
  noSite: "This Search Console site wasn't found for the project.",
  invalidProject: "Enter a valid Google Cloud project ID.",
  invalidDataset: "Enter a valid BigQuery dataset name.",
  invalidCap: "Choose one of the listed cost caps.",
  notVerified: "Verify the export first (within the last 24 hours).",
  rateLimited: "Too many checks. Try again in a few minutes.",
  failed: "Something went wrong. Try again in a few minutes.",
  notSetUp: "Set up the BigQuery export first.",
  budgetUsed: "The monthly budget is used up. Raise it or wait for next month.",
  checkFailed: "The check couldn't run. Try again in a few minutes.",
} as const;

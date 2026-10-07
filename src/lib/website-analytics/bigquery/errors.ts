// BigQuery hatalarının GA tarafı kodları ve sabit İngilizce iletileri (GA-F8).
// Saf modül. Google'ın ham hata metni asla kullanıcıya ya da loga gitmez.

export type GaBigQueryErrorCode =
  | "not_configured"
  | "not_shared"
  | "dataset_not_found"
  | "no_export_tables"
  | "bytes_limit"
  | "budget"
  | "billing"
  | "auth"
  | "quota"
  | "invalid_query"
  | "unavailable";

// SC-F9 BqErrorCode → GA kodu (bilinmeyen her şey 'unavailable').
export function gaBigQueryErrorOf(code: string): GaBigQueryErrorCode {
  switch (code) {
    case "NOT_CONFIGURED":
      return "not_configured";
    case "SA_AUTH":
      return "auth";
    case "NO_ACCESS":
      return "not_shared";
    case "NOT_FOUND":
      return "dataset_not_found";
    case "BILLING_DISABLED":
      return "billing";
    case "COST_CAP":
      return "bytes_limit";
    case "RATE_LIMIT":
      return "quota";
    case "INVALID_REQUEST":
    case "INVALID_QUERY":
      return "invalid_query";
    default:
      return "unavailable";
  }
}

export function gaBigQueryMessage(
  code: GaBigQueryErrorCode,
  serviceAccountEmail: string | null,
): string {
  switch (code) {
    case "not_configured":
      return "BigQuery isn't set up on this Agentelse server yet.";
    case "not_shared": {
      const who = serviceAccountEmail ?? "the Agentelse service account";
      return `Agentelse can't read that dataset yet. Give ${who} the BigQuery Data Viewer role on it and BigQuery Job User on the same project.`;
    }
    case "dataset_not_found":
      return "We couldn't find that dataset. Check the project id and that the BigQuery link is on in Google Analytics.";
    case "no_export_tables":
      return "The dataset has no daily export tables yet. They appear about a day after you link BigQuery in Google Analytics.";
    case "bytes_limit":
      return "This export is larger than the amount Agentelse is allowed to read in one go.";
    case "budget":
      return "This month's BigQuery read budget is used up. Reading continues next month.";
    case "billing":
      return "Billing isn't enabled on that Google Cloud project, so BigQuery can't run queries.";
    case "auth":
      return "Agentelse couldn't sign in to BigQuery. We'll try again later.";
    case "quota":
      return "BigQuery is limiting requests right now. Agentelse will try again later.";
    case "invalid_query":
      return "Agentelse couldn't read this dataset. It doesn't look like a Google Analytics 4 export.";
    case "unavailable":
      return "BigQuery isn't available right now. Agentelse will try again later.";
  }
}

// Kaynak satırında saklanan lastError değeri tanınan bir kod mu?
const CODES: ReadonlySet<string> = new Set<GaBigQueryErrorCode>([
  "not_configured",
  "not_shared",
  "dataset_not_found",
  "no_export_tables",
  "bytes_limit",
  "budget",
  "billing",
  "auth",
  "quota",
  "invalid_query",
  "unavailable",
]);

export function isGaBigQueryErrorCode(
  value: string | null | undefined,
): value is GaBigQueryErrorCode {
  return typeof value === "string" && CODES.has(value);
}

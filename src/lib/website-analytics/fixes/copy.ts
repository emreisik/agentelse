import type { GoogleErrorClass } from "@/server/integrations/google/error-catalog";
import type {
  GaFixError,
  GaFixErrorCode,
  GaFixRefusal,
  GaFixStatus,
} from "./types";

// GA-F7 metinleri: durum etiketleri, hata ve ret mesajları. Hiçbir metinde
// Google'dan gelen sayı ya da mülk adı yoktur.

export const GA_FIX_STATUS_LABEL: Record<GaFixStatus, string> = {
  PROPOSED: "Waiting for approval",
  APPROVED: "Approved, applying",
  APPLYING: "Applying",
  APPLIED: "Applied, checking",
  VERIFIED: "Done and checked",
  FAILED: "Didn't work",
  UNDOING: "Undoing",
  UNDONE: "Undone",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
};

// v1alpha anahtarı kapalıyken onaylı ama uygulanmayan satır için.
export const GA_FIX_STATUS_LABEL_SWITCHED_OFF =
  "Approved, switched off right now";

export const GA_FIX_ERROR_MESSAGES: Record<GaFixErrorCode, string> = {
  not_enabled: "Fixing things from Agentelse is switched off right now.",
  no_edit_access:
    "Editing isn't allowed yet. Allow editing first. Nothing was changed.",
  scope_missing:
    "Agentelse no longer has permission to edit Google Analytics. Allow editing again.",
  reconnect: "Reconnect Google Analytics: access expired or was removed.",
  no_property_access:
    "Your Google account can't edit this property. Ask a property admin to give you Editor access, then try again.",
  property_changed:
    "The Google Analytics property changed since this was proposed. Nothing was changed.",
  no_stream:
    "No web data stream was found on this property. Nothing was changed.",
  limit_reached: "Google Analytics won't allow more of these on this property.",
  readback_mismatch:
    "Google accepted the change, but it doesn't show up yet. Check it in Google Analytics.",
  google_unavailable:
    "Google Analytics isn't answering right now. We'll try again shortly.",
  google_changed:
    "Google changed how this works. Nothing was changed. We'll look into it.",
  rate_limited: "Google asked us to slow down. We'll try again later.",
  rejected_by_google:
    "Google Analytics didn't accept this change. Nothing was changed.",
  cannot_undo:
    "It was changed again since. Change it back in Google Analytics if you still want it reverted.",
  approval_missing:
    "The approval for this change is missing. Nothing was changed.",
  unknown: "Something went wrong. Nothing was changed.",
};

export const GA_FIX_REFUSAL_MESSAGES: Record<GaFixRefusal, string> = {
  not_enabled: "Fixing things from Agentelse is switched off right now.",
  alpha_off: "This kind of change is switched off right now.",
  no_link: "Connect Google Analytics and choose a property first.",
  no_edit_access: "Allow editing first, then try again.",
  invalid: "That doesn't look right. Check it and try again.",
  limit_reached: "Google Analytics won't allow more of these on this property.",
  already_satisfied: "Already there. Nothing to change.",
  no_stream: "No web data stream was found on this property.",
  not_allowed_here: "This isn't allowed from here.",
};

function error(
  code: GaFixErrorCode,
  retryable?: boolean,
): GaFixError {
  const base: GaFixError = { code, message: GA_FIX_ERROR_MESSAGES[code] };
  if (retryable) base.retryable = true;
  return base;
}

const LIMIT_PATTERN = /limit|maximum|exceed/i;

// Google hata sınıfından kullanıcıya gösterilen hata. v1alpha tabloları
// beklenmedik yanıt verirse 'Google değiştirmiş olabilir' denir.
export function fixErrorFor(input: {
  errorClass: GoogleErrorClass;
  httpStatus?: number;
  message?: string;
  alpha: boolean;
}): GaFixError {
  switch (input.errorClass) {
    case "SCOPE_MISSING":
      return error("scope_missing");
    case "AUTH":
      return error("reconnect");
    case "PERMISSION":
      return error("no_property_access");
    case "NOT_FOUND":
      return error(input.alpha ? "google_changed" : "property_changed");
    case "VALIDATION":
      if (LIMIT_PATTERN.test(input.message ?? "")) return error("limit_reached");
      return error(input.alpha ? "google_changed" : "rejected_by_google");
    case "API_DISABLED":
      return error("google_unavailable");
    case "RATE_LIMIT":
    case "QUOTA_DAILY":
      return error("rate_limited", true);
    case "TRANSIENT":
    case "SERVER_ERROR":
      return error("google_unavailable", true);
    case "UNKNOWN":
      return error(input.alpha ? "google_changed" : "unknown");
  }
}

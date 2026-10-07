import { healthFromCapabilities } from "@/lib/seo/apply/wp/capabilities";
import type { WpCapabilities, WpHealth } from "@/lib/seo/apply/types";

import type { WordPressApiError } from "./errors";

// Bağlantı sağlığı (saf): son denetimin sonucundan tek bir WpHealth ve kısa
// bir neden kodu üretir. Neden kodları arayüzde sabit metne çevrilir.
export type ConnectionReason =
  | "domain_mismatch"
  | "scope_changed"
  | "reconnect"
  | "rest_blocked"
  | "not_wordpress"
  | "unreachable"
  | "no_edit_rights"
  | "limited";

export function classifyConnection(input: {
  capabilities: WpCapabilities | null;
  error: WordPressApiError | null;
  domainOk: boolean;
  scopeOk: boolean;
}): { health: WpHealth; reason: ConnectionReason | null } {
  if (!input.domainOk) {
    return { health: "DOMAIN_MISMATCH", reason: "domain_mismatch" };
  }
  if (!input.scopeOk) {
    return { health: "DOMAIN_MISMATCH", reason: "scope_changed" };
  }
  if (input.error) {
    switch (input.error.errorClass) {
      case "AUTH":
      case "APP_PASSWORDS_DISABLED":
        return { health: "AUTH", reason: "reconnect" };
      case "FORBIDDEN":
        return { health: "NO_PERMISSION", reason: "no_edit_rights" };
      case "REST_DISABLED":
      case "REDIRECT":
      case "NOT_FOUND":
        return { health: "REST_BLOCKED", reason: "rest_blocked" };
      case "NOT_WORDPRESS":
        return { health: "NOT_WORDPRESS", reason: "not_wordpress" };
      case "TRANSIENT":
      case "SERVER":
      case "UNSAFE":
      case "RATE_LIMIT":
        return { health: "UNREACHABLE", reason: "unreachable" };
      case "VALIDATION":
        return { health: "UNKNOWN", reason: null };
    }
  }
  if (input.capabilities) {
    const health = healthFromCapabilities(input.capabilities);
    if (health === "OK") return { health, reason: null };
    return {
      health,
      reason: health === "NO_PERMISSION" ? "no_edit_rights" : "limited",
    };
  }
  return { health: "UNKNOWN", reason: null };
}

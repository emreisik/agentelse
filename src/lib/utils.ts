import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Only allows same-origin, relative paths as the post-login/register
// redirect target. Blocks open redirects via protocol-relative/backslash
// tricks like "//evil.com" and "/\evil.com".
export function sanitizeCallbackUrl(value: string | undefined): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\")
  ) {
    return "/dashboard";
  }
  return value;
}

const ACTIVE_STATUSES = new Set(["RUNNING", "ACTIVE", "IN_PROGRESS"]);
const DONE_STATUSES = new Set(["READY", "DONE", "COMPLETED", "APPROVED"]);
const FAILED_STATUSES = new Set(["FAILED", "REJECTED", "ERROR", "CANCELLED"]);

export function statusBadgeVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  const normalized = status.toUpperCase();
  if (ACTIVE_STATUSES.has(normalized)) return "default";
  if (DONE_STATUSES.has(normalized)) return "secondary";
  if (FAILED_STATUSES.has(normalized)) return "destructive";
  return "outline";
}

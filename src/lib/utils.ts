import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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

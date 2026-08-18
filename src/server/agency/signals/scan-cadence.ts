import type { SignalIntensity } from "@prisma/client";

// Intensity -> scan interval (spec section 8). Pure module.
const INTERVAL_HOURS: Record<SignalIntensity, number | null> = {
  VERY_HIGH: 4,
  HIGH: 12,
  MEDIUM: 24,
  LOW: 72,
  OFF: null,
};

export function scanIntervalHours(intensity: SignalIntensity): number | null {
  return INTERVAL_HOURS[intensity];
}

export function nextScanAt(
  intensity: SignalIntensity,
  from: Date = new Date(),
): Date | null {
  const hours = INTERVAL_HOURS[intensity];
  if (hours === null) return null;
  return new Date(from.getTime() + hours * 3600_000);
}

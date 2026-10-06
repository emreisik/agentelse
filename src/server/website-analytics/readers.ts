import "server-only";

import {
  ROLLING_WINDOWS,
  type RollingWindow,
} from "@/lib/website-analytics/catalog";
import { addDays, safeTimezone } from "@/lib/website-analytics/days";
import { GaFlags } from "@/lib/website-analytics/flags";
import { sumTotals, type GaPeriodTotals } from "@/lib/website-analytics/totals";
import { dayKeyInTimezone } from "@/lib/timezone";

import { primaryGaLink, readDailyTotals, readRollingUsers } from "./store";

// Eski canlı okuyucuların ambar karşılığı (docs/google-analytics-plan.md §3.3
// "Okuyucuların ambara geçişi"): Analytics modülü, ANALYTICS_ANALYSIS görevi
// ve tarayıcı, mülk saatiyle dünkü güne kadar `days` günü buradan okur.
// Ambar o pencereyi eksiksiz kapsamıyorsa (bayrak kapalı, senkron yeni, dün
// henüz gelmedi) null döner ve çağıran canlı yola düşer.

export type GaWindow = {
  days: number;
  from: string;
  to: string;
  totals: GaPeriodTotals;
  // Pencerenin tekil kullanıcıları (7/28/90 gün için).
  users: { activeUsers: number; newUsers: number } | null;
  currencyCode: string | null;
};

function isRollingWindow(days: number): days is RollingWindow {
  return (ROLLING_WINDOWS as readonly number[]).includes(days);
}

export async function readGaWindow(input: {
  projectId: string;
  propertyId: string;
  days: number;
  now?: Date;
}): Promise<GaWindow | null> {
  if (!GaFlags.sync()) return null;
  const link = await primaryGaLink(input.projectId);
  if (!link || link.propertyId !== input.propertyId) return null;
  const timeZone = safeTimezone(link.timeZone);
  const today = dayKeyInTimezone(input.now ?? new Date(), timeZone);
  const to = addDays(today, -1);
  const from = addDays(today, -input.days);
  const rows = await readDailyTotals(link.id, from, to);
  if (rows.length < input.days) return null;
  let users: GaWindow["users"] = null;
  if (isRollingWindow(input.days)) {
    const rolling = await readRollingUsers(link.id, to);
    const window = rolling?.[input.days];
    if (window) {
      users = { activeUsers: window.activeUsers, newUsers: window.newUsers };
    }
  }
  return {
    days: input.days,
    from,
    to,
    totals: sumTotals(rows),
    users,
    currencyCode: link.currencyCode,
  };
}

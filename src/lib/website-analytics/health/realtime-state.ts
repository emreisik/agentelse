import type { GaRealtimeState } from "./types";

// GA-F3 MH1_RT (docs/measurement-health.md "Gün içi realtime"): gün içi
// aktif kullanıcı ölçümünün zamanlaması ve durumu. Yalnız aynı hafta günü
// medyanı en az 240 oturum/gün olan mülklerde, mülk saatiyle 09:00–21:00
// arasında ve son ölçümden en az 50 dakika sonra. 'I fixed it' (force)
// yalnız 50 dakikalık aralığı atlar; taban ve saat penceresi geçerli kalır.

export const GA_RT_MIN_EXPECTED_DAILY_SESSIONS = 240;
export const GA_RT_EVERY_MS = 50 * 60_000;

const FIRST_HOUR = 9;
const END_HOUR = 21;

export function realtimeProbeDue(
  state: GaRealtimeState | null,
  input: {
    today: string;
    hour: number;
    now: Date;
    expectedDailySessions: number | null;
    force?: boolean /* bypasses only the 50-min spacing */;
  },
): boolean {
  const expected = input.expectedDailySessions;
  if (expected === null || !(expected >= GA_RT_MIN_EXPECTED_DAILY_SESSIONS)) {
    return false;
  }
  if (!(input.hour >= FIRST_HOUR && input.hour < END_HOUR)) return false;
  if (input.force || !state || state.day !== input.today || !state.lastAt) {
    return true;
  }
  const lastAt = Date.parse(state.lastAt);
  // Okunamayan zaman damgası ölçümü engellemez.
  if (!Number.isFinite(lastAt)) return true;
  return input.now.getTime() - lastAt >= GA_RT_EVERY_MS;
}

// Yeni mülk günü sayaçları sıfırlar; art arda sıfır okumalar `zeros`'ta
// birikir, sıfır olmayan bir okuma diziyi keser.
export function nextRealtimeState(
  state: GaRealtimeState | null,
  input: {
    today: string;
    now: Date;
    activeUsers: number;
    expected: number | null;
  },
): GaRealtimeState {
  const sameDay = state !== null && state.day === input.today;
  const checks = sameDay ? state.checks : 0;
  const zeros = sameDay ? state.zeros : 0;
  return {
    v: 1,
    day: input.today,
    zeros: input.activeUsers === 0 ? zeros + 1 : 0,
    checks: checks + 1,
    lastAt: input.now.toISOString(),
    lastActive: input.activeUsers,
    expected: input.expected,
  };
}

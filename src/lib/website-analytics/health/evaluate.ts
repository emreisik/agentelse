import {
  checkMH13,
  checkMH14,
  checkMH15,
  checkMH2,
  checkMH21,
  checkMH24,
  checkMH5,
} from "./admin-checks";
import {
  checkMH1,
  checkMH10,
  checkMH11,
  checkMH12,
  checkMH16,
  checkMH17,
  checkMH18,
  checkMH19,
  checkMH1Realtime,
  checkMH20,
  checkMH22,
  checkMH4,
  checkMH6,
  checkMH7,
  checkMH8,
  checkMH9,
} from "./data-checks";
import { unknownResult } from "./known-values";
import { checkMH23, checkMH3 } from "./site-checks";
import {
  GA_CHECK_KEYS,
  type GaCheckKey,
  type GaCheckResult,
  type GaHealthInputs,
  type GaRealtimeState,
} from "./types";

// GA-F3 ölçüm sağlığı değerlendirmesi (docs/measurement-health.md): bir
// bağın girdilerinden GA_CHECK_KEYS sırasıyla her kontrol için tek sonuç.
// Önce MH24 (MH2 ona bakar), sonra MH1 (MH3 ona bakar), sonra diğerleri.
// Hiçbir kontrol değerlendirmeyi düşüremez: hata UNKNOWN 'error' olur. Saf
// modül; D (server/website-analytics/health/checks.ts) çağırır.

function safely(key: GaCheckKey, run: () => GaCheckResult): GaCheckResult {
  try {
    return run();
  } catch {
    return unknownResult(key, "error");
  }
}

export function evaluateGaChecks(input: GaHealthInputs): GaCheckResult[] {
  const results = new Map<GaCheckKey, GaCheckResult>();
  const run = (key: GaCheckKey, check: () => GaCheckResult): GaCheckResult => {
    const result = safely(key, check);
    results.set(key, result);
    return result;
  };

  const mh24 = run("MH24", () => checkMH24(input));
  const mh1 = run("MH1", () => checkMH1(input));
  run("MH2", () => checkMH2(input, mh24.status));
  run("MH3", () => checkMH3(input.siteTag, mh1.status));
  run("MH1_RT", () => checkMH1Realtime(input));
  run("MH4", () => checkMH4(input));
  run("MH5", () => checkMH5(input));
  run("MH6", () => checkMH6(input));
  run("MH7", () => checkMH7(input));
  run("MH8", () => checkMH8(input));
  run("MH9", () => checkMH9(input));
  run("MH10", () => checkMH10(input));
  run("MH11", () => checkMH11(input));
  run("MH12", () => checkMH12(input));
  run("MH13", () => checkMH13(input));
  run("MH14", () => checkMH14(input));
  run("MH15", () => checkMH15(input));
  run("MH16", () => checkMH16(input));
  run("MH17", () => checkMH17(input));
  run("MH18", () => checkMH18(input));
  run("MH19", () => checkMH19(input));
  run("MH20", () => checkMH20(input));
  run("MH21", () => checkMH21(input));
  run("MH22", () => checkMH22(input));
  run("MH23", () => checkMH23(input.siteTag, input.window28.country));

  return GA_CHECK_KEYS.map((key) =>
    withSortedDays(results.get(key) ?? unknownResult(key, "error")),
  );
}

// Şüpheli gün adayları tekil ve sıralı; boş liste hiç taşınmaz.
function withSortedDays(result: GaCheckResult): GaCheckResult {
  const { days, ...rest } = result;
  if (!days) return rest;
  const unique = [...new Set(days)].sort();
  return unique.length > 0 ? { ...rest, days: unique } : rest;
}

// Saatlik yalnız-realtime yolu (MH1_RT): tam değerlendirmedekiyle aynı kural.
export function evaluateGaRealtimeCheck(input: {
  today: string;
  realtime: GaRealtimeState | null;
}): GaCheckResult {
  return safely("MH1_RT", () => checkMH1Realtime(input));
}

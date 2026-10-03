// Sürükle-bırakın saf kuralları (IO yok): bir parça bir güne bırakılınca hangi
// yerel gün+saate yazılır, ya da bırakma neden reddedilir.
//
// Neden geçmişe bırakılamaz: onaylı bir Instagram parçası geçmiş bir zamana
// yazılırsa yayın kuyruğu onu hemen "vadesi gelmiş" sayıp paylaşır. Yanlışlıkla
// bir sürükleme canlı hesaba anında gönderi atmamalı.

import { parseDayKey, pad2 } from "./grid";

// Saati olmayan (gün atanmamış) parçalar için varsayılan yayın saati.
export const DEFAULT_DROP_TIME = "10:00";

export type DropResult =
  { ok: true; localDateTime: string } | { ok: false; reason: string };

// "YYYY-MM-DDTHH:mm" yerel (proje saat dilimi) dizgeleri sözlük sırasıyla da
// kronolojik sırada karşılaştırılabilir.
export function resolveDrop(input: {
  // Bırakılan günün anahtarı (YYYY-MM-DD).
  targetDay: string;
  // Parçanın mevcut saati ("HH:mm") ya da null.
  currentTime: string | null;
  // Proje saat diliminde şu an: "YYYY-MM-DDTHH:mm".
  nowLocal: string;
}): DropResult {
  if (!parseDayKey(input.targetDay)) {
    return { ok: false, reason: "That isn't a valid day." };
  }
  const todayKey = input.nowLocal.slice(0, 10);
  if (input.targetDay < todayKey) {
    return {
      ok: false,
      reason: "Can't schedule in the past. Pick today or a later day.",
    };
  }

  const time = input.currentTime ?? DEFAULT_DROP_TIME;
  const candidate = `${input.targetDay}T${time}`;
  if (input.targetDay > todayKey || candidate > input.nowLocal) {
    return { ok: true, localDateTime: candidate };
  }

  // Bugüne bırakıldı ve saat geçmiş: bir sonraki çeyrek saate ertele.
  const [hours, minutes] = input.nowLocal.slice(11, 16).split(":").map(Number);
  const nextQuarter =
    Math.ceil(((hours ?? 0) * 60 + (minutes ?? 0) + 1) / 15) * 15;
  if (nextQuarter >= 24 * 60) {
    return {
      ok: false,
      reason: "Too late today to schedule. Pick another day.",
    };
  }
  const bumped = `${pad2(Math.floor(nextQuarter / 60))}:${pad2(nextQuarter % 60)}`;
  return { ok: true, localDateTime: `${input.targetDay}T${bumped}` };
}

// Bir günün hücresine bırakmak geçerli mi (sürükleme sırasında vurgu için).
export function isDroppableDay(dayKey: string, todayKey: string): boolean {
  return dayKey >= todayKey;
}

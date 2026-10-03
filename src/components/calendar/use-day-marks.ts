"use client";

import { useCallback, useRef, useState } from "react";

import type { CalendarPayload } from "@/lib/calendar/types";

import { fetchCalendar } from "./api";

// Seçicinin "planner" noktaları: görünen ayın her gününde kaç parça planlı.
// Bir güne yeni parça koyarken o günün dolu olduğu seçerken görünür. Aynı
// aralık 30 sn içinde tekrar istenirse önbellekten gelir (aç-kapa ya da ay
// geç-dön ağ isteği yapmaz).
const TTL_MS = 30_000;

type Cached = { at: number; byDay: Record<string, string[]> };
const cache = new Map<string, Cached>();

function groupByDay(payload: CalendarPayload): Record<string, string[]> {
  const byDay: Record<string, string[]> = {};
  for (const item of payload.items) {
    // Reddedilenler takvime yük bindirmez.
    if (!item.localDay || item.stage === "rejected") continue;
    (byDay[item.localDay] ??= []).push(item.id);
  }
  return byDay;
}

function counts(
  byDay: Record<string, string[]>,
  excludeId: string | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [day, ids] of Object.entries(byDay)) {
    const count = ids.filter((id) => id !== excludeId).length;
    if (count > 0) out[day] = count;
  }
  return out;
}

export function useDayMarks(
  projectId: string | undefined,
  // Düzenlenen parçanın kendisi, kendi gününü "dolu" göstermesin.
  excludeId?: string,
) {
  const [marks, setMarks] = useState<Record<string, number>>({});
  // Yalnız en son istenen aralığın yanıtı uygulanır (hızlı ay geçişi).
  const latest = useRef("");

  const onViewChange = useCallback(
    (range: { first: string; last: string }) => {
      if (!projectId) return;
      const key = `${projectId}:${range.first}:${range.last}`;
      latest.current = key;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < TTL_MS) {
        setMarks(counts(hit.byDay, excludeId));
        return;
      }
      void fetchCalendar(projectId, range.first, range.last).then((payload) => {
        if (!payload) return;
        const byDay = groupByDay(payload);
        cache.set(key, { at: Date.now(), byDay });
        if (latest.current === key) setMarks(counts(byDay, excludeId));
      });
    },
    [projectId, excludeId],
  );

  return { marks, onViewChange };
}

// Testler ve çıkışta (başka proje) önbelleği temizlemek için.
export function clearDayMarksCache(): void {
  cache.clear();
}

import type {
  CalendarDetail,
  CalendarPayload,
} from "@/lib/calendar/types";

// Takvimin hafif okuma uçları (Server Action değil: Server Action'lar istemci
// başına sıralı çalışır, bir okuma sürükle-bırakın yazmasını bekletirdi).
// Hata ya da iptalde null döner; çağıran sessizce eldekini kullanır.
async function getJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const response = await fetch(url, { signal, cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function fetchCalendar(
  projectId: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<CalendarPayload | null> {
  return getJson<CalendarPayload>(
    `/api/projects/${projectId}/calendar?from=${from}&to=${to}`,
    signal,
  );
}

export function fetchDetail(
  projectId: string,
  creativeId: string,
  signal?: AbortSignal,
): Promise<CalendarDetail | null> {
  return getJson<CalendarDetail>(
    `/api/projects/${projectId}/calendar/${creativeId}`,
    signal,
  );
}

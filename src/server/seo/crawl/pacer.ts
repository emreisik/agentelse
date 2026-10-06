import { CRAWL_MIN_INTERVAL_MS } from "@/lib/seo/audit-constants";

// Alan adı başına istek aralığı (docs/google-search-console-plan.md SC-F3):
// aynı alan adına iki istek arasında en az 1 sn (robots Crawl-delay daha
// uzunsa o) geçer. Her alan adının kendi söz zinciri vardır; farklı alan
// adları birbirini bekletmez. Süreç geneli tek örnek (sharedHostPacer)
// paralel taranan siteleri de aynı kurala bağlar.

export type HostPacer = {
  wait(host: string, intervalMs?: number): Promise<void>;
};

// Bu kadar alan adından sonra uzun süredir boşta olanlar unutulur.
const PRUNE_ABOVE = 500;
const IDLE_FORGET_MS = 600_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createHostPacer(
  options: {
    minIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): HostPacer {
  const minIntervalMs = options.minIntervalMs ?? CRAWL_MIN_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  // Alan adı → zincirin kuyruğu ve son izin anı.
  const tails = new Map<string, Promise<void>>();
  const lastAt = new Map<string, number>();

  const prune = () => {
    if (lastAt.size <= PRUNE_ABOVE) return;
    const cutoff = now() - IDLE_FORGET_MS;
    for (const [host, at] of lastAt) {
      if (at < cutoff && !tails.has(host)) lastAt.delete(host);
    }
  };

  return {
    wait(host, intervalMs) {
      const key = host.toLowerCase();
      const gap = Math.max(minIntervalMs, intervalMs ?? 0);
      const previous = tails.get(key) ?? Promise.resolve();
      const turn = previous.then(async () => {
        const last = lastAt.get(key);
        if (last !== undefined) {
          const delay = last + gap - now();
          if (delay > 0) await sleep(delay);
        }
        lastAt.set(key, now());
      });
      // Zincir bir hatada kopmasın; sıra boşalınca kuyruk silinir.
      const tail = turn.catch(() => undefined);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
        prune();
      });
      return turn;
    },
  };
}

export const sharedHostPacer: HostPacer = createHostPacer();

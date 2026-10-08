// A small least-recently-used cache, for work that is expensive to repeat and
// cheap to remember (a cleaned logo, a rendered preview). In-process only: a
// new server process starts empty and refills.

export class Lru<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Touched: becomes the newest.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// Runs at most `limit` async jobs at once; the rest wait their turn in order.
export function createLimiter(limit: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    running -= 1;
    queue.shift()?.();
  };
  return async function run<T>(job: () => Promise<T>): Promise<T> {
    if (running >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    running += 1;
    try {
      return await job();
    } finally {
      next();
    }
  };
}

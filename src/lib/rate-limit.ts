import "server-only";

// Process-local, in-memory fixed-window rate limiter. Good enough to stop
// scripted brute-force/credential-stuffing against auth endpoints on a
// single Railway instance; it does NOT share state across instances or
// survive a restart. If the deployment ever scales to multiple instances,
// swap this for a shared store (e.g. Upstash Redis) behind the same
// isRateLimited() signature.
type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_KEYS = 5_000;

function pruneExpired(now: number) {
  if (buckets.size < MAX_TRACKED_KEYS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

// Returns true when `key` has exceeded `max` calls within `windowMs`.
export function isRateLimited(
  key: string,
  max: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  pruneExpired(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  bucket.count += 1;
  return bucket.count > max;
}

// Best-effort client IP from proxy headers (Railway edge sets
// x-forwarded-for, same as src/proxy.ts's origin-detection). Falls back to
// a constant so callers still get a (shared, coarser) rate limit instead of
// throwing when the header is absent.
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

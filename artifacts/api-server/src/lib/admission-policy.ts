type Bucket = { count: number; resetAt: number };

export function createFixedWindowRateLimiter(
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1) {
    throw new Error("Rate-limit settings must be positive.");
  }

  const buckets = new Map<string, Bucket>();

  return (key: string): boolean => {
    const currentTime = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= currentTime) {
      bucket = { count: 0, resetAt: currentTime + windowMs };
      buckets.set(key, bucket);
    }

    if (bucket.count >= limit) return false;
    bucket.count += 1;

    if (buckets.size > 10_000) {
      for (const [bucketKey, value] of buckets) {
        if (value.resetAt <= currentTime) buckets.delete(bucketKey);
      }
    }
    return true;
  };
}

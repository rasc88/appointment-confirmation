const maxRequests = 30;
const windowMs = 60 * 1000;

interface Entry {
  count: number;
  windowEndsAt: number;
}

/** In memory, which is correct on the single instance of decision 11 (decision 29). */
export function createPublicRateLimit() {
  const entries = new Map<string, Entry>();

  return {
    /** Counts the request; seconds until the key may make another, or null when it is not limited. */
    recordRequest(key: string): number | null {
      const now = Date.now();
      for (const [entryKey, entry] of entries) {
        if (now >= entry.windowEndsAt) {
          entries.delete(entryKey);
        }
      }
      const entry = entries.get(key);
      if (!entry) {
        entries.set(key, { count: 1, windowEndsAt: now + windowMs });
        return null;
      }
      entry.count += 1;
      if (entry.count <= maxRequests) {
        return null;
      }
      return Math.max(1, Math.ceil((entry.windowEndsAt - now) / 1000));
    },
  };
}

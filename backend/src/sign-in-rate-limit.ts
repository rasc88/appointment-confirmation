const maxFailures = 10;
const windowMs = 15 * 60 * 1000;

interface Entry {
  failures: number;
  windowEndsAt: number;
}

/** In memory, which is correct on the single instance of decision 11 (decision 27). */
export function createSignInRateLimit() {
  const entries = new Map<string, Entry>();

  return {
    /** Seconds until the key may sign in again, or null when it is not limited. */
    retryAfterSeconds(key: string): number | null {
      const entry = entries.get(key);
      const now = Date.now();
      if (!entry || entry.failures < maxFailures || now >= entry.windowEndsAt) {
        return null;
      }
      return Math.max(1, Math.ceil((entry.windowEndsAt - now) / 1000));
    },
    recordFailure(key: string) {
      const now = Date.now();
      for (const [entryKey, entry] of entries) {
        if (now >= entry.windowEndsAt) {
          entries.delete(entryKey);
        }
      }
      const entry = entries.get(key);
      if (entry) {
        entry.failures += 1;
      } else {
        entries.set(key, { failures: 1, windowEndsAt: now + windowMs });
      }
    },
    clear(key: string) {
      entries.delete(key);
    },
  };
}

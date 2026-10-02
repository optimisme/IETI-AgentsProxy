const MAX_FAILURE_ENTRIES = 1024;
const FAILURE_TTL_MS = 5 * 60 * 1000;
const MAX_COOLDOWN_MS = 30000;

function createProviderAvailability({ now = Date.now, maxEntries = MAX_FAILURE_ENTRIES } = {}) {
  const failures = new Map();
  function prune() {
    for (const [slug, entry] of failures) {
      if (now() - entry.at >= FAILURE_TTL_MS) failures.delete(slug);
    }
  }
  function failed(slug, retryAfterMs = 0) {
    prune();
    const count = Math.min((failures.get(slug)?.count || 0) + 1, 6);
    const cooldown = Math.min(MAX_COOLDOWN_MS, Math.max(1000 * 2 ** (count - 1), retryAfterMs));
    failures.delete(slug);
    failures.set(slug, { count, at: now(), until: now() + cooldown });
    while (failures.size > maxEntries) failures.delete(failures.keys().next().value);
  }
  function available(slug) {
    prune();
    return (failures.get(slug)?.until || 0) <= now();
  }
  return { available, failed, succeeded: (slug) => failures.delete(slug), size: () => { prune(); return failures.size; } };
}

const providerAvailability = createProviderAvailability();
module.exports = { createProviderAvailability, providerAvailability };

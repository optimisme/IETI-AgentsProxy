// Holds secrets that are shown to a person once (a new API key waiting for a name, a
// fresh invitation link) in process memory instead of the persisted session store, so
// they never reach the database. Entries expire, and a restart discards them.
const TTL_MS = 15 * 60_000;
const entries = new Map();

const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (now > entry.expiresAt) entries.delete(key);
  }
}, 60_000);
sweepTimer.unref?.();

function entryKey(sessionId, name) {
  return `${sessionId}\n${name}`;
}

function setPendingSecret(sessionId, name, value) {
  entries.set(entryKey(sessionId, name), { value, expiresAt: Date.now() + TTL_MS });
}

function getPendingSecret(sessionId, name) {
  const key = entryKey(sessionId, name);
  const entry = entries.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    entries.delete(key);
    return null;
  }
  return entry.value;
}

function clearPendingSecret(sessionId, name) {
  entries.delete(entryKey(sessionId, name));
}

function takePendingSecret(sessionId, name) {
  const value = getPendingSecret(sessionId, name);
  clearPendingSecret(sessionId, name);
  return value;
}

module.exports = { clearPendingSecret, getPendingSecret, setPendingSecret, takePendingSecret };

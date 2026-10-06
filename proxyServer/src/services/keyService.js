const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SHA256_PREFIX = 'sha256:';

function generateStudentKey() {
  return `ieti_sk_${crypto.randomBytes(32).toString('base64url')}`;
}

// Keys carry 256 random bits, so a fast SHA-256 digest is as strong as bcrypt here and
// does not block the event loop. bcrypt hashes from older installations still verify.
function hashApiKey(apiKey) {
  return `${SHA256_PREFIX}${lookupHashApiKey(apiKey)}`;
}

function lookupHashApiKey(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey || ''), 'utf8').digest('hex');
}

function keyPrefixSuffix(apiKey) {
  return { prefix: apiKey.slice(0, 3), suffix: apiKey.slice(-3) };
}

async function verifyApiKey(apiKey, hash) {
  if (!apiKey || !hash) return false;
  if (hash.startsWith(SHA256_PREFIX)) {
    const expected = Buffer.from(hash.slice(SHA256_PREFIX.length));
    const actual = Buffer.from(lookupHashApiKey(apiKey));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  return bcrypt.compare(apiKey, hash);
}

module.exports = { generateStudentKey, hashApiKey, lookupHashApiKey, verifyApiKey, keyPrefixSuffix };

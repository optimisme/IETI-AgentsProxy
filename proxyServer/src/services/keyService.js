const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function generateStudentKey() {
  return `ieti_sk_${crypto.randomBytes(32).toString('base64url')}`;
}

function hashApiKey(apiKey) {
  return bcrypt.hashSync(apiKey, 12);
}

function lookupHashApiKey(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey || ''), 'utf8').digest('hex');
}

function keyPrefixSuffix(apiKey) {
  return { prefix: apiKey.slice(0, 3), suffix: apiKey.slice(-3) };
}

function verifyApiKey(apiKey, hash) {
  if (!apiKey || !hash) return false;
  return bcrypt.compareSync(apiKey, hash);
}

module.exports = { generateStudentKey, hashApiKey, lookupHashApiKey, verifyApiKey, keyPrefixSuffix };

const path = require('path');

const rootDir = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(rootDir, 'settings.env'), quiet: true });

function numberEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function googleCallbackUrl(publicBaseUrl) {
  const value = String(publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
    return `${url.toString().replace(/\/$/, '')}/auth/google/callback`;
  } catch {
    return '';
  }
}

const publicBaseUrl = process.env.PUBLIC_BASE_URL || '';
const googleOAuthEnabled = boolEnv('GOOGLE_OAUTH_ENABLED', false);
const googleOAuthAllowedDomains = process.env.GOOGLE_OAUTH_ALLOWED_DOMAINS || '';

if (googleOAuthEnabled) {
  const missing = [
    ['GOOGLE_OAUTH_CLIENT_ID', process.env.GOOGLE_OAUTH_CLIENT_ID],
    ['GOOGLE_OAUTH_CLIENT_SECRET', process.env.GOOGLE_OAUTH_CLIENT_SECRET],
    ['PUBLIC_BASE_URL', publicBaseUrl],
    ['GOOGLE_OAUTH_ALLOWED_DOMAINS', googleOAuthAllowedDomains]
  ].filter(([, value]) => !String(value || '').trim()).map(([name]) => name);
  if (missing.length) throw new Error(`Google OAuth is enabled but these settings are missing: ${missing.join(', ')}`);
  if (!googleCallbackUrl(publicBaseUrl)) throw new Error('PUBLIC_BASE_URL must be a valid HTTP or HTTPS URL when Google OAuth is enabled.');
}

module.exports = {
  rootDir,
  port: numberEnv('PORT', 3000),
  databasePath: path.resolve(rootDir, process.env.DATABASE_PATH || './data/agents_proxy.sqlite'),
  defaultProviderApiKey: process.env.DEFAULT_PROVIDER_API_KEY || '',
  defaultProviderBaseUrl: process.env.DEFAULT_PROVIDER_BASE_URL || 'https://api.deepseek.com',
  defaultProviderSlug: process.env.DEFAULT_PROVIDER_SLUG || 'deepseek',
  defaultProviderName: process.env.DEFAULT_PROVIDER_NAME || 'DeepSeek',
  defaultUpstreamModel: process.env.DEFAULT_UPSTREAM_MODEL || 'deepseek-chat',
  publicModelName: process.env.PUBLIC_MODEL_NAME || 'active-model',
  publicBaseUrl,
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'replace_with_a_secure_admin_password',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  sessionSecret: process.env.SESSION_SECRET || 'development_session_secret_change_me',
  sessionCookieSecure: publicBaseUrl.trim().toLowerCase().startsWith('https://'),
  googleOAuthEnabled,
  googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
  googleOAuthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
  googleOAuthAllowedDomains,
  googleOAuthAutoRegister: boolEnv('GOOGLE_OAUTH_AUTO_REGISTER', true),
  googleOAuthCallbackUrl: googleCallbackUrl(publicBaseUrl),
  maxRequestsPerMinute: numberEnv('MAX_REQUESTS_PER_MINUTE', 1000),
  maxTokensPerRequest: numberEnv('MAX_TOKENS_PER_REQUEST', 8192),
  defaultDailyTokenLimit: numberEnv('DEFAULT_DAILY_TOKEN_LIMIT', 10000000),
  defaultModelContextLimit: numberEnv('DEFAULT_MODEL_CONTEXT_LIMIT', 90000),
  defaultModelOutputLimit: numberEnv('DEFAULT_MODEL_OUTPUT_LIMIT', 8192),
  maxImagesPerRequest: numberEnv('MAX_IMAGES_PER_REQUEST', 4),
  maxImageBytes: numberEnv('MAX_IMAGE_BYTES', 8000000),
  maxTotalImageBytes: numberEnv('MAX_TOTAL_IMAGE_BYTES', 16000000),
  allowVideoInput: boolEnv('ALLOW_VIDEO_INPUT', false),
  enableStreaming: boolEnv('ENABLE_STREAMING', true),
  logRequestBody: boolEnv('LOG_REQUEST_BODY', false),
  requestTimeoutMs: numberEnv('REQUEST_TIMEOUT_MS', 120000),
  streamInactivityTimeoutMs: numberEnv('STREAM_INACTIVITY_TIMEOUT_MS', 600000)
};

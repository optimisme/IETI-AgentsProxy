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

module.exports = {
  rootDir,
  port: numberEnv('PORT', 3000),
  databasePath: path.resolve(rootDir, process.env.DATABASE_PATH || './data/agents_proxy.sqlite'),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  defaultProviderSlug: process.env.DEFAULT_PROVIDER_SLUG || 'deepseek',
  defaultProviderName: process.env.DEFAULT_PROVIDER_NAME || 'DeepSeek',
  defaultUpstreamModel: process.env.DEFAULT_UPSTREAM_MODEL || 'deepseek-chat',
  publicModelName: process.env.PUBLIC_MODEL_NAME || 'active-model',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'replace_with_a_secure_admin_password',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  sessionSecret: process.env.SESSION_SECRET || 'development_session_secret_change_me',
  maxRequestsPerMinute: numberEnv('MAX_REQUESTS_PER_MINUTE', 1000),
  maxTokensPerRequest: numberEnv('MAX_TOKENS_PER_REQUEST', 8192),
  defaultDailyTokenLimit: numberEnv('DEFAULT_DAILY_TOKEN_LIMIT', 10000000),
  defaultModelContextLimit: numberEnv('DEFAULT_MODEL_CONTEXT_LIMIT', 65536),
  defaultModelOutputLimit: numberEnv('DEFAULT_MODEL_OUTPUT_LIMIT', 8192),
  maxImagesPerRequest: numberEnv('MAX_IMAGES_PER_REQUEST', 4),
  maxImageBytes: numberEnv('MAX_IMAGE_BYTES', 8000000),
  maxTotalImageBytes: numberEnv('MAX_TOTAL_IMAGE_BYTES', 16000000),
  allowVideoInput: boolEnv('ALLOW_VIDEO_INPUT', false),
  enableStreaming: boolEnv('ENABLE_STREAMING', true),
  logRequestBody: boolEnv('LOG_REQUEST_BODY', false),
  requestTimeoutMs: numberEnv('REQUEST_TIMEOUT_MS', 120000)
};

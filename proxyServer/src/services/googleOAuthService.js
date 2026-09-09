const crypto = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const config = require('../config');

function parseAllowedDomains(value) {
  const domains = [...new Set(String(value || '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean))];
  if (!domains.length) throw new Error('GOOGLE_OAUTH_ALLOWED_DOMAINS must contain at least one domain or *');
  if (domains.includes('*') && domains.length !== 1) throw new Error('GOOGLE_OAUTH_ALLOWED_DOMAINS=* cannot be combined with named domains.');
  for (const domain of domains) {
    if (domain === '*') continue;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
      throw new Error(`Invalid Google OAuth hosted domain: ${domain}`);
    }
  }
  return domains;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeProfile(payload, expectedNonce, allowedDomains) {
  if (!payload || !safeEqual(payload.nonce, expectedNonce)) throw new Error('Google ID token nonce did not match the sign-in request.');
  if (!payload.sub) throw new Error('Google ID token is missing its subject.');
  if (!payload.email || payload.email_verified !== true) throw new Error('Google account email is missing or is not verified.');
  const email = String(payload.email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Google returned an invalid email address.');
  const hostedDomain = String(payload.hd || '').trim().toLowerCase();
  if (allowedDomains[0] !== '*' && (!hostedDomain || !allowedDomains.includes(hostedDomain))) {
    throw new Error('Google account is not in an allowed hosted domain.');
  }
  const fallbackName = email.split('@')[0];
  const displayName = String(payload.name || fallbackName).trim().slice(0, 160) || fallbackName;
  return {
    provider: 'google',
    subject: String(payload.sub),
    email,
    emailVerified: true,
    hostedDomain: hostedDomain || null,
    displayName
  };
}

function createGoogleOAuthService() {
  const allowedDomains = config.googleOAuthEnabled ? parseAllowedDomains(config.googleOAuthAllowedDomains) : [];
  let client;
  const getClient = () => {
    if (!config.googleOAuthEnabled) throw new Error('Google OAuth is disabled.');
    if (!client) {
      client = new OAuth2Client({
        clientId: config.googleOAuthClientId,
        clientSecret: config.googleOAuthClientSecret,
        redirectUri: config.googleOAuthCallbackUrl
      });
    }
    return client;
  };

  return {
    isEnabled() {
      return config.googleOAuthEnabled;
    },

    async createAuthorizationRequest({ state, nonce }) {
      const oauthClient = getClient();
      const { codeVerifier, codeChallenge } = await oauthClient.generateCodeVerifierAsync();
      const url = oauthClient.generateAuthUrl({
        access_type: 'online',
        scope: ['openid', 'email', 'profile'],
        prompt: 'select_account',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      });
      return { url, codeVerifier };
    },

    async exchangeAndVerify({ code, codeVerifier, nonce }) {
      const oauthClient = getClient();
      const { tokens } = await oauthClient.getToken({
        code,
        codeVerifier,
        redirect_uri: config.googleOAuthCallbackUrl
      });
      if (!tokens.id_token) throw new Error('Google did not return an ID token.');
      const ticket = await oauthClient.verifyIdToken({
        idToken: tokens.id_token,
        audience: config.googleOAuthClientId
      });
      return normalizeProfile(ticket.getPayload(), nonce, allowedDomains);
    }
  };
}

module.exports = {
  createGoogleOAuthService,
  normalizeProfile,
  parseAllowedDomains,
  safeEqual
};

const crypto = require('node:crypto');
const express = require('express');
const { oauthRateLimit } = require('../middleware/rateLimit');
const { resolveGoogleSignIn } = require('../services/oauthIdentityService');
const { createGoogleOAuthService, safeEqual } = require('../services/googleOAuthService');
const { renderTemplate } = require('../utils/templates');
const { escapeHtml, trustedHtml } = require('../utils/html');

const OAUTH_TRANSACTION_MAX_AGE_MS = 10 * 60 * 1000;

function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
}

function renderMessage(res, { title, heading, message, email = '' }) {
  res.set('Cache-Control', 'no-store');
  res.send(renderTemplate('layout', {
    title,
    nav: trustedHtml(''),
    content: trustedHtml(`
      <div class="panel" style="max-width:680px;margin:0 auto">
        <h1>${heading}</h1>
        ${email ? `<p class="muted">${escapeHtml(email)}</p>` : ''}
        <p>${message}</p>
        <p><a class="button" href="/">Back to sign in</a></p>
      </div>
    `)
  }));
}

function createGoogleAuthRouter({ oauthService = createGoogleOAuthService(), identityResolver = resolveGoogleSignIn } = {}) {
  const router = express.Router();

  router.get('/auth/google', oauthRateLimit, async (req, res, next) => {
    try {
      if (!oauthService.isEnabled()) return res.status(404).send('Not found');
      if (req.session?.studentUserId) return res.redirect('/portal');
      if (req.session?.adminAuthenticated) return res.redirect('/admin');
      const state = crypto.randomBytes(32).toString('base64url');
      const nonce = crypto.randomBytes(32).toString('base64url');
      const authorization = await oauthService.createAuthorizationRequest({ state, nonce });
      req.session.googleOAuthTransaction = {
        state,
        nonce,
        codeVerifier: authorization.codeVerifier,
        createdAt: Date.now()
      };
      await saveSession(req);
      res.redirect(authorization.url);
    } catch (error) {
      next(error);
    }
  });

  router.get('/auth/google/callback', oauthRateLimit, async (req, res) => {
    const transaction = req.session?.googleOAuthTransaction;
    req.session.googleOAuthTransaction = null;
    try {
      await saveSession(req);
      if (req.query.error) return res.redirect('/?error=oauth_denied');
      if (!transaction || Date.now() - Number(transaction.createdAt) > OAUTH_TRANSACTION_MAX_AGE_MS) {
        return res.redirect('/?error=oauth_expired');
      }
      if (!safeEqual(req.query.state, transaction.state) || !req.query.code) {
        return res.redirect('/?error=oauth_invalid');
      }
      const profile = await oauthService.exchangeAndVerify({
        code: String(req.query.code),
        codeVerifier: transaction.codeVerifier,
        nonce: transaction.nonce
      });
      const outcome = identityResolver(profile);
      if (outcome.kind === 'conflict') {
        return renderMessage(res, {
          title: 'Account review required',
          heading: 'Account requires administrator review',
          email: profile.email,
          message: 'Your Google account was verified, but this email is already linked to a different Google identity. An administrator must review the account before access can be granted. No duplicate account was created. Please sign in again after the administrator resolves the request.'
        });
      }
      if (outcome.kind !== 'login') return res.redirect('/?error=oauth_denied');
      await regenerateSession(req);
      req.session.studentUserId = outcome.user.id;
      req.session.studentPasswordChangedAt = outcome.user.password_changed_at || null;
      req.session.studentAuthVersion = Number(outcome.user.auth_version || 0);
      await saveSession(req);
      res.redirect('/portal');
    } catch (error) {
      console.error(`Google OAuth callback failed: ${error.message}`);
      res.redirect('/?error=oauth_invalid');
    }
  });

  return router;
}

module.exports = { createGoogleAuthRouter };

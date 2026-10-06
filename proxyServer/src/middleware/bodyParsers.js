const express = require('express');
const config = require('../config');

// Requests carrying inline images need a large body limit. That limit is applied only on
// these routes, after authentication, so anonymous clients cannot make the server buffer
// and parse multi-megabyte bodies.
const LARGE_JSON_PATHS = new Set(['/v1/chat/completions', '/v1/responses', '/portal/chat/completions']);

const largeJsonBody = express.json({ limit: Math.ceil((config.maxTotalImageBytes * 4) / 3) + 1048576 });
const defaultJsonBody = express.json({ limit: '256kb' });

function jsonBody(req, res, next) {
  if (LARGE_JSON_PATHS.has(req.path)) return next();
  return defaultJsonBody(req, res, next);
}

module.exports = { jsonBody, largeJsonBody };

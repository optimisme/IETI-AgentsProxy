const { ApiError, sendJsonError } = require('../utils/errors');
const { anthropicErrorBody } = require('../services/anthropicService');

function isAnthropicPath(req) {
  return req.path === '/v1/messages' || req.path.startsWith('/v1/messages/');
}

function notFound(req, res) {
  if (req.path.startsWith('/admin')) return res.status(404).send('Not found');
  if (isAnthropicPath(req)) return res.status(404).json(anthropicErrorBody(404, 'Not found'));
  return res.status(404).json({ error: { message: 'Not found', type: 'not_found', code: 'not_found' } });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (req.path.startsWith('/admin') && !(error instanceof ApiError)) {
    return res.status(500).send('Internal server error');
  }
  if (isAnthropicPath(req)) {
    const status = error.statusCode || error.status || 500;
    const message = error instanceof ApiError || status < 500 ? error.message : 'Internal server error';
    return res.status(status).json(anthropicErrorBody(status, message));
  }
  return sendJsonError(res, error);
}

module.exports = { notFound, errorHandler };

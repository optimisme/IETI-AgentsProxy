const { ApiError, sendJsonError } = require('../utils/errors');

function notFound(req, res) {
  if (req.path.startsWith('/admin')) return res.status(404).send('Not found');
  return res.status(404).json({ error: { message: 'Not found', type: 'not_found', code: 'not_found' } });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  // Unexpected failures are otherwise invisible: the response only says "Internal server error".
  if (!(error instanceof ApiError) && !(error.status >= 400 && error.status < 500)) {
    console.error(`${new Date().toISOString()} Unhandled error on ${req.method} ${req.path}:`, error);
  }
  if (req.path.startsWith('/admin') && !(error instanceof ApiError)) {
    return res.status(500).send('Internal server error');
  }
  return sendJsonError(res, error);
}

module.exports = { notFound, errorHandler };

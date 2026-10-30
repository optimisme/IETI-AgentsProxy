const { ApiError, sendJsonError } = require('../utils/errors');

function notFound(req, res) {
  if (req.path.startsWith('/admin')) return res.status(404).send('Not found');
  return res.status(404).json({ error: { message: 'Not found', type: 'not_found', code: 'not_found' } });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (req.path.startsWith('/admin') && !(error instanceof ApiError)) {
    return res.status(500).send('Internal server error');
  }
  return sendJsonError(res, error);
}

module.exports = { notFound, errorHandler };

class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function apiError(statusCode, code, message, details) {
  return new ApiError(statusCode, code, message, details);
}

function sendJsonError(res, error) {
  const status = error.statusCode || 500;
  const code = error.code || 'internal_error';
  const message = error.message || 'Internal server error';
  res.status(status).json({
    error: {
      message,
      type: code,
      code,
      details: error.details
    }
  });
}

module.exports = { ApiError, apiError, sendJsonError };

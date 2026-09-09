const config = require('../config');
const { getSetting } = require('../services/settingsService');
const { apiError } = require('./errors');

const DATA_IMAGE_PATTERN = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/i;

function numberSetting(key, fallback) {
  const value = getSetting(key, fallback);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolSetting(key, fallback) {
  const value = getSetting(key, fallback ? 'true' : 'false');
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function base64Bytes(value) {
  const clean = String(value || '').replace(/\s+/g, '');
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function validateImageUrl(url, limits) {
  if (typeof url !== 'string' || !url.trim()) {
    throw apiError(400, 'invalid_image', 'Image URL must be a non-empty string.');
  }

  const dataMatch = url.match(DATA_IMAGE_PATTERN);
  if (!dataMatch) {
    if (/^data:video\//i.test(url)) {
      throw apiError(400, 'video_not_supported', 'Video input is not supported by this provider.');
    }
    if (/^data:/i.test(url)) {
      throw apiError(400, 'invalid_image', 'Only PNG, JPEG, and WebP data images are supported.');
    }
    return { bytes: 0, remote: true };
  }

  const bytes = base64Bytes(dataMatch[2]);
  if (bytes > limits.maxImageBytes) {
    throw apiError(413, 'image_too_large', `Image exceeds ${limits.maxImageBytes} bytes.`);
  }
  return { bytes, remote: false };
}

function validateRequestPayload(payload) {
  const limits = {
    maxTokensPerRequest: numberSetting('max_tokens_per_request', config.maxTokensPerRequest),
    maxImagesPerRequest: numberSetting('max_images_per_request', config.maxImagesPerRequest),
    maxImageBytes: numberSetting('max_image_bytes', config.maxImageBytes),
    maxTotalImageBytes: numberSetting('max_total_image_bytes', config.maxTotalImageBytes),
    allowVideoInput: boolSetting('allow_video_input', config.allowVideoInput)
  };

  const requestedMaxTokens = Number(payload.max_tokens || 0);
  if (requestedMaxTokens > limits.maxTokensPerRequest) {
    throw apiError(413, 'max_tokens_too_large', `Requested max_tokens exceeds ${limits.maxTokensPerRequest}.`);
  }

  let images = 0;
  let totalImageBytes = 0;
  for (const message of payload.messages || []) {
    const parts = Array.isArray(message?.content) ? message.content : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;

      if (part.type === 'video_url' || part.type === 'input_video') {
        if (!limits.allowVideoInput) {
          throw apiError(400, 'video_not_supported', 'Video input is not supported by this provider.');
        }
      }

      if (part.type === 'image_url' || part.type === 'input_image') {
        images += 1;
        if (images > limits.maxImagesPerRequest) {
          throw apiError(413, 'too_many_images', `Request exceeds ${limits.maxImagesPerRequest} images.`);
        }

        const url = part.image_url?.url || part.image_url || part.image || part.url;
        const result = validateImageUrl(url, limits);
        totalImageBytes += result.bytes;
        if (totalImageBytes > limits.maxTotalImageBytes) {
          throw apiError(413, 'images_too_large', `Total image payload exceeds ${limits.maxTotalImageBytes} bytes.`);
        }
      }
    }
  }

  return { images, totalImageBytes };
}

module.exports = {
  base64Bytes,
  validateRequestPayload
};

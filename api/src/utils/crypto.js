const crypto = require('crypto');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function sha256(value) {
  return sha256Hex(value);
}

// Hash router API keys for DB storage
function hashRouterApiKey(apiKey) {
  return sha256Hex(apiKey);
}

// Constant-time comparison to reduce timing attacks
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');

  if (aa.length !== bb.length) {
    return false;
  }

  return crypto.timingSafeEqual(aa, bb);
}

function generateRouterApiKey() {
  return `rk_live_${crypto.randomBytes(24).toString('hex')}`;
}

function hashApiKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = {
  sha256Hex,
  sha256,
  generateRouterApiKey,
  hashApiKey,
  hashRouterApiKey,
  safeEqual
};

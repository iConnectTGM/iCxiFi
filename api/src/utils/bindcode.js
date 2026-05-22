const crypto = require('crypto');

function computeBindCode(routerId, timeWindow) {
  const secret = process.env.BIND_MASTER_SECRET || '';
  const input = `${routerId}:${timeWindow}`;
  const hmacHex = crypto.createHmac('sha256', secret).update(input).digest('hex');
  const last8Hex = hmacHex.slice(-8);
  const numericCode = parseInt(last8Hex, 16) % 1000000;
  return String(numericCode).padStart(6, '0');
}

function verifyBindCode(routerId, bindCode) {
  const code = String(bindCode || '').padStart(6, '0');
  const windowSeconds = Number(process.env.BIND_WINDOW_SECONDS || 60);
  const driftWindows = Number(process.env.BIND_DRIFT_WINDOWS || 1);
  const currentWindow = Math.floor(Date.now() / 1000 / windowSeconds);

  for (let offset = -driftWindows; offset <= driftWindows; offset += 1) {
    const testWindow = currentWindow + offset;
    if (computeBindCode(routerId, testWindow) === code) {
      return true;
    }
  }

  return false;
}

function getCurrentBindCode(routerId) {
  const windowSeconds = Number(process.env.BIND_WINDOW_SECONDS || 60);
  const currentWindow = Math.floor(Date.now() / 1000 / windowSeconds);
  return computeBindCode(String(routerId), currentWindow);
}

module.exports = {
  computeBindCode,
  verifyBindCode,
  getCurrentBindCode
};

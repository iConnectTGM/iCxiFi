/**
 * Admin API auth - requires X-Admin-API-Key header matching ADMIN_API_KEY env.
 * Used for Phase 3 config push and command queue.
 */
function adminAuth(req, res, next) {
  const key = (process.env.ADMIN_API_KEY || '').trim();
  if (!key) {
    return res.status(503).json({ ok: false, error: 'Admin API not configured' });
  }

  const provided = (req.headers['x-admin-api-key'] || req.headers['X-Admin-API-Key'] || '').trim();
  if (!provided || provided !== key) {
    return res.status(401).json({ ok: false, error: 'Invalid admin credentials' });
  }

  next();
}

module.exports = { adminAuth };

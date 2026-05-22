const Router = require('../models/Router');
const { hashApiKey, safeEqual } = require('../utils/crypto');

async function authenticateRouter(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : '';
  const routerId = (req.headers['x-router-id'] || '').toString().trim();

  if (!token || !routerId) {
    return { error: 'Invalid router credentials' };
  }

  const tokenHash = hashApiKey(token);
  const router = await Router.findOne({ routerId })
    .select('tenantId routerId name status profile hotspot portal commandQueue meta licenseKey routerApiKeyHash')
    .lean();

  if (!router || !router.routerApiKeyHash) {
    return { error: 'Invalid router credentials' };
  }

  if (!safeEqual(router.routerApiKeyHash, tokenHash)) {
    return { error: 'Invalid router credentials' };
  }

  return { router };
}

// Authenticates router using:
// - Authorization: Bearer rk_live_...
// - X-Router-ID: <router fingerprint>
async function routerAuth(req, res, next) {
  try {
    const authResult = await authenticateRouter(req);
    if (authResult.error) {
      return res.status(401).json({ ok: false, error: authResult.error });
    }
    const router = authResult.router;

    if (router.status && router.status !== 'active') {
      return res.status(401).json({ ok: false, error: 'Invalid router credentials' });
    }

    req.router = router; // attach router context
    return next();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('routerAuth error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

async function routerAuthAnyStatus(req, res, next) {
  try {
    const authResult = await authenticateRouter(req);
    if (authResult.error) {
      return res.status(401).json({ ok: false, error: authResult.error });
    }
    req.router = authResult.router;
    return next();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('routerAuthAnyStatus error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

module.exports = { routerAuth, routerAuthAnyStatus };

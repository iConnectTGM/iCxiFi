const express = require('express');
const RouterModel = require('../models/Router');
const License = require('../models/License');
const User = require('../models/User');
const { verifyBindCode, getCurrentBindCode } = require('../utils/bindcode');
const { generateRouterApiKey, hashApiKey } = require('../utils/crypto');
const { routerAuthAnyStatus } = require('../middleware/routerAuth');

const router = express.Router();

/**
 * GET /api/router/bindcode?routerId=xx
 * Public: for router-local registration UI (LOGO themes). No auth - router not yet activated.
 */
router.get('/bindcode', (req, res) => {
  try {
    const routerId = (req.query.routerId || '').toString().trim();
    if (!routerId) {
      return res.status(400).json({ ok: false, error: 'routerId required' });
    }
    const bindCode = getCurrentBindCode(routerId);
    const windowSeconds = Number(process.env.BIND_WINDOW_SECONDS || 60);
    return res.json({
      ok: true,
      routerId,
      bindCode,
      displayCode: bindCode,
      expiresInSeconds: windowSeconds
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});
const activateCooldownSeconds = Number(process.env.ACTIVATE_COOLDOWN_SECONDS || 30);

function getRetryAfterSeconds(lastActivatedAt) {
  if (!lastActivatedAt) {
    return 0;
  }
  if (!Number.isFinite(activateCooldownSeconds) || activateCooldownSeconds <= 0) {
    return 0;
  }

  const activatedAtMs = new Date(lastActivatedAt).getTime();
  if (Number.isNaN(activatedAtMs)) {
    return 0;
  }

  const remainingMs = activatedAtMs + activateCooldownSeconds * 1000 - Date.now();
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

/**
 * POST /api/router/activate
 * Public: router-side activation (no user JWT)
 * Body: { routerName, routerId, bindCode, licenseKey }
 */
router.post('/activate', async (req, res) => {
  try {
    const { routerName, routerId, bindCode, licenseKey } = req.body || {};

    if (!routerName || !routerId || !bindCode || !licenseKey) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    const ok = verifyBindCode(String(routerId), String(bindCode));
    if (!ok) {
      return res.status(401).json({ ok: false, error: 'Invalid bind code' });
    }

    const lic = await License.findOne({ key: String(licenseKey) }).lean();
    if (!lic) {
      return res.status(404).json({ ok: false, error: 'License not found' });
    }
    if (!lic.isActive) {
      return res.status(403).json({ ok: false, error: 'License inactive' });
    }

    const existing = await RouterModel.findOne({ routerId: String(routerId) });
    if (existing) {
      if (String(existing.licenseKey) !== String(licenseKey)) {
        return res.status(403).json({ ok: false, error: 'License mismatch' });
      }

      const retryAfterSeconds = getRetryAfterSeconds(existing.lastActivatedAt);
      if (retryAfterSeconds > 0) {
        return res.status(429).json({
          ok: false,
          error: 'Activation cooldown',
          retryAfterSeconds
        });
      }

      const routerApiKey = generateRouterApiKey();
      // Only update these fields – never overwrite admin-edited name
      await RouterModel.updateOne(
        { routerId: String(routerId) },
        { $set: {
          routerApiKeyHash: hashApiKey(routerApiKey),
          status: 'active',
          lastActivatedAt: new Date()
        }}
      );
      return res.json({
        ok: true,
        routerId: existing.routerId,
        routerApiKey,
        rotated: true
      });
    }

    const used = await RouterModel.countDocuments({ licenseKey: lic.key });
    if (typeof lic.seatsRouters === 'number' && used >= lic.seatsRouters) {
      return res.status(403).json({ ok: false, error: 'No seats available' });
    }

    const routerApiKey = generateRouterApiKey();
    const routerApiKeyHash = hashApiKey(routerApiKey);

    const doc = await RouterModel.create({
      routerId: String(routerId),
      name: String(routerName),
      licenseKey: lic.key,
      tenantId: lic.assignedTenantId || null,
      status: 'active',
      routerApiKeyHash,
      lastActivatedAt: new Date()
    });

    return res.json({
      ok: true,
      routerId: doc.routerId,
      routerApiKey,
      rotated: false
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('router activate error', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

function deriveRouterState(routerDoc) {
  const status = String(routerDoc?.status || '').toLowerCase();
  const hasLicense = Boolean((routerDoc?.licenseKey || '').trim());

  if (!hasLicense) return 'no_license';
  if (status === 'disabled' || status === 'revoked') return 'inactive';
  if (status === 'active') return 'active';
  return 'inactive';
}

/**
 * GET /api/router/state
 * Router-authenticated state probe that works even when router status is disabled/revoked.
 * Requires Authorization + X-Router-ID.
 */
router.get('/state', routerAuthAnyStatus, async (req, res) => {
  try {
    const routerDoc = req.router || {};
    const state = deriveRouterState(routerDoc);

    let owner = null;
    if (routerDoc.tenantId) {
      owner = await User.findOne({ tenantId: routerDoc.tenantId, role: 'owner' })
        .select('name email')
        .lean();
    }

    return res.json({
      ok: true,
      routerId: routerDoc.routerId,
      routerName: routerDoc.name || '',
      status: routerDoc.status || 'unknown',
      state,
      licenseKey: routerDoc.licenseKey || null,
      tenantId: routerDoc.tenantId || null,
      owner: owner
        ? {
            name: owner.name || '',
            email: owner.email || ''
          }
        : null,
      dashboardUrl: (
        process.env.CLIENT_DASHBOARD_URL
        || process.env.DASHBOARD_URL
        || process.env.PUBLIC_DASHBOARD_URL
        || ''
      ).trim()
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('router state error', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = { routerActivateRoutes: router };

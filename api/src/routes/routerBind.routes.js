const express = require('express');

const requireAuth = require('../middleware/authJwt');
const License = require('../models/License');
const RouterModel = require('../models/Router');
const { verifyBindCode } = require('../utils/bindcode');
const { generateRouterApiKey, hashApiKey } = require('../utils/crypto');

const router = express.Router();

router.post('/bind', requireAuth, async (req, res) => {
  try {
    const { routerName, routerId, bindCode, licenseKey } = req.body || {};
    const tenantId = req.user && req.user.tenantId;

    if (!tenantId) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    if (!routerName || !routerId || !bindCode || !licenseKey) {
      return res
        .status(400)
        .json({ error: 'routerName, routerId, bindCode and licenseKey are required' });
    }

    if (!verifyBindCode(routerId, bindCode)) {
      return res.status(400).json({ error: 'Invalid bind code' });
    }

    const license = await License.findOne({ key: licenseKey });
    if (!license || !license.isActive) {
      return res.status(403).json({ error: 'License is invalid or inactive' });
    }

    if (license.expiresAt && license.expiresAt.getTime() < Date.now()) {
      return res.status(403).json({ error: 'License expired' });
    }

    if (!license.assignedTenantId) {
      license.assignedTenantId = tenantId;
      license.assignedAt = new Date();
      await license.save();
    } else if (String(license.assignedTenantId) !== String(tenantId)) {
      return res.status(403).json({ error: 'License belongs to another tenant' });
    }

    const activeRouters = await RouterModel.countDocuments({ tenantId, status: 'active' });
    if (activeRouters >= license.seatsRouters) {
      return res.status(403).json({ error: 'Router seat limit reached' });
    }

    const existingRouter = await RouterModel.findOne({ routerId });
    if (existingRouter) {
      return res.status(409).json({ error: 'Router already bound' });
    }

    const rawApiKey = generateRouterApiKey();

    const createdRouter = await RouterModel.create({
      routerId,
      tenantId,
      licenseKey: license.key,
      name: routerName,
      routerApiKeyHash: hashApiKey(rawApiKey),
      status: 'active'
    });

    // routerApiKey is returned only once; store it securely on router.
    return res.json({
      ok: true,
      router: {
        routerId: createdRouter.routerId,
        name: createdRouter.name
      },
      routerApiKey: rawApiKey
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to bind router' });
  }
});

module.exports = router;

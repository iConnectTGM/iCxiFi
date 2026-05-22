/**
 * Client Dashboard API - scoped to logged-in user's tenant.
 * Requires JWT with role 'owner' (client).
 */
const express = require('express');
const crypto = require('crypto');
const requireAuth = require('../middleware/authJwt');
const { requireRole } = require('../middleware/requireRole');
const Router = require('../models/Router');
const Tenant = require('../models/Tenant');
const Voucher = require('../models/Voucher');
const License = require('../models/License');
const Session = require('../models/Session');
const SaleEvent = require('../models/SaleEvent');
const User = require('../models/User');
const LicenseTransferRequest = require('../models/LicenseTransferRequest');
const LicenseOnlyTransferRequest = require('../models/LicenseOnlyTransferRequest');
const { sanitizeProfile } = require('../utils/profile');
const {
  isMailerConfigured,
  sendRouterLicenseChangeEmail,
  sendRouterTransferRequestEmail,
  sendLicenseTransferRequestEmail
} = require('../utils/mailer');

const r = express.Router();

r.use(requireAuth);
r.use(requireRole(['owner']));

function getTenantId(req) {
  const tid = req.user && req.user.tenantId;
  if (!tid) return null;
  return tid;
}

function sanitizeRouterName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 80);
}

function sanitizeRouterDescription(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 280);
}

function dashboardUrlFromEnv() {
  return (
    process.env.CLIENT_DASHBOARD_URL
    || process.env.DASHBOARD_URL
    || process.env.PUBLIC_DASHBOARD_URL
    || ''
  ).trim();
}

function dashboardUrlFromRequest(req) {
  const fromEnv = dashboardUrlFromEnv();
  if (fromEnv) return fromEnv;
  return `${req.protocol}://${req.get('host')}/dashboard`;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function hashTransferToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
}

function asObjectIdString(value) {
  if (!value) return '';
  return String(value);
}

function parseTransferExpiryHours() {
  const parsed = Number(process.env.ROUTER_TRANSFER_TTL_HOURS || process.env.TRANSFER_REQUEST_TTL_HOURS || 24);
  if (!Number.isFinite(parsed) || parsed <= 0) return 24;
  return Math.min(Math.max(parsed, 1), 168);
}

function buildTransferAcceptUrl(req, requestId, rawToken) {
  const base = dashboardUrlFromRequest(req);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}auth=login&transferRequestId=${encodeURIComponent(requestId)}&transferToken=${encodeURIComponent(rawToken)}`;
}

function buildLicenseTransferAcceptUrl(req, requestId, rawToken) {
  const base = dashboardUrlFromRequest(req);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}auth=login&licenseTransferRequestId=${encodeURIComponent(requestId)}&licenseTransferToken=${encodeURIComponent(rawToken)}`;
}

function buildVoucherScopeFilter(tenantId, routerIds = [], { includeRedeemedRouter = false } = {}) {
  const scope = [{ tenantId }];
  if (Array.isArray(routerIds) && routerIds.length) {
    scope.push({ routerId: { $in: routerIds } });
    if (includeRedeemedRouter) {
      scope.push({ redeemedRouterId: { $in: routerIds } });
    }
  }
  return scope;
}

async function notifyOwnerRouterLicenseChange({
  tenantId,
  routerId,
  routerName,
  action,
  previousLicenseKey,
  licenseKey
}) {
  if (!isMailerConfigured()) return;
  try {
    const owner = await User.findOne({ tenantId, role: 'owner' })
      .select('email name')
      .lean();
    if (!owner || !owner.email) return;

    await sendRouterLicenseChangeEmail({
      to: owner.email,
      ownerName: owner.name || '',
      routerName: routerName || '',
      routerId: routerId || '',
      action,
      previousLicenseKey: previousLicenseKey || '',
      licenseKey: licenseKey || '',
      dashboardUrl: dashboardUrlFromEnv()
    });
  } catch (mailErr) {
    // eslint-disable-next-line no-console
    console.error('[client.router.notify]', mailErr.message);
  }
}

// GET /api/client/me - profile + license summary
r.get('/me', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(403).json({ ok: false, error: 'No tenant' });
    }

    const user = await User.findById(req.user.userId)
      .select('email name role createdAt')
      .lean();
    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const licenses = await License.find({
      assignedTenantId: tenantId,
      isActive: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
    }).lean();

    let totalSlots = 0;
    licenses.forEach((l) => {
      totalSlots += l.seatsRouters || 1;
    });

    const usedCount = await Router.countDocuments({ tenantId });
    const availableSlots = Math.max(0, totalSlots - usedCount);

    return res.json({
      ok: true,
      user: {
        email: user.email,
        name: user.name,
        role: user.role
      },
      license: {
        totalSlots,
        usedCount,
        availableSlots,
        licenses: licenses.map((l) => ({
          key: l.key,
          seatsRouters: l.seatsRouters || 1,
          expiresAt: l.expiresAt
        }))
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/client/routers - list routers for this tenant
r.get('/routers', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(403).json({ ok: false, error: 'No tenant' });
    }

    const routers = await Router.find({ tenantId })
      .select('-routerApiKeyHash')
      .sort({ lastSeenAt: -1 })
      .lean();

    return res.json({ ok: true, routers });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/client/routers/:routerId - details for one router (owned by tenant)
r.get('/routers/:routerId', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(403).json({ ok: false, error: 'No tenant' });
    }

    const routerId = (req.params.routerId || '').toString().trim();
    if (!routerId) {
      return res.status(400).json({ ok: false, error: 'routerId required' });
    }

    const router = await Router.findOne({ tenantId, routerId })
      .select('-routerApiKeyHash')
      .lean();
    if (!router) {
      return res.status(404).json({ ok: false, error: 'Router not found' });
    }

    return res.json({ ok: true, router });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PATCH /api/client/routers/:routerId - update router metadata/actions for tenant-owned router
r.patch('/routers/:routerId', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(403).json({ ok: false, error: 'No tenant' });
    }

    const routerId = (req.params.routerId || '').toString().trim();
    if (!routerId) {
      return res.status(400).json({ ok: false, error: 'routerId required' });
    }

    const body = req.body || {};
    const update = {};
    const routerBefore = await Router.findOne({ tenantId, routerId })
      .select('-routerApiKeyHash')
      .lean();
    if (!routerBefore) {
      return res.status(404).json({ ok: false, error: 'Router not found' });
    }

    let requestedStatus = null;
    let licenseAction = null;
    const oldLicenseKey = (routerBefore.licenseKey || '').trim();

    if (body.name !== undefined) {
      const name = sanitizeRouterName(body.name);
      if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
      update.name = name;
    }

    if (body.description !== undefined) {
      update.description = sanitizeRouterDescription(body.description);
    }

    if (body.hotspot !== undefined) {
      const h = body.hotspot;
      if (!h || typeof h !== 'object' || Array.isArray(h)) {
        return res.status(400).json({ ok: false, error: 'Invalid hotspot payload' });
      }
      const ssid = typeof h.ssid === 'string' ? h.ssid.trim().slice(0, 64) : '';
      const separateBands = h.separateBands === true || h.separateBands === 'true' || h.separateBands === 1 || h.separateBands === '1';
      const ssid24 = typeof h.ssid24 === 'string' ? h.ssid24.trim().slice(0, 64) : '';
      const ssid5 = typeof h.ssid5 === 'string' ? h.ssid5.trim().slice(0, 64) : '';
      const welcomeMsg = typeof h.welcomeMsg === 'string' ? h.welcomeMsg.trim().slice(0, 280) : '';
      update.hotspot = {
        ssid: ssid || null,
        welcomeMsg: welcomeMsg || null,
        separateBands,
        ssid24: separateBands ? (ssid24 || ssid || null) : null,
        ssid5: separateBands ? (ssid5 || ssid || null) : null
      };
    }

    if (body.profile !== undefined) {
      if (!body.profile || typeof body.profile !== 'object' || Array.isArray(body.profile)) {
        return res.status(400).json({ ok: false, error: 'Invalid profile payload' });
      }
      const nextProfile = { ...(routerBefore.profile || {}) };
      const incomingProfile = body.profile;

      if (incomingProfile.mode !== undefined) nextProfile.mode = incomingProfile.mode;
      if (incomingProfile.currency !== undefined) nextProfile.currency = incomingProfile.currency;
      if (incomingProfile.timezone !== undefined) nextProfile.timezone = incomingProfile.timezone;
      if (incomingProfile.voucherLength !== undefined) nextProfile.voucherLength = incomingProfile.voucherLength;
      if (incomingProfile.limits !== undefined) nextProfile.limits = incomingProfile.limits;
      if (incomingProfile.rates !== undefined) nextProfile.rates = incomingProfile.rates;
      if (incomingProfile.speedCalibration !== undefined) nextProfile.speedCalibration = incomingProfile.speedCalibration;

      update.profile = sanitizeProfile(nextProfile);
    }

    if (body.status !== undefined) {
      const status = (body.status || '').toString().trim().toLowerCase();
      if (!['active', 'disabled'].includes(status)) {
        return res.status(400).json({ ok: false, error: 'Invalid status' });
      }
      requestedStatus = status;
    }

    if (body.licenseKey !== undefined) {
      const licenseKey =
        typeof body.licenseKey === 'string' ? body.licenseKey.trim() : '';
      if (!licenseKey) {
        update.licenseKey = null;
        if (oldLicenseKey) licenseAction = 'removed';
      } else {
        const now = new Date();
        const lic = await License.findOne({
          key: licenseKey,
          assignedTenantId: tenantId,
          isActive: true,
          $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
        })
          .select('key')
          .lean();

        if (!lic) {
          return res.status(400).json({ ok: false, error: 'License key not assigned to your account' });
        }

        if (licenseKey !== oldLicenseKey) {
          const conflict = await Router.findOne({
            tenantId,
            routerId: { $ne: routerId },
            licenseKey
          })
            .select('routerId')
            .lean();
          if (conflict) {
            return res.status(409).json({
              ok: false,
              error: 'License key already used by another router',
              routerId: conflict.routerId
            });
          }
        }

        update.licenseKey = licenseKey;
        if (!oldLicenseKey) {
          licenseAction = 'added';
        } else if (oldLicenseKey !== licenseKey) {
          licenseAction = 'transferred';
        }
      }
    }

    const finalLicenseKey = update.licenseKey !== undefined
      ? update.licenseKey
      : (routerBefore.licenseKey || null);

    if (!finalLicenseKey) {
      if (requestedStatus === 'active') {
        return res.status(400).json({ ok: false, error: 'Cannot set active without a license key' });
      }
      // Strict behavior: no license means router is disabled.
      update.status = 'disabled';
    } else if (requestedStatus) {
      update.status = requestedStatus;
    } else if (body.licenseKey !== undefined && routerBefore.status !== 'active') {
      // If a license is attached again, restore active status by default.
      update.status = 'active';
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid fields to update' });
    }

    const router = await Router.findOneAndUpdate(
      { tenantId, routerId },
      { $set: update },
      { new: true }
    )
      .select('-routerApiKeyHash')
      .lean();

    if (!router) {
      return res.status(404).json({ ok: false, error: 'Router not found' });
    }

    if (licenseAction) {
      await notifyOwnerRouterLicenseChange({
        tenantId,
        routerId: router.routerId,
        routerName: router.name,
        action: licenseAction,
        previousLicenseKey: oldLicenseKey || '',
        licenseKey: router.licenseKey || ''
      });
    }

    return res.json({
      ok: true,
      updated: Object.keys(update),
      licenseAction,
      requiresReactivation: licenseAction === 'removed',
      router
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/client/routers/:routerId/sales/clear - clear sales records for one router
r.post('/routers/:routerId/sales/clear', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(403).json({ ok: false, error: 'No tenant' });
    }

    const routerId = (req.params.routerId || '').toString().trim();
    if (!routerId) {
      return res.status(400).json({ ok: false, error: 'routerId required' });
    }

    const router = await Router.findOne({ tenantId, routerId })
      .select('routerId')
      .lean();
    if (!router) {
      return res.status(404).json({ ok: false, error: 'Router not found' });
    }

    const [summary] = await SaleEvent.aggregate([
      { $match: { routerId } },
      { $group: { _id: null, totalAmount: { $sum: '$amount' }, totalSales: { $sum: 1 } } }
    ]);

    const deleted = await SaleEvent.deleteMany({ routerId });

    return res.json({
      ok: true,
      routerId,
      clearedAmount: Number(summary?.totalAmount || 0),
      clearedSales: Number(summary?.totalSales || 0),
      deleted: Number(deleted?.deletedCount || 0),
      message: 'Router sales cleared'
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/client/routers/:routerId - unbind router record (owner-side)
r.delete('/routers/:routerId', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(403).json({ ok: false, error: 'No tenant' });
    }

    const routerId = (req.params.routerId || '').toString().trim();
    if (!routerId) {
      return res.status(400).json({ ok: false, error: 'routerId required' });
    }

    const router = await Router.findOne({ tenantId, routerId })
      .select('routerId licenseKey')
      .lean();
    if (!router) {
      return res.status(404).json({ ok: false, error: 'Router not found' });
    }

    if ((router.licenseKey || '').trim()) {
      return res.status(409).json({
        ok: false,
        error: 'Remove license first before unbinding router'
      });
    }

    await Router.deleteOne({ tenantId, routerId });
    const now = new Date();
    await LicenseTransferRequest.updateMany(
      { routerId, status: 'pending' },
      { $set: { status: 'cancelled', cancelledAt: now } }
    );

    return res.json({
      ok: true,
      routerId,
      message: 'Router unbound. It can now be bound by another owner.'
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/client/routers/:routerId/transfer-request - request transfer to another client account
r.post('/routers/:routerId/transfer-request', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(403).json({ ok: false, error: 'No tenant' });
    }

    const routerId = (req.params.routerId || '').toString().trim();
    if (!routerId) {
      return res.status(400).json({ ok: false, error: 'routerId required' });
    }

    const targetEmail = normalizeEmail(req.body && req.body.targetEmail);
    if (!targetEmail || !targetEmail.includes('@')) {
      return res.status(400).json({ ok: false, error: 'Valid targetEmail is required' });
    }

    const mode = ((req.body && req.body.mode) || 'internal').toString().trim().toLowerCase() === 'email'
      ? 'email'
      : 'internal';
    if (mode === 'email' && !isMailerConfigured()) {
      return res.status(503).json({ ok: false, error: 'SMTP is not configured' });
    }

    const [router, fromUser, toUser] = await Promise.all([
      Router.findOne({ tenantId, routerId }).select('routerId name licenseKey tenantId').lean(),
      User.findById(req.user.userId).select('email name tenantId').lean(),
      User.findOne({ email: targetEmail, role: 'owner' }).select('_id email name tenantId').lean()
    ]);

    if (!router) {
      return res.status(404).json({ ok: false, error: 'Router not found' });
    }
    if (!router.licenseKey) {
      return res.status(400).json({ ok: false, error: 'Router has no license to transfer' });
    }
    if (!toUser || !toUser.tenantId) {
      return res.status(404).json({ ok: false, error: 'Target account is not registered' });
    }
    if (String(toUser.tenantId) === String(tenantId)) {
      return res.status(400).json({ ok: false, error: 'Target account already owns this router tenant' });
    }

    const now = new Date();
    const sourceLicense = await License.findOne({
      key: router.licenseKey,
      assignedTenantId: tenantId,
      isActive: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
    })
      .select('key')
      .lean();
    if (!sourceLicense) {
      return res.status(409).json({ ok: false, error: 'Router license is not valid for transfer' });
    }

    await LicenseTransferRequest.updateMany(
      { routerId, fromTenantId: tenantId, status: 'pending' },
      { $set: { status: 'cancelled', cancelledAt: now } }
    );

    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresInHours = parseTransferExpiryHours();
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    const transferRequest = await LicenseTransferRequest.create({
      routerId,
      licenseKey: router.licenseKey,
      fromTenantId: tenantId,
      toTenantId: toUser.tenantId,
      fromUserId: req.user.userId,
      toUserId: toUser._id,
      targetEmail: toUser.email || targetEmail,
      mode,
      tokenHash: hashTransferToken(rawToken),
      status: 'pending',
      expiresAt
    });

    if (mode === 'email') {
      const acceptUrl = buildTransferAcceptUrl(req, transferRequest._id.toString(), rawToken);
      try {
        await sendRouterTransferRequestEmail({
          to: toUser.email,
          fromOwnerName: (fromUser && fromUser.name) || '',
          fromOwnerEmail: (fromUser && fromUser.email) || '',
          routerName: router.name || '',
          routerId,
          licenseKey: router.licenseKey || '',
          acceptUrl,
          expiresInHours
        });
      } catch (mailError) {
        await LicenseTransferRequest.findByIdAndUpdate(
          transferRequest._id,
          { $set: { status: 'cancelled', cancelledAt: new Date() } },
          { new: false }
        );
        return res.status(502).json({ ok: false, error: 'Failed to send transfer request email' });
      }
    }

    return res.json({
      ok: true,
      message: mode === 'email' ? 'Transfer request sent' : 'Transfer request created',
      requestId: transferRequest._id,
      mode,
      targetEmail: toUser.email,
      expiresAt
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/client/transfers - list incoming/outgoing/history transfer requests
r.get('/transfers', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });

    const scope = String(req.query.scope || 'all').trim().toLowerCase();
    const statusFilter = String(req.query.status || '').trim().toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);

    const match = {
      $or: [{ fromTenantId: tenantId }, { toTenantId: tenantId }]
    };
    if (['pending', 'accepted', 'rejected', 'cancelled', 'expired'].includes(statusFilter)) {
      match.status = statusFilter;
    }

    const requests = await LicenseTransferRequest.find(match)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const routerIds = Array.from(new Set(requests.map((x) => x.routerId).filter(Boolean)));
    const userIds = Array.from(new Set(
      requests
        .flatMap((x) => [x.fromUserId, x.toUserId])
        .map((id) => asObjectIdString(id))
        .filter(Boolean)
    ));

    const [routers, users] = await Promise.all([
      routerIds.length
        ? Router.find({ routerId: { $in: routerIds } }).select('routerId name').lean()
        : [],
      userIds.length
        ? User.find({ _id: { $in: userIds } }).select('_id name email').lean()
        : []
    ]);

    const routerMap = Object.create(null);
    routers.forEach((x) => { if (x && x.routerId) routerMap[x.routerId] = x; });
    const userMap = Object.create(null);
    users.forEach((x) => { if (x && x._id) userMap[String(x._id)] = x; });

    const rows = requests
      .map((x) => {
        const fromSide = asObjectIdString(x.fromTenantId) === asObjectIdString(tenantId);
        const toSide = asObjectIdString(x.toTenantId) === asObjectIdString(tenantId);
        if (scope === 'incoming' && !toSide) return null;
        if (scope === 'outgoing' && !fromSide) return null;
        const fromUser = userMap[asObjectIdString(x.fromUserId)] || null;
        const toUser = userMap[asObjectIdString(x.toUserId)] || null;
        const router = routerMap[x.routerId] || null;
        return {
          requestId: x._id,
          routerId: x.routerId,
          routerName: (router && router.name) || '',
          licenseKey: x.licenseKey,
          targetEmail: x.targetEmail || '',
          mode: x.mode || 'email',
          status: x.status,
          expiresAt: x.expiresAt,
          createdAt: x.createdAt,
          acceptedAt: x.acceptedAt || null,
          rejectedAt: x.rejectedAt || null,
          cancelledAt: x.cancelledAt || null,
          resendCount: Number(x.resendCount || 0),
          lastResentAt: x.lastResentAt || null,
          fromUser: {
            name: (fromUser && fromUser.name) || '',
            email: (fromUser && fromUser.email) || ''
          },
          toUser: {
            name: (toUser && toUser.name) || '',
            email: (toUser && toUser.email) || ''
          },
          direction: fromSide ? 'outgoing' : 'incoming',
          canAccept: toSide && x.status === 'pending',
          canReject: toSide && x.status === 'pending',
          canCancel: fromSide && x.status === 'pending',
          canResend: fromSide && x.status === 'pending'
        };
      })
      .filter(Boolean);

    return res.json({ ok: true, transfers: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/client/transfers/accept - target account accepts transfer request
r.post('/transfers/accept', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(403).json({ ok: false, error: 'No tenant' });
    }

    const requestId = String((req.body && req.body.requestId) || '').trim();
    const token = String((req.body && req.body.token) || '').trim();
    if (!requestId) {
      return res.status(400).json({ ok: false, error: 'requestId is required' });
    }
    if (!/^[a-fA-F0-9]{24}$/.test(requestId)) {
      return res.status(400).json({ ok: false, error: 'Invalid requestId' });
    }

    const transferRequest = await LicenseTransferRequest.findById(requestId);
    if (!transferRequest) {
      return res.status(404).json({ ok: false, error: 'Transfer request not found' });
    }

    const now = new Date();
    if (transferRequest.status !== 'pending') {
      return res.status(409).json({ ok: false, error: `Transfer request is ${transferRequest.status}` });
    }

    if (!transferRequest.expiresAt || transferRequest.expiresAt <= now) {
      transferRequest.status = 'expired';
      await transferRequest.save();
      return res.status(410).json({ ok: false, error: 'Transfer request expired' });
    }

    const requestMode = transferRequest.mode || 'email';
    if (requestMode === 'email') {
      if (!token) {
        return res.status(400).json({ ok: false, error: 'token is required for email transfer' });
      }
      const tokenHash = hashTransferToken(token);
      if (tokenHash !== transferRequest.tokenHash) {
        return res.status(400).json({ ok: false, error: 'Invalid transfer token' });
      }
    }

    if (String(transferRequest.toTenantId) !== String(tenantId) || String(transferRequest.toUserId) !== String(req.user.userId)) {
      return res.status(403).json({ ok: false, error: 'This transfer request is for a different account' });
    }

    const router = await Router.findOne({
      routerId: transferRequest.routerId,
      tenantId: transferRequest.fromTenantId
    });
    if (!router) {
      return res.status(409).json({ ok: false, error: 'Router is no longer available to transfer' });
    }

    if ((router.licenseKey || '') !== (transferRequest.licenseKey || '')) {
      return res.status(409).json({ ok: false, error: 'Router license changed. Create a new transfer request' });
    }

    if (transferRequest.licenseKey) {
      const transferLicense = await License.findOne({
        key: transferRequest.licenseKey,
        assignedTenantId: transferRequest.fromTenantId,
        isActive: true,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
      })
        .select('_id')
        .lean();
      if (!transferLicense) {
        return res.status(409).json({ ok: false, error: 'Transfer license is no longer valid' });
      }

      const conflict = await Router.findOne({
        tenantId,
        routerId: { $ne: transferRequest.routerId },
        licenseKey: transferRequest.licenseKey
      })
        .select('routerId')
        .lean();
      if (conflict) {
        return res.status(409).json({
          ok: false,
          error: 'Target account already uses this license key',
          routerId: conflict.routerId
        });
      }
    }

    const movedRouter = await Router.findOneAndUpdate(
      { routerId: transferRequest.routerId, tenantId: transferRequest.fromTenantId },
      { $set: { tenantId: transferRequest.toTenantId } },
      { new: true }
    )
      .select('-routerApiKeyHash')
      .lean();
    if (!movedRouter) {
      return res.status(409).json({ ok: false, error: 'Router was changed before transfer could complete' });
    }

    if (transferRequest.licenseKey) {
      const movedLicense = await License.findOneAndUpdate(
        {
          key: transferRequest.licenseKey,
          assignedTenantId: transferRequest.fromTenantId
        },
        {
          $set: {
            assignedTenantId: transferRequest.toTenantId,
            assignedAt: now
          }
        },
        { new: true }
      )
        .select('key')
        .lean();
      if (!movedLicense) {
        await Router.findOneAndUpdate(
          { routerId: transferRequest.routerId, tenantId: transferRequest.toTenantId },
          { $set: { tenantId: transferRequest.fromTenantId } },
          { new: false }
        );
        return res.status(409).json({ ok: false, error: 'Could not transfer attached license' });
      }
    }

    await LicenseTransferRequest.updateMany(
      {
        routerId: transferRequest.routerId,
        status: 'pending',
        _id: { $ne: transferRequest._id }
      },
      { $set: { status: 'cancelled', cancelledAt: now } }
    );

    transferRequest.status = 'accepted';
    transferRequest.acceptedAt = now;
    await transferRequest.save();

    return res.json({
      ok: true,
      message: 'Router transfer completed',
      router: movedRouter
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/client/transfers/:requestId/reject - incoming user rejects transfer
r.post('/transfers/:requestId/reject', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });
    const requestId = String(req.params.requestId || '').trim();
    if (!/^[a-fA-F0-9]{24}$/.test(requestId)) {
      return res.status(400).json({ ok: false, error: 'Invalid requestId' });
    }

    const now = new Date();
    const doc = await LicenseTransferRequest.findOneAndUpdate(
      {
        _id: requestId,
        toTenantId: tenantId,
        toUserId: req.user.userId,
        status: 'pending'
      },
      { $set: { status: 'rejected', rejectedAt: now } },
      { new: true }
    )
      .select('_id status rejectedAt')
      .lean();
    if (!doc) return res.status(404).json({ ok: false, error: 'Pending transfer request not found' });
    return res.json({ ok: true, message: 'Transfer request rejected', transfer: doc });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/client/transfers/:requestId/cancel - sender cancels pending transfer
r.post('/transfers/:requestId/cancel', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });
    const requestId = String(req.params.requestId || '').trim();
    if (!/^[a-fA-F0-9]{24}$/.test(requestId)) {
      return res.status(400).json({ ok: false, error: 'Invalid requestId' });
    }

    const now = new Date();
    const doc = await LicenseTransferRequest.findOneAndUpdate(
      {
        _id: requestId,
        fromTenantId: tenantId,
        fromUserId: req.user.userId,
        status: 'pending'
      },
      { $set: { status: 'cancelled', cancelledAt: now } },
      { new: true }
    )
      .select('_id status cancelledAt')
      .lean();
    if (!doc) return res.status(404).json({ ok: false, error: 'Pending transfer request not found' });
    return res.json({ ok: true, message: 'Transfer request cancelled', transfer: doc });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/client/transfers/:requestId/resend - internal reminder for pending transfer
r.post('/transfers/:requestId/resend', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });
    const requestId = String(req.params.requestId || '').trim();
    if (!/^[a-fA-F0-9]{24}$/.test(requestId)) {
      return res.status(400).json({ ok: false, error: 'Invalid requestId' });
    }

    const now = new Date();
    const doc = await LicenseTransferRequest.findOneAndUpdate(
      {
        _id: requestId,
        fromTenantId: tenantId,
        fromUserId: req.user.userId,
        status: 'pending'
      },
      {
        $set: { lastResentAt: now },
        $inc: { resendCount: 1 }
      },
      { new: true }
    )
      .select('_id status resendCount lastResentAt mode')
      .lean();
    if (!doc) return res.status(404).json({ ok: false, error: 'Pending transfer request not found' });
    return res.json({
      ok: true,
      message: (doc.mode || 'email') === 'email' ? 'Transfer confirmation resent' : 'Transfer reminder resent internally',
      transfer: doc
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/client/licenses - list assigned active licenses + usage by routers
r.get('/licenses', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });

    const now = new Date();
    const [licenses, routers] = await Promise.all([
      License.find({
        assignedTenantId: tenantId,
        isActive: true,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
      })
        .select('key seatsRouters expiresAt assignedAt')
        .sort({ assignedAt: -1, key: 1 })
        .lean(),
      Router.find({ tenantId }).select('routerId name licenseKey').lean()
    ]);

    const usageMap = Object.create(null);
    routers.forEach((router) => {
      const key = (router.licenseKey || '').trim();
      if (!key || usageMap[key]) return;
      usageMap[key] = {
        routerId: router.routerId || '',
        routerName: router.name || ''
      };
    });

    return res.json({
      ok: true,
      licenses: licenses.map((lic) => {
        const usage = usageMap[lic.key] || null;
        return {
          key: lic.key,
          seatsRouters: lic.seatsRouters || 1,
          expiresAt: lic.expiresAt || null,
          assignedAt: lic.assignedAt || null,
          inUse: Boolean(usage),
          inUseByRouterId: usage ? usage.routerId : null,
          inUseByRouterName: usage ? usage.routerName : null
        };
      })
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/client/licenses/:licenseKey/transfer-request - request transfer of license only
r.post('/licenses/:licenseKey/transfer-request', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });

    const licenseKey = String(req.params.licenseKey || '').trim();
    if (!licenseKey) return res.status(400).json({ ok: false, error: 'licenseKey required' });

    const targetEmail = normalizeEmail(req.body && req.body.targetEmail);
    if (!targetEmail || !targetEmail.includes('@')) {
      return res.status(400).json({ ok: false, error: 'Valid targetEmail is required' });
    }

    const mode = ((req.body && req.body.mode) || 'internal').toString().trim().toLowerCase() === 'email'
      ? 'email'
      : 'internal';
    if (mode === 'email' && !isMailerConfigured()) {
      return res.status(503).json({ ok: false, error: 'SMTP is not configured' });
    }

    const now = new Date();
    const [license, fromUser, toUser, attachedRouter] = await Promise.all([
      License.findOne({
        key: licenseKey,
        assignedTenantId: tenantId,
        isActive: true,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
      })
        .select('key')
        .lean(),
      User.findById(req.user.userId).select('email name tenantId').lean(),
      User.findOne({ email: targetEmail, role: 'owner' }).select('_id email name tenantId').lean(),
      Router.findOne({ tenantId, licenseKey }).select('routerId name').lean()
    ]);

    if (!license) {
      return res.status(404).json({ ok: false, error: 'License not found in your account' });
    }
    if (attachedRouter) {
      return res.status(409).json({
        ok: false,
        error: 'License is attached to a router. Use router transfer for router+license.',
        routerId: attachedRouter.routerId
      });
    }
    if (!toUser || !toUser.tenantId) {
      return res.status(404).json({ ok: false, error: 'Target account is not registered' });
    }
    if (String(toUser.tenantId) === String(tenantId)) {
      return res.status(400).json({ ok: false, error: 'Target account already belongs to your tenant' });
    }

    await LicenseOnlyTransferRequest.updateMany(
      { licenseKey, fromTenantId: tenantId, status: 'pending' },
      { $set: { status: 'cancelled', cancelledAt: now } }
    );

    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresInHours = parseTransferExpiryHours();
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    const transferRequest = await LicenseOnlyTransferRequest.create({
      licenseKey,
      fromTenantId: tenantId,
      toTenantId: toUser.tenantId,
      fromUserId: req.user.userId,
      toUserId: toUser._id,
      targetEmail: toUser.email || targetEmail,
      mode,
      tokenHash: hashTransferToken(rawToken),
      status: 'pending',
      expiresAt
    });

    if (mode === 'email') {
      const acceptUrl = buildLicenseTransferAcceptUrl(req, transferRequest._id.toString(), rawToken);
      try {
        await sendLicenseTransferRequestEmail({
          to: toUser.email,
          fromOwnerName: (fromUser && fromUser.name) || '',
          fromOwnerEmail: (fromUser && fromUser.email) || '',
          licenseKey,
          acceptUrl,
          expiresInHours
        });
      } catch (mailError) {
        await LicenseOnlyTransferRequest.findByIdAndUpdate(
          transferRequest._id,
          { $set: { status: 'cancelled', cancelledAt: new Date() } },
          { new: false }
        );
        return res.status(502).json({ ok: false, error: 'Failed to send transfer request email' });
      }
    }

    return res.json({
      ok: true,
      message: mode === 'email' ? 'License transfer request sent' : 'License transfer request created',
      requestId: transferRequest._id,
      mode,
      targetEmail: toUser.email,
      expiresAt
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/client/license-transfers - list license transfer requests
r.get('/license-transfers', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });

    const scope = String(req.query.scope || 'all').trim().toLowerCase();
    const statusFilter = String(req.query.status || '').trim().toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);

    const match = { $or: [{ fromTenantId: tenantId }, { toTenantId: tenantId }] };
    if (['pending', 'accepted', 'rejected', 'cancelled', 'expired'].includes(statusFilter)) {
      match.status = statusFilter;
    }

    const requests = await LicenseOnlyTransferRequest.find(match)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const userIds = Array.from(new Set(
      requests
        .flatMap((x) => [x.fromUserId, x.toUserId])
        .map((id) => asObjectIdString(id))
        .filter(Boolean)
    ));
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('_id name email').lean()
      : [];
    const userMap = Object.create(null);
    users.forEach((x) => { if (x && x._id) userMap[String(x._id)] = x; });

    const rows = requests
      .map((x) => {
        const fromSide = asObjectIdString(x.fromTenantId) === asObjectIdString(tenantId);
        const toSide = asObjectIdString(x.toTenantId) === asObjectIdString(tenantId);
        if (scope === 'incoming' && !toSide) return null;
        if (scope === 'outgoing' && !fromSide) return null;
        const fromUser = userMap[asObjectIdString(x.fromUserId)] || null;
        const toUser = userMap[asObjectIdString(x.toUserId)] || null;
        return {
          requestId: x._id,
          licenseKey: x.licenseKey,
          targetEmail: x.targetEmail || '',
          mode: x.mode || 'email',
          status: x.status,
          expiresAt: x.expiresAt,
          createdAt: x.createdAt,
          acceptedAt: x.acceptedAt || null,
          rejectedAt: x.rejectedAt || null,
          cancelledAt: x.cancelledAt || null,
          resendCount: Number(x.resendCount || 0),
          lastResentAt: x.lastResentAt || null,
          fromUser: {
            name: (fromUser && fromUser.name) || '',
            email: (fromUser && fromUser.email) || ''
          },
          toUser: {
            name: (toUser && toUser.name) || '',
            email: (toUser && toUser.email) || ''
          },
          direction: fromSide ? 'outgoing' : 'incoming',
          canAccept: toSide && x.status === 'pending',
          canReject: toSide && x.status === 'pending',
          canCancel: fromSide && x.status === 'pending',
          canResend: fromSide && x.status === 'pending'
        };
      })
      .filter(Boolean);

    return res.json({ ok: true, transfers: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/client/license-transfers/accept - accept license transfer
r.post('/license-transfers/accept', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });

    const requestId = String((req.body && req.body.requestId) || '').trim();
    const token = String((req.body && req.body.token) || '').trim();
    if (!requestId) return res.status(400).json({ ok: false, error: 'requestId is required' });
    if (!/^[a-fA-F0-9]{24}$/.test(requestId)) {
      return res.status(400).json({ ok: false, error: 'Invalid requestId' });
    }

    const transferRequest = await LicenseOnlyTransferRequest.findById(requestId);
    if (!transferRequest) return res.status(404).json({ ok: false, error: 'Transfer request not found' });

    const now = new Date();
    if (transferRequest.status !== 'pending') {
      return res.status(409).json({ ok: false, error: `Transfer request is ${transferRequest.status}` });
    }
    if (!transferRequest.expiresAt || transferRequest.expiresAt <= now) {
      transferRequest.status = 'expired';
      await transferRequest.save();
      return res.status(410).json({ ok: false, error: 'Transfer request expired' });
    }

    const requestMode = transferRequest.mode || 'email';
    if (requestMode === 'email') {
      if (!token) return res.status(400).json({ ok: false, error: 'token is required for email transfer' });
      const tokenHash = hashTransferToken(token);
      if (tokenHash !== transferRequest.tokenHash) {
        return res.status(400).json({ ok: false, error: 'Invalid transfer token' });
      }
    }

    if (String(transferRequest.toTenantId) !== String(tenantId) || String(transferRequest.toUserId) !== String(req.user.userId)) {
      return res.status(403).json({ ok: false, error: 'This transfer request is for a different account' });
    }

    const sourceLicense = await License.findOne({
      key: transferRequest.licenseKey,
      assignedTenantId: transferRequest.fromTenantId,
      isActive: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
    })
      .select('key')
      .lean();
    if (!sourceLicense) {
      return res.status(409).json({ ok: false, error: 'License is no longer available for transfer' });
    }

    const sourceAttachedRouter = await Router.findOne({
      tenantId: transferRequest.fromTenantId,
      licenseKey: transferRequest.licenseKey
    })
      .select('routerId')
      .lean();
    if (sourceAttachedRouter) {
      return res.status(409).json({
        ok: false,
        error: 'License is attached to a router. Use router transfer for router+license.',
        routerId: sourceAttachedRouter.routerId
      });
    }

    const moved = await License.findOneAndUpdate(
      {
        key: transferRequest.licenseKey,
        assignedTenantId: transferRequest.fromTenantId
      },
      {
        $set: {
          assignedTenantId: transferRequest.toTenantId,
          assignedAt: now
        }
      },
      { new: true }
    )
      .select('key assignedTenantId assignedAt')
      .lean();
    if (!moved) {
      return res.status(409).json({ ok: false, error: 'License assignment changed before transfer could complete' });
    }

    await LicenseOnlyTransferRequest.updateMany(
      {
        licenseKey: transferRequest.licenseKey,
        status: 'pending',
        _id: { $ne: transferRequest._id }
      },
      { $set: { status: 'cancelled', cancelledAt: now } }
    );

    transferRequest.status = 'accepted';
    transferRequest.acceptedAt = now;
    await transferRequest.save();

    return res.json({
      ok: true,
      message: 'License transfer completed',
      license: moved
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/client/license-transfers/:requestId/reject - reject incoming license transfer
r.post('/license-transfers/:requestId/reject', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });
    const requestId = String(req.params.requestId || '').trim();
    if (!/^[a-fA-F0-9]{24}$/.test(requestId)) {
      return res.status(400).json({ ok: false, error: 'Invalid requestId' });
    }

    const now = new Date();
    const doc = await LicenseOnlyTransferRequest.findOneAndUpdate(
      {
        _id: requestId,
        toTenantId: tenantId,
        toUserId: req.user.userId,
        status: 'pending'
      },
      { $set: { status: 'rejected', rejectedAt: now } },
      { new: true }
    )
      .select('_id status rejectedAt')
      .lean();
    if (!doc) return res.status(404).json({ ok: false, error: 'Pending transfer request not found' });
    return res.json({ ok: true, message: 'License transfer request rejected', transfer: doc });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/client/license-transfers/:requestId/cancel - sender cancels pending license transfer
r.post('/license-transfers/:requestId/cancel', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });
    const requestId = String(req.params.requestId || '').trim();
    if (!/^[a-fA-F0-9]{24}$/.test(requestId)) {
      return res.status(400).json({ ok: false, error: 'Invalid requestId' });
    }

    const now = new Date();
    const doc = await LicenseOnlyTransferRequest.findOneAndUpdate(
      {
        _id: requestId,
        fromTenantId: tenantId,
        fromUserId: req.user.userId,
        status: 'pending'
      },
      { $set: { status: 'cancelled', cancelledAt: now } },
      { new: true }
    )
      .select('_id status cancelledAt')
      .lean();
    if (!doc) return res.status(404).json({ ok: false, error: 'Pending transfer request not found' });
    return res.json({ ok: true, message: 'License transfer request cancelled', transfer: doc });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/client/license-transfers/:requestId/resend - internal reminder for pending license transfer
r.post('/license-transfers/:requestId/resend', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });
    const requestId = String(req.params.requestId || '').trim();
    if (!/^[a-fA-F0-9]{24}$/.test(requestId)) {
      return res.status(400).json({ ok: false, error: 'Invalid requestId' });
    }

    const now = new Date();
    const doc = await LicenseOnlyTransferRequest.findOneAndUpdate(
      {
        _id: requestId,
        fromTenantId: tenantId,
        fromUserId: req.user.userId,
        status: 'pending'
      },
      {
        $set: { lastResentAt: now },
        $inc: { resendCount: 1 }
      },
      { new: true }
    )
      .select('_id status resendCount lastResentAt mode')
      .lean();
    if (!doc) return res.status(404).json({ ok: false, error: 'Pending transfer request not found' });
    return res.json({
      ok: true,
      message: (doc.mode || 'email') === 'email' ? 'License transfer confirmation resent' : 'License transfer reminder resent internally',
      transfer: doc
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/client/vouchers - list vouchers for this tenant's routers
r.get('/vouchers', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(403).json({ ok: false, error: 'No tenant' });
    }

    const routerIds = await Router.find({ tenantId }).distinct('routerId');
    const { status, routerId, limit = 50 } = req.query;
    const q = {
      $or: buildVoucherScopeFilter(tenantId, routerIds, { includeRedeemedRouter: true })
    };
    if (status) q.status = status;
    if (routerId && routerIds.includes(routerId)) {
      q.$and = [{ $or: [{ routerId }, { redeemedRouterId: routerId }] }];
    }

    const vouchers = await Voucher.find(q)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 200))
      .lean();

    return res.json({ ok: true, vouchers });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/client/sessions - list sessions for this tenant's routers
r.get('/sessions', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(403).json({ ok: false, error: 'No tenant' });
    }

    const routerIds = await Router.find({ tenantId }).distinct('routerId');
    const { status, limit = 50 } = req.query;
    const q = { routerId: { $in: routerIds } };
    if (status) q.status = status;

    const sessions = await Session.find(q)
      .sort({ startedAt: -1 })
      .limit(Math.min(Number(limit) || 50, 200))
      .lean();

    return res.json({ ok: true, sessions });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/client/reports/revenue - revenue for client's routers (daily, weekly, monthly, yearly)
r.get('/reports/revenue', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });
    const [routerIds, tenant] = await Promise.all([
      Router.find({ tenantId }).distinct('routerId'),
      Tenant.findById(tenantId).select('transactionHistoryClearedAt').lean()
    ]);
    if (!routerIds.length) {
      return res.json({ ok: true, daily: 0, weekly: 0, monthly: 0, yearly: 0 });
    }
    const clearedAt = tenant?.transactionHistoryClearedAt || null;

    const now = new Date();
    const dailyStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weeklyStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthlyStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearlyStart = new Date(now.getFullYear(), 0, 1);
    const baseMatch = { routerId: { $in: routerIds } };

    const agg = async (start) => {
      const periodStart = clearedAt && clearedAt > start ? clearedAt : start;
      const m = { ...baseMatch, ts: { $gte: periodStart, $lte: now } };
      const [saleRow] = await SaleEvent.aggregate([{ $match: m }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
      let total = saleRow ? saleRow.total : 0;
      const saleCodes = (await SaleEvent.find(m).distinct('voucherCode')).filter(Boolean);
      const vMatch = {
        status: 'redeemed',
        redeemedAt: { $gte: periodStart, $lte: now },
        $or: buildVoucherScopeFilter(tenantId, routerIds, { includeRedeemedRouter: true })
      };
      if (saleCodes.length) vMatch.code = { $nin: saleCodes };
      const [v] = await Voucher.aggregate([{ $match: vMatch }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
      return total + (v ? v.total : 0);
    };

    const [daily, weekly, monthly, yearly] = await Promise.all([
      agg(dailyStart),
      agg(weeklyStart),
      agg(monthlyStart),
      agg(yearlyStart)
    ]);
    return res.json({ ok: true, daily, weekly, monthly, yearly });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/client/reports/router-sales - per-router sales summary (default: today)
r.get('/reports/router-sales', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });

    const range = String(req.query.range || 'today').trim().toLowerCase();
    const now = new Date();
    let start = null;
    if (range === 'today' || range === 'daily') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (range === 'week' || range === 'weekly') {
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (range === 'month' || range === 'monthly') {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (range === 'year' || range === 'yearly') {
      start = new Date(now.getFullYear(), 0, 1);
    }

    const [routers, tenant] = await Promise.all([
      Router.find({ tenantId }).select('routerId name').lean(),
      Tenant.findById(tenantId).select('transactionHistoryClearedAt').lean()
    ]);
    if (!routers.length) {
      return res.json({ ok: true, range, rows: [] });
    }

    const routerIds = routers.map((r) => r.routerId).filter(Boolean);
    const clearedAt = tenant?.transactionHistoryClearedAt || null;
    const effectiveStart = clearedAt && (!start || clearedAt > start) ? clearedAt : start;
    const baseMatch = { routerId: { $in: routerIds } };
    const periodMatch = { ...baseMatch };
    if (effectiveStart) {
      periodMatch.ts = { $gte: effectiveStart, $lte: now };
    }

    const [groupedPeriod, groupedTotal] = await Promise.all([
      SaleEvent.aggregate([
        { $match: periodMatch },
        {
          $group: {
            _id: '$routerId',
            periodAmount: { $sum: '$amount' },
            periodSales: { $sum: 1 },
            periodLastSaleAt: { $max: '$ts' }
          }
        }
      ]),
      SaleEvent.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: '$routerId',
            totalAmount: { $sum: '$amount' },
            totalSales: { $sum: 1 },
            lastSaleAt: { $max: '$ts' }
          }
        }
      ])
    ]);

    const periodMap = Object.create(null);
    groupedPeriod.forEach((row) => {
      if (!row || !row._id) return;
      periodMap[row._id] = {
        periodAmount: Number(row.periodAmount || 0),
        periodSales: Number(row.periodSales || 0),
        periodLastSaleAt: row.periodLastSaleAt || null
      };
    });

    const totalMap = Object.create(null);
    groupedTotal.forEach((row) => {
      if (!row || !row._id) return;
      totalMap[row._id] = {
        totalAmount: Number(row.totalAmount || 0),
        totalSales: Number(row.totalSales || 0),
        lastSaleAt: row.lastSaleAt || null
      };
    });

    const rows = routers.map((router) => {
      const period = periodMap[router.routerId] || {};
      const total = totalMap[router.routerId] || {};
      return {
        routerId: router.routerId,
        name: router.name || '',
        periodAmount: Number(period.periodAmount || 0),
        periodSales: Number(period.periodSales || 0),
        periodLastSaleAt: period.periodLastSaleAt || null,
        totalAmount: Number(total.totalAmount || 0),
        totalSales: Number(total.totalSales || 0),
        lastSaleAt: total.lastSaleAt || null
      };
    });

    return res.json({
      ok: true,
      range,
      rows
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/client/reports/revenue-chart - daily revenue chart (days=30)
r.get('/reports/revenue-chart', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });
    const [routerIds, tenant] = await Promise.all([
      Router.find({ tenantId }).distinct('routerId'),
      Tenant.findById(tenantId).select('transactionHistoryClearedAt').lean()
    ]);
    const clearedAt = tenant?.transactionHistoryClearedAt || null;
    const numDays = Math.min(Math.max(7, Number(req.query.days) || 30), 90);
    const now = new Date();
    const labels = [];
    const values = [];

    for (let i = numDays - 1; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      labels.push(d.toISOString().slice(0, 10));

      const periodStart = clearedAt && clearedAt > d ? clearedAt : d;
      if (periodStart >= next) {
        values.push(0);
        continue;
      }
      const match = routerIds.length ? { routerId: { $in: routerIds }, ts: { $gte: periodStart, $lt: next } } : { ts: { $gte: periodStart, $lt: next } };
      const [sale] = await SaleEvent.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
      let total = sale ? sale.total : 0;
      const vMatch = {
        status: 'redeemed',
        redeemedAt: { $gte: periodStart, $lt: next },
        $or: buildVoucherScopeFilter(tenantId, routerIds, { includeRedeemedRouter: true })
      };
      const saleCodes = (await SaleEvent.find(match).distinct('voucherCode')).filter(Boolean);
      if (saleCodes.length) vMatch.code = { $nin: saleCodes };
      const [v] = await Voucher.aggregate([{ $match: vMatch }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
      values.push(total + (v ? v.total : 0));
    }
    return res.json({ ok: true, labels, values });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/client/reports/transactions - transaction history for client's routers
r.get('/reports/transactions', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });
    const tenant = await Tenant.findById(tenantId).select('transactionHistoryClearedAt').lean();
    const clearedAt = tenant?.transactionHistoryClearedAt;
    const routerIds = await Router.find({ tenantId }).distinct('routerId');
    const { from, to, limit = 50 } = req.query;
    const maxLimit = 5000;
    const match = routerIds.length ? { routerId: { $in: routerIds } } : {};
    if (clearedAt) match.ts = { $gt: clearedAt };
    if (from || to) {
      match.ts = match.ts || {};
      if (from) match.ts.$gte = new Date(from);
      if (to) match.ts.$lte = new Date(to);
    }

    const reqLimit = Math.min(Math.max(1, Number(limit) || 50), maxLimit);
    const sales = await SaleEvent.find(match)
      .sort({ ts: -1 })
      .limit(reqLimit)
      .lean();

    const vMatch = {
      status: 'redeemed',
      $or: buildVoucherScopeFilter(tenantId, routerIds, { includeRedeemedRouter: true })
    };
    if (clearedAt || from || to) {
      vMatch.redeemedAt = {};
      if (clearedAt) vMatch.redeemedAt.$gt = clearedAt;
      if (from) vMatch.redeemedAt.$gte = new Date(from);
      if (to) vMatch.redeemedAt.$lte = new Date(to);
    }
    const vouchers = await Voucher.find(vMatch).sort({ redeemedAt: -1 }).limit(reqLimit).lean();

    const salesWithMethod = sales.map((s) => ({
      id: s._id.toString(),
      type: 'sale',
      routerId: s.routerId,
      clientDevice: s.deviceId || s.voucherCode || '-',
      amount: s.amount,
      method: s.deviceId ? 'vendo' : 'manual',
      date: s.ts
    }));
    const voucherRows = vouchers
      .filter(
        (v) =>
          !sales.some(
            (s) => s.voucherCode === v.code && Math.abs(new Date(s.ts) - new Date(v.redeemedAt)) < 60000
          )
      )
      .map((v) => ({
        id: v._id.toString(),
        type: 'redeem',
        routerId: v.redeemedRouterId || v.routerId,
        clientDevice: (v.redeemedClient && (v.redeemedClient.ip || v.redeemedClient.mac)) || v.code || '-',
        amount: v.amount,
        method: 'portal',
        date: v.redeemedAt
      }));

    const transactions = [...salesWithMethod, ...voucherRows]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, reqLimit);
    return res.json({ ok: true, transactions });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/client/reports/transactions/clear - clear SaleEvents + hide old voucher redemptions
async function clearClientTransactions(req, res) {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });
    const routerIds = await Router.find({ tenantId }).distinct('routerId');
    const clearedAt = new Date();
    const saleResult = await SaleEvent.deleteMany({ routerId: { $in: routerIds } });
    await Tenant.findByIdAndUpdate(tenantId, { transactionHistoryClearedAt: clearedAt });
    const total = saleResult.deletedCount || 0;
    return res.json({ ok: true, deleted: total, message: 'Transaction history cleared' });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
r.post('/reports/transactions/clear', clearClientTransactions);
r.delete('/reports/transactions/clear', clearClientTransactions);

// POST /api/client/vouchers/bulk - bulk create vouchers (router must belong to client's tenant)
r.post('/vouchers/bulk', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ ok: false, error: 'No tenant' });

    const { routerId, count, amount, minutes, expiryHours } = req.body || {};
    if (!routerId || typeof routerId !== 'string' || !routerId.trim()) {
      return res.status(400).json({ ok: false, error: 'routerId required' });
    }

    const router = await Router.findOne({ routerId: routerId.trim(), tenantId });
    if (!router) {
      return res.status(404).json({ ok: false, error: 'Router not found or not yours' });
    }

    const profile = sanitizeProfile(router.profile);
    const numCount = Math.min(Math.max(1, Number(count) || 10), 100);
    const numAmount = Number(amount);
    const numMinutes = Number(minutes);

    let matched = profile.rates?.[0];
    if (Number.isFinite(numAmount) && numAmount > 0) {
      const byAmount = profile.rates?.find((r) => r.amount === numAmount);
      if (byAmount) {
        matched = Number.isFinite(numMinutes) && numMinutes > 0
          ? profile.rates?.find((r) => r.amount === numAmount && r.minutes === numMinutes) || byAmount
          : byAmount;
      }
    }
    if (!matched) return res.status(400).json({ ok: false, error: 'No rate configured for router' });

    const hours = Math.min(Math.max(1, Number(expiryHours) || 24), 168);
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    function randomSuffix(len) {
      let out = '';
      for (let i = 0; i < len; i += 1) out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
      return out;
    }

    const downloadKbps = matched.downloadKbps || 10000;
    const uploadKbps = matched.uploadKbps || 10000;
    const downloadQuotaKB = Number.isFinite(matched.downloadQuotaKB) ? matched.downloadQuotaKB : 0;
    const uploadQuotaKB = Number.isFinite(matched.uploadQuotaKB) ? matched.uploadQuotaKB : 0;
    const rid = routerId.trim();
    const vLen = profile.voucherLength || 8;
    const vouchers = [];

    for (let i = 0; i < numCount; i += 1) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const code = randomSuffix(vLen);
        try {
          const v = await Voucher.create({
            routerId: rid,
            tenantId,
            code,
            minutes: matched.minutes,
            amount: matched.amount,
            downloadKbps,
            uploadKbps,
            downloadQuotaKB,
            uploadQuotaKB,
            status: 'unused',
            expiresAt
          });
          vouchers.push({ code: v.code, minutes: v.minutes, amount: v.amount, expiresAt: v.expiresAt });
          break;
        } catch (err) {
          if (err?.code === 11000) continue;
          throw err;
        }
      }
    }

    return res.json({ ok: true, routerId: rid, created: vouchers.length, vouchers });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Server error' });
  }
});

// GET /api/client/bindcode?routerId=xx - get bind code for registering a new router
r.get('/bindcode', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(403).json({ ok: false, error: 'No tenant' });
    }

    const routerId = (req.query.routerId || '').toString().trim();
    if (!routerId) {
      return res.status(400).json({ ok: false, error: 'routerId required' });
    }

    const { getCurrentBindCode } = require('../utils/bindcode');
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

module.exports = r;

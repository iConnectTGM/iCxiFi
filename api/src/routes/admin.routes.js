/**
 * Phase 3: Admin API for remote router management.
 * Phase 7: Admin dashboard data.
 * Protects: X-Admin-API-Key header (ADMIN_API_KEY env).
 */
const crypto = require('crypto');
const express = require('express');
const { adminAuth } = require('../middleware/adminAuth');
const Router = require('../models/Router');
const License = require('../models/License');
const Tenant = require('../models/Tenant');
const User = require('../models/User');
const Voucher = require('../models/Voucher');
const Session = require('../models/Session');
const SaleEvent = require('../models/SaleEvent');
const LicenseTransferRequest = require('../models/LicenseTransferRequest');
const { sanitizeProfile } = require('../utils/profile');
const { getCurrentBindCode } = require('../utils/bindcode');

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomVoucherSuffix(length) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

const LICENSE_HEX = '0123456789ABCDEF';
function randomLicenseSegment(len = 5) {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += LICENSE_HEX[crypto.randomInt(0, LICENSE_HEX.length)];
  }
  return out;
}
function generateLicenseKey() {
  const segs = Array.from({ length: 6 }, () => randomLicenseSegment(5));
  return `ICXF-${segs.join('-')}`;
}

function dateRange(range) {
  const now = new Date();
  let start;
  switch (range) {
    case 'daily':
    case 'today':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'weekly':
    case 'week':
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'monthly':
    case 'month':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'yearly':
    case 'year':
      start = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  return { start, end: now };
}

const r = express.Router();

r.use(adminAuth);

// GET /api/admin/stats - platform overview for admin dashboard
r.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);

    const [licenseCount, licenseAssigned, licenseUnassigned, totalLicenseSeats, usedLicenseSeats] = await Promise.all([
      License.countDocuments({ isActive: true }),
      License.countDocuments({ isActive: true, assignedTenantId: { $ne: null } }),
      License.countDocuments({ isActive: true, $or: [{ assignedTenantId: null }, { assignedTenantId: { $exists: false } }] }),
      License.aggregate([{ $match: { isActive: true } }, { $group: { _id: null, total: { $sum: '$seatsRouters' } } }]).then((r) => r[0]?.total ?? 0),
      Router.countDocuments({ licenseKey: { $exists: true, $ne: null } })
    ]);

    const customerCount = await Tenant.countDocuments();
    const routerCount = await Router.countDocuments();
    const routerOnlineCount = await Router.countDocuments({ lastSeenAt: { $gte: twoMinutesAgo } });
    const voucherCount = await Voucher.countDocuments();
    const voucherRedeemedCount = await Voucher.countDocuments({ status: 'redeemed' });

    return res.json({
      ok: true,
      licenses: {
        total: licenseCount,
        assigned: licenseAssigned,
        unassigned: licenseUnassigned,
        totalSeats: totalLicenseSeats || 0,
        usedSeats: usedLicenseSeats,
        availableSeats: Math.max(0, (totalLicenseSeats || 0) - usedLicenseSeats)
      },
      customers: customerCount,
      routers: { total: routerCount, online: routerOnlineCount, offline: routerCount - routerOnlineCount },
      vouchers: { total: voucherCount, redeemed: voucherRedeemedCount, unused: voucherCount - voucherRedeemedCount }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/admin/bindcode - get current bind code for a routerId (for copy-to-router during activation)
r.get('/bindcode', async (req, res) => {
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
      expiresInSeconds: windowSeconds,
      activateUrl: `/api/router/activate`
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/admin/licenses/generate - create new license keys (1 license = 1 router)
r.post('/licenses/generate', async (req, res) => {
  try {
    const seatsRouters = 1; // 1 router per license
    const count = Math.min(20, Math.max(1, Number(req.body.count) || 1));

    const licenses = [];
    for (let i = 0; i < count; i += 1) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const key = generateLicenseKey();
        try {
          await License.create({
            key,
            seatsRouters,
            isActive: true
          });
          licenses.push({ key, seatsRouters });
          break;
        } catch (err) {
          if (err && err.code === 11000) continue;
          throw err;
        }
      }
    }

    return res.json({
      ok: true,
      created: licenses.length,
      licenses: licenses.map((l) => ({ key: l.key, seatsRouters: l.seatsRouters }))
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Server error' });
  }
});

// GET /api/admin/licenses - list licenses with status (available / bound)
r.get('/licenses', async (req, res) => {
  try {
    const licenses = await License.find({ isActive: true })
      .select('key seatsRouters expiresAt assignedTenantId assignedAt')
      .sort({ _id: -1 })
      .lean();
    const tenantIds = [...new Set(licenses.map((l) => l.assignedTenantId).filter(Boolean))];
    const tenants = tenantIds.length
      ? await Tenant.find({ _id: { $in: tenantIds } }).lean()
      : [];
    const users = tenantIds.length
      ? await User.find({ tenantId: { $in: tenantIds }, role: 'owner' }).select('email name tenantId').lean()
      : [];
    const byTenant = {};
    tenants.forEach((t) => { byTenant[t._id.toString()] = t; });
    users.forEach((u) => {
      if (u.tenantId) byTenant[u.tenantId.toString()] = { ...(byTenant[u.tenantId.toString()] || {}), ownerEmail: u.email, ownerName: u.name };
    });
    const list = licenses.map((l) => {
      const tid = l.assignedTenantId && l.assignedTenantId.toString();
      const t = tid ? byTenant[tid] : null;
      return {
        key: l.key,
        seatsRouters: l.seatsRouters,
        expiresAt: l.expiresAt,
        assignedAt: l.assignedAt,
        status: tid ? 'bound' : 'available',
        assignedTo: t ? (t.ownerEmail || t.name || 'Tenant') : null
      };
    });
    return res.json({ ok: true, licenses: list });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/admin/licenses/transfers - license transfer history (assigned licenses)
r.get('/licenses/transfers', async (req, res) => {
  try {
    const { from, to, limit } = req.query;
    const q = { assignedTenantId: { $ne: null }, assignedAt: { $ne: null } };
    if (from || to) {
      const dateQ = {};
      if (from) {
        const fd = new Date(from);
        if (!isNaN(fd.getTime())) dateQ.$gte = fd;
      }
      if (to) {
        const td = new Date(to);
        if (!isNaN(td.getTime())) {
          td.setHours(23, 59, 59, 999);
          dateQ.$lte = td;
        }
      }
      if (Object.keys(dateQ).length) q.assignedAt = dateQ;
    }
    const licenses = await License.find(q)
      .select('key assignedTenantId assignedAt')
      .sort({ assignedAt: -1 })
      .limit(Math.min(Number(limit) || 100, 5000))
      .lean();
    const tenantIds = [...new Set(licenses.map((l) => l.assignedTenantId).filter(Boolean))];
    const users = tenantIds.length
      ? await User.find({ tenantId: { $in: tenantIds }, role: 'owner' }).select('email name tenantId').lean()
      : [];
    const tenants = tenantIds.length ? await Tenant.find({ _id: { $in: tenantIds } }).select('name').lean() : [];
    const byTenant = {};
    tenants.forEach((t) => { byTenant[t._id.toString()] = t; });
    users.forEach((u) => {
      if (u.tenantId) byTenant[u.tenantId.toString()] = { ...(byTenant[u.tenantId.toString()] || {}), email: u.email, name: u.name };
    });
    const transfers = licenses.map((l) => {
      const tid = l.assignedTenantId && l.assignedTenantId.toString();
      const t = tid ? byTenant[tid] : null;
      return {
        key: l.key,
        recipient: t ? (t.email || t.name || 'Unknown') : null,
        date: l.assignedAt
      };
    });
    return res.json({ ok: true, transfers });
  } catch (error) {
    console.error('[licenses/transfers]', error);
    return res.status(500).json({ ok: false, error: error.message || 'Server error' });
  }
});

// GET /api/admin/tenants - list tenants (clients) for license assignment
r.get('/tenants', async (req, res) => {
  try {
    const tenants = await Tenant.find()
      .lean();
    const users = await User.find({ tenantId: { $in: tenants.map((t) => t._id) }, role: 'owner' })
      .select('email name tenantId')
      .lean();
    const byTenant = {};
    users.forEach((u) => {
      if (u.tenantId) byTenant[u.tenantId.toString()] = u;
    });
    const list = tenants.map((t) => ({
      _id: t._id,
      name: t.name,
      routerCount: 0,
      ownerEmail: byTenant[t._id.toString()] ? byTenant[t._id.toString()].email : null
    }));
    for (const t of list) {
      t.routerCount = await Router.countDocuments({ tenantId: t._id });
    }
    return res.json({ ok: true, tenants: list });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PATCH /api/admin/licenses/:key/assign - assign license to tenant (body: { tenantId } or { email })
r.patch('/licenses/:key/assign', async (req, res) => {
  try {
    const key = (req.params.key || '').toString().trim();
    const { tenantId, email } = req.body || {};

    if (!key) {
      return res.status(400).json({ ok: false, error: 'License key required' });
    }

    let targetTenantId = tenantId;
    if (!targetTenantId && email) {
      const user = await User.findOne({ email: String(email).toLowerCase().trim() }).lean();
      if (!user || !user.tenantId) {
        return res.status(404).json({ ok: false, error: 'User/tenant not found for email' });
      }
      targetTenantId = user.tenantId;
    }

    if (!targetTenantId) {
      return res.status(400).json({ ok: false, error: 'tenantId or email required' });
    }

    const lic = await License.findOneAndUpdate(
      { key },
      { $set: { assignedTenantId: targetTenantId, assignedAt: new Date() } },
      { new: true }
    );

    if (!lic) {
      return res.status(404).json({ ok: false, error: 'License not found' });
    }

    return res.json({
      ok: true,
      key: lic.key,
      assignedTenantId: lic.assignedTenantId,
      assignedAt: lic.assignedAt
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/admin/licenses/check?key=LIC-xxx - check a license (validity, seats, expiry, used count)
r.get('/licenses/check', async (req, res) => {
  try {
    const key = (req.query.key || '').toString().trim();
    if (!key) {
      return res.status(400).json({ ok: false, error: 'key query required' });
    }
    const lic = await License.findOne({ key }).lean();
    if (!lic) {
      return res.json({ ok: true, found: false, key, valid: false, error: 'License not found' });
    }
    const used = await Router.countDocuments({ licenseKey: lic.key });
    const now = Date.now();
    const isActive = !!lic.isActive;
    const expired = lic.expiresAt ? new Date(lic.expiresAt).getTime() <= now : false;
    const valid = isActive && !expired;
    return res.json({
      ok: true,
      found: true,
      key: lic.key,
      valid,
      isActive,
      expired,
      seatsRouters: lic.seatsRouters ?? 1,
      usedCount: used,
      seatsAvailable: Math.max(0, (lic.seatsRouters ?? 1) - used),
      expiresAt: lic.expiresAt || null,
      assignedTenantId: lic.assignedTenantId || null
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/admin/routers - list all routers
r.get('/routers', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache');
    const routers = await Router.find()
      .select('-routerApiKeyHash')
      .sort({ lastSeenAt: -1 })
      .lean();
    return res.json({ ok: true, routers });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/admin/vouchers - list vouchers (optional routerId, status, limit)
r.get('/vouchers', async (req, res) => {
  try {
    const { routerId, status, limit = 50 } = req.query;
    const q = {};
    if (routerId) q.routerId = routerId;
    if (status) q.status = status;
    const vouchers = await Voucher.find(q)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 200))
      .lean();
    return res.json({ ok: true, vouchers });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/admin/vouchers/bulk - bulk create vouchers
r.post('/vouchers/bulk', async (req, res) => {
  try {
    const { routerId, count, amount, minutes, expiryHours } = req.body || {};

    if (!routerId || typeof routerId !== 'string' || !routerId.trim()) {
      return res.status(400).json({ ok: false, error: 'routerId required' });
    }

    const router = await Router.findOne({ routerId: routerId.trim() });
    if (!router) {
      return res.status(404).json({ ok: false, error: 'Router not found' });
    }

    const profile = sanitizeProfile(router.profile);
    const numCount = Math.min(Math.max(1, Number(count) || 10), 100);
    const numAmount = Number(amount);
    const numMinutes = Number(minutes);

    let matched = null;
    if (Number.isFinite(numAmount) && numAmount > 0) {
      matched = profile.rates.find((r) => r.amount === numAmount);
      if (matched && Number.isFinite(numMinutes) && numMinutes > 0) {
        const byMinutes = profile.rates.find((r) => r.amount === numAmount && r.minutes === numMinutes);
        if (byMinutes) matched = byMinutes;
      }
    }
    if (!matched) {
      matched = profile.rates[0];
    }
    if (!matched) {
      return res.status(400).json({ ok: false, error: 'No rate configured for router' });
    }

    const hours = Math.min(Math.max(1, Number(expiryHours) || 24), 168);
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

    const downloadKbps = matched.downloadKbps || 10000;
    const uploadKbps = matched.uploadKbps || 10000;
    const downloadQuotaKB = Number.isFinite(matched.downloadQuotaKB) ? matched.downloadQuotaKB : 0;
    const uploadQuotaKB = Number.isFinite(matched.uploadQuotaKB) ? matched.uploadQuotaKB : 0;

    const vouchers = [];
    const rid = routerId.trim();
    const tenantId = router.tenantId || null;

    for (let i = 0; i < numCount; i += 1) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const code = randomVoucherSuffix(profile.voucherLength);
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
          if (err && err.code === 11000) continue;
          throw err;
        }
      }
    }

    return res.json({
      ok: true,
      routerId: rid,
      created: vouchers.length,
      vouchers
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Server error' });
  }
});

// GET /api/admin/sessions - list sessions (optional routerId, status, limit)
r.get('/sessions', async (req, res) => {
  try {
    const { routerId, status, limit = 50 } = req.query;
    const q = {};
    if (routerId) q.routerId = routerId;
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

// PATCH /api/admin/routers/:routerId/config
r.patch('/routers/:routerId/config', async (req, res) => {
  try {
    const { routerId } = req.params;
    const body = req.body || {};

    const update = {};

    if (body.profile !== undefined) {
      update.profile = sanitizeProfile(body.profile);
    }

    if (body.hotspot !== undefined) {
      const h = body.hotspot;
      const separateBands = h && (h.separateBands === true || h.separateBands === 'true' || h.separateBands === 1 || h.separateBands === '1');
      const ssid = typeof h.ssid === 'string' ? h.ssid.trim().slice(0, 64) : null;
      const ssid24 = typeof h.ssid24 === 'string' ? h.ssid24.trim().slice(0, 64) : null;
      const ssid5 = typeof h.ssid5 === 'string' ? h.ssid5.trim().slice(0, 64) : null;
      update.hotspot = {
        ssid: ssid || null,
        welcomeMsg: typeof h.welcomeMsg === 'string' ? h.welcomeMsg.trim().slice(0, 280) : null,
        separateBands,
        ssid24: separateBands ? (ssid24 || ssid || null) : null,
        ssid5: separateBands ? (ssid5 || ssid || null) : null
      };
    }

    if (body.portal !== undefined) {
      const p = body.portal;
      const theme = ['default', 'blue', 'starlink'].includes(p.theme) ? p.theme : 'default';
      update.portal = { theme };
    }

    if (body.status !== undefined && ['active', 'disabled', 'revoked'].includes(body.status)) {
      update.status = body.status;
    }

    if (body.licenseKey !== undefined) {
      update.licenseKey = typeof body.licenseKey === 'string' ? body.licenseKey.trim() || null : null;
    }

    if (body.name !== undefined) {
      const n = typeof body.name === 'string' ? body.name.trim() : '';
      if (n) update.name = n;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid config fields to update' });
    }

    const router = await Router.findOneAndUpdate(
      { routerId },
      { $set: update },
      { new: true }
    );

    if (!router) {
      return res.status(404).json({ ok: false, error: 'Router not found' });
    }

    return res.json({
      ok: true,
      routerId: router.routerId,
      name: router.name,
      updated: Object.keys(update)
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/admin/routers/:routerId/commands
r.post('/routers/:routerId/commands', async (req, res) => {
  try {
    const { routerId } = req.params;
    const { type, payload } = req.body || {};

    if (!type || typeof type !== 'string') {
      return res.status(400).json({ ok: false, error: 'Command type required' });
    }

    const allowed = ['restart_opennds', 'restart_wireless', 'rotate_key', 'pull_config'];
    if (!allowed.includes(type)) {
      return res.status(400).json({ ok: false, error: `Invalid command type. Allowed: ${allowed.join(', ')}` });
    }

    const router = await Router.findOneAndUpdate(
      { routerId },
      {
        $push: {
          commandQueue: {
            type,
            payload: payload || {},
            createdAt: new Date()
          }
        }
      },
      { new: true }
    );

    if (!router) {
      return res.status(404).json({ ok: false, error: 'Router not found' });
    }

    const lastCmd = router.commandQueue[router.commandQueue.length - 1];
    return res.json({
      ok: true,
      routerId,
      command: {
        id: lastCmd._id.toString(),
        type: lastCmd.type,
        payload: lastCmd.payload,
        createdAt: lastCmd.createdAt
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/admin/reports/summary - revenue by period (daily, weekly, monthly, yearly)
r.get('/reports/summary', async (req, res) => {
  try {
    const { range = 'daily', routerId } = req.query;
    const { start, end } = dateRange(range);
    const match = { ts: { $gte: start, $lte: end } };
    if (routerId) match.routerId = routerId;

    const [saleSummary] = await SaleEvent.aggregate([
      { $match: match },
      { $group: { _id: null, totalAmount: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const [voucherSummary] = await Voucher.aggregate([
      { $match: { status: 'redeemed', redeemedAt: { $gte: start, $lte: end }, ...(routerId && { routerId }) } },
      { $group: { _id: null, totalAmount: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const saleAmount = saleSummary ? saleSummary.totalAmount : 0;
    const voucherAmount = voucherSummary ? voucherSummary.totalAmount : 0;
    return res.json({
      ok: true,
      range,
      daily: range === 'daily' || range === 'today' ? saleAmount + voucherAmount : undefined,
      weekly: range === 'weekly' || range === 'week' ? saleAmount + voucherAmount : undefined,
      monthly: range === 'monthly' || range === 'month' ? saleAmount + voucherAmount : undefined,
      yearly: range === 'yearly' || range === 'year' ? saleAmount + voucherAmount : undefined,
      totalAmount: saleAmount + voucherAmount,
      saleCount: saleSummary ? saleSummary.count : 0,
      voucherCount: voucherSummary ? voucherSummary.count : 0
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/admin/reports/revenue - all periods at once
r.get('/reports/revenue', async (req, res) => {
  try {
    const { routerId } = req.query;
    const now = new Date();
    const dailyStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weeklyStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthlyStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearlyStart = new Date(now.getFullYear(), 0, 1);

    const baseMatch = routerId ? { routerId } : {};

    const agg = async (start) => {
      const m = { ...baseMatch, ts: { $gte: start, $lte: now } };
      const [saleRow] = await SaleEvent.aggregate([
        { $match: m },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      let total = saleRow ? saleRow.total : 0;
      const saleCodes = (await SaleEvent.find(m).distinct('voucherCode')).filter(Boolean);
      const vMatch = { ...baseMatch, status: 'redeemed', redeemedAt: { $gte: start, $lte: now } };
      if (saleCodes.length) vMatch.code = { $nin: saleCodes };
      const [v] = await Voucher.aggregate([
        { $match: vMatch },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      return total + (v ? v.total : 0);
    };

    const [daily, weekly, monthly, yearly] = await Promise.all([
      agg(dailyStart),
      agg(weeklyStart),
      agg(monthlyStart),
      agg(yearlyStart)
    ]);

    return res.json({
      ok: true,
      daily,
      weekly,
      monthly,
      yearly
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/admin/reports/revenue-chart - daily revenue for chart (days=30)
r.get('/reports/revenue-chart', async (req, res) => {
  try {
    const { routerId, days = 30 } = req.query;
    const numDays = Math.min(Math.max(7, Number(days) || 30), 90);
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

      const match = { ts: { $gte: d, $lt: next } };
      if (routerId) match.routerId = routerId;

      const [sale] = await SaleEvent.aggregate([
        { $match: match },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      let total = sale ? sale.total : 0;

      const vMatch = { status: 'redeemed', redeemedAt: { $gte: d, $lt: next } };
      if (routerId) vMatch.routerId = routerId;
      const saleCodes = (await SaleEvent.find(match).distinct('voucherCode')).filter(Boolean);
      if (saleCodes.length) vMatch.code = { $nin: saleCodes };
      const [v] = await Voucher.aggregate([
        { $match: vMatch },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      total += v ? v.total : 0;
      values.push(total);
    }

    return res.json({ ok: true, labels, values });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/admin/reports/transactions - transaction history
r.get('/reports/transactions', async (req, res) => {
  try {
    const { routerId, from, to, limit = 50 } = req.query;
    const maxLimit = 5000;
    const match = {};
    if (routerId) match.routerId = routerId;
    if (from || to) {
      match.ts = {};
      if (from) match.ts.$gte = new Date(from);
      if (to) match.ts.$lte = new Date(to);
    }

    const reqLimit = Math.min(Math.max(1, Number(limit) || 50), maxLimit);
    const sales = await SaleEvent.find(match)
      .sort({ ts: -1 })
      .limit(reqLimit)
      .lean();

    const vMatch = { status: 'redeemed' };
    if (routerId) vMatch.routerId = routerId;
    if (from || to) {
      vMatch.redeemedAt = {};
      if (from) vMatch.redeemedAt.$gte = new Date(from);
      if (to) vMatch.redeemedAt.$lte = new Date(to);
    }

    const vouchers = await Voucher.find(vMatch)
      .sort({ redeemedAt: -1 })
      .limit(reqLimit)
      .lean();

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
      .filter((v) => !sales.some((s) => s.voucherCode === v.code && Math.abs(new Date(s.ts) - new Date(v.redeemedAt)) < 60000))
      .map((v) => ({
        id: v._id.toString(),
        type: 'redeem',
        routerId: v.routerId,
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

// GET /api/admin/routers/:routerId - inspect router config
r.get('/routers/:routerId', async (req, res) => {
  try {
    const router = await Router.findOne({ routerId: req.params.routerId })
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

// DELETE /api/admin/routers/:routerId - unbind/delete router record (admin)
r.delete('/routers/:routerId', async (req, res) => {
  try {
    const routerId = String(req.params.routerId || '').trim();
    if (!routerId) {
      return res.status(400).json({ ok: false, error: 'routerId required' });
    }

    const force = ['1', 'true', 'yes'].includes(String(req.query.force || '').toLowerCase());
    const router = await Router.findOne({ routerId })
      .select('routerId name licenseKey tenantId')
      .lean();
    if (!router) {
      return res.status(404).json({ ok: false, error: 'Router not found' });
    }

    if ((router.licenseKey || '').trim() && !force) {
      return res.status(409).json({
        ok: false,
        error: 'Router still has a license attached. Remove license first or use ?force=1'
      });
    }

    await Router.deleteOne({ routerId });
    const now = new Date();
    await LicenseTransferRequest.updateMany(
      { routerId, status: 'pending' },
      { $set: { status: 'cancelled', cancelledAt: now } }
    );

    return res.json({
      ok: true,
      deleted: true,
      router: {
        routerId: router.routerId,
        name: router.name || '',
        tenantId: router.tenantId || null
      },
      message: 'Router unbound/deleted'
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = r;

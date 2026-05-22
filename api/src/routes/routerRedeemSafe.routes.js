const crypto = require('crypto');
const express = require('express');

const { routerAuth } = require('../middleware/routerAuth');
const Voucher = require('../models/Voucher');
const Session = require('../models/Session');
const { DEFAULT_DOWNLOAD_KBPS, DEFAULT_UPLOAD_KBPS } = require('../utils/profile');

const r = express.Router();

r.use(routerAuth);

function scopeQuery({ code, tenantId, routerId }) {
  if (tenantId) return { code, $or: [{ tenantId }, { routerId }] };
  return { routerId, code };
}

function grantPayload(voucher) {
  return {
    minutes: voucher.minutes,
    downloadKbps: voucher.downloadKbps || DEFAULT_DOWNLOAD_KBPS,
    uploadKbps: voucher.uploadKbps || DEFAULT_UPLOAD_KBPS,
    downloadQuotaKB: Number.isFinite(voucher.downloadQuotaKB) ? voucher.downloadQuotaKB : 0,
    uploadQuotaKB: Number.isFinite(voucher.uploadQuotaKB) ? voucher.uploadQuotaKB : 0
  };
}

function voucherError(res, existing, now) {
  if (!existing) return res.status(404).json({ ok: false, error: 'Voucher not found' });
  if (existing.status === 'redeemed') return res.status(400).json({ ok: false, error: 'Voucher already redeemed' });
  if (existing.status === 'pending' && existing.pendingExpiresAt && new Date(existing.pendingExpiresAt).getTime() > now.getTime()) {
    return res.status(409).json({ ok: false, error: 'Voucher redeem in progress' });
  }
  if (existing.expiresAt && new Date(existing.expiresAt).getTime() <= now.getTime()) {
    return res.status(400).json({ ok: false, error: 'Voucher expired' });
  }
  return res.status(400).json({ ok: false, error: 'Voucher not found' });
}

r.post('/prepare', async (req, res) => {
  try {
    const routerId = req.router.routerId;
    const tenantId = req.router.tenantId || null;
    const code = req.body && req.body.code ? String(req.body.code).trim().toUpperCase() : '';
    if (!code) return res.status(400).json({ ok: false, error: 'Voucher code is required' });

    const now = new Date();
    const redeemToken = crypto.randomBytes(24).toString('hex');
    const client = (req.body && req.body.client) || {};
    const query = scopeQuery({ code, tenantId, routerId });

    const voucher = await Voucher.findOneAndUpdate(
      {
        $and: [
          query,
          { expiresAt: { $gt: now } },
          {
            $or: [
              { status: 'unused' },
              { status: 'pending', pendingExpiresAt: { $lte: now } },
              { status: 'pending', pendingExpiresAt: null }
            ]
          }
        ]
      },
      {
        $set: {
          status: 'pending',
          pendingAt: now,
          pendingExpiresAt: new Date(now.getTime() + 2 * 60 * 1000),
          pendingToken: redeemToken,
          pendingRouterId: routerId,
          pendingClient: {
            ip: client.ip ? String(client.ip) : null,
            mac: client.mac ? String(client.mac) : null
          }
        }
      },
      { new: true }
    );

    if (!voucher) {
      const existing = await Voucher.findOne(query).lean();
      return voucherError(res, existing, now);
    }

    return res.json({
      ok: true,
      redeemToken,
      grant: grantPayload(voucher),
      voucher: { code: voucher.code, status: voucher.status }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

r.post('/commit', async (req, res) => {
  try {
    const routerId = req.router.routerId;
    const tenantId = req.router.tenantId || null;
    const code = req.body && req.body.code ? String(req.body.code).trim().toUpperCase() : '';
    const redeemToken = req.body && req.body.redeemToken ? String(req.body.redeemToken).trim() : '';
    if (!code || !redeemToken) {
      return res.status(400).json({ ok: false, error: 'Voucher code and redeem token are required' });
    }

    const now = new Date();
    const client = (req.body && req.body.client) || {};
    const query = scopeQuery({ code, tenantId, routerId });
    const voucher = await Voucher.findOneAndUpdate(
      {
        ...query,
        status: 'pending',
        pendingToken: redeemToken,
        pendingRouterId: routerId,
        expiresAt: { $gt: now }
      },
      {
        $set: {
          status: 'redeemed',
          redeemedAt: now,
          redeemedRouterId: routerId,
          redeemedClient: {
            ip: client.ip ? String(client.ip) : null,
            mac: client.mac ? String(client.mac) : null
          }
        },
        $unset: {
          pendingAt: '',
          pendingExpiresAt: '',
          pendingToken: '',
          pendingRouterId: '',
          pendingClient: ''
        }
      },
      { new: true }
    );

    if (!voucher) {
      const existing = await Voucher.findOne(query).lean();
      if (existing && existing.status === 'pending') {
        return res.status(409).json({ ok: false, error: 'Voucher redeem token mismatch or expired' });
      }
      return voucherError(res, existing, now);
    }

    const grant = grantPayload(voucher);
    const startedAt = new Date();
    await Session.create({
      routerId,
      voucherId: voucher._id,
      voucherCode: voucher.code,
      clientIp: client.ip ? String(client.ip) : null,
      clientMac: client.mac ? String(client.mac) : null,
      deviceId: voucher.deviceId || null,
      minutesGranted: voucher.minutes,
      downloadKbps: grant.downloadKbps,
      uploadKbps: grant.uploadKbps,
      startedAt,
      expiresAt: new Date(startedAt.getTime() + voucher.minutes * 60 * 1000),
      status: 'active'
    });

    return res.json({
      ok: true,
      grant,
      voucher: { code: voucher.code, status: voucher.status }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

r.post('/cancel', async (req, res) => {
  try {
    const routerId = req.router.routerId;
    const tenantId = req.router.tenantId || null;
    const code = req.body && req.body.code ? String(req.body.code).trim().toUpperCase() : '';
    const redeemToken = req.body && req.body.redeemToken ? String(req.body.redeemToken).trim() : '';
    if (!code || !redeemToken) {
      return res.status(400).json({ ok: false, error: 'Voucher code and redeem token are required' });
    }

    const result = await Voucher.updateOne(
      {
        ...scopeQuery({ code, tenantId, routerId }),
        status: 'pending',
        pendingToken: redeemToken,
        pendingRouterId: routerId
      },
      {
        $set: { status: 'unused' },
        $unset: {
          pendingAt: '',
          pendingExpiresAt: '',
          pendingToken: '',
          pendingRouterId: '',
          pendingClient: ''
        }
      }
    );

    return res.json({ ok: true, cancelled: result.modifiedCount || 0 });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = r;

const crypto = require('crypto');
const express = require('express');

const { routerAuth } = require('../middleware/routerAuth');
const Router = require('../models/Router');
const Voucher = require('../models/Voucher');
const SaleEvent = require('../models/SaleEvent');
const Session = require('../models/Session');
const PortableGrant = require('../models/PortableGrant');
const { DEFAULT_PROFILE, DEFAULT_DOWNLOAD_KBPS, DEFAULT_UPLOAD_KBPS, toPositiveNumber, sanitizeProfile } = require('../utils/profile');

const r = express.Router();
const rateBuckets = new Map();

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function isRateLimited(routerId, action, limitPerMinute) {
  if (!Number.isFinite(limitPerMinute) || limitPerMinute <= 0) {
    return false;
  }

  const now = Date.now();
  const key = `${routerId}:${action}`;
  const bucket = rateBuckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60 * 1000 });
    return false;
  }

  if (bucket.count >= limitPerMinute) {
    return true;
  }

  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return false;
}

function resolveRate(profile, body) {
  const amount = body.amount !== undefined ? toPositiveNumber(body.amount) : null;
  const minutes = body.minutes !== undefined ? toPositiveNumber(body.minutes) : null;

  if (!amount && !minutes) {
    return null;
  }

  if (amount && minutes) {
    return profile.rates.find((rate) => rate.amount === amount && rate.minutes === minutes) || null;
  }

  if (amount) {
    return profile.rates.find((rate) => rate.amount === amount) || null;
  }

  return profile.rates.find((rate) => rate.minutes === minutes) || null;
}

function randomVoucherRandom(length) {
  let output = '';
  for (let i = 0; i < length; i += 1) {
    output += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return output;
}

function normalizeMac(value) {
  if (!value) return null;
  const cleaned = String(value).trim().toUpperCase().replace(/[^0-9A-F]/g, '');
  if (cleaned.length !== 12) return null;
  return cleaned.match(/.{2}/g).join(':');
}

function normalizeIp(value) {
  if (!value) return null;
  const ip = String(value).trim();
  if (!ip) return null;
  return ip;
}

function resolveClientIdentity(inputClient) {
  const client = inputClient && typeof inputClient === 'object' ? inputClient : {};
  const mac = normalizeMac(client.mac);
  const ip = normalizeIp(client.ip);
  if (!mac && !ip) {
    return { error: 'Client IP or MAC is required' };
  }
  return {
    key: mac ? `mac:${mac}` : `ip:${ip}`,
    mac,
    ip
  };
}

function scopeIdForRouter(router) {
  if (router && router.tenantId) {
    return `tenant:${String(router.tenantId)}`;
  }
  return `router:${String(router.routerId)}`;
}

function computeGrantRemainingSeconds(grant, now = Date.now()) {
  const baseRemaining = Math.max(0, Number(grant && grant.remainingSeconds ? grant.remainingSeconds : 0));
  if (!grant || grant.status !== 'active') {
    return baseRemaining;
  }
  const since = grant.stateChangedAt ? new Date(grant.stateChangedAt).getTime() : now;
  if (!Number.isFinite(since) || since >= now) {
    return baseRemaining;
  }
  return Math.max(0, baseRemaining - Math.floor((now - since) / 1000));
}

function buildGrantStatePayload(grant, currentRouterId, remainingSeconds, client) {
  if (!grant || remainingSeconds <= 0) {
    return {
      ok: true,
      connected: false,
      clientIp: client.ip || null,
      clientMac: client.mac || null
    };
  }

  const seconds = Math.max(0, Math.floor(remainingSeconds));
  const minutesLeft = Math.floor(seconds / 60);
  const payload = {
    ok: true,
    minutesLeft,
    remainingSeconds: seconds,
    downloadKbps: Number(grant.downloadKbps) || DEFAULT_DOWNLOAD_KBPS,
    uploadKbps: Number(grant.uploadKbps) || DEFAULT_UPLOAD_KBPS,
    clientIp: client.ip || grant.clientIp || null,
    clientMac: client.mac || grant.clientMac || null
  };

  if (grant.status === 'paused') {
    payload.connected = false;
    payload.paused = true;
    return payload;
  }

  if (grant.activeRouterId && grant.activeRouterId !== currentRouterId) {
    payload.connected = false;
    payload.disconnectedWithTime = true;
    return payload;
  }

  payload.connected = true;
  return payload;
}

function buildSessionClientFilters(client) {
  const filters = [];
  if (client && client.ip) filters.push({ clientIp: client.ip });
  if (client && client.mac) filters.push({ clientMac: client.mac });
  return filters;
}

function toDatePartsInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);

  const map = {};
  parts.forEach((part) => {
    if (part.type !== 'literal') {
      map[part.type] = Number(part.value);
    }
  });

  return map;
}

function timezoneOffsetMs(date, timeZone) {
  const parts = toDatePartsInTimezone(date, timeZone);
  const renderedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return renderedAsUtc - date.getTime();
}

function todayRangeInTimezone(timeZone) {
  const now = new Date();
  const dateOnlyParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const map = {};
  dateOnlyParts.forEach((part) => {
    if (part.type !== 'literal') {
      map[part.type] = Number(part.value);
    }
  });

  const utcGuess = new Date(Date.UTC(map.year, map.month - 1, map.day, 0, 0, 0));
  const offset = timezoneOffsetMs(utcGuess, timeZone);
  const start = new Date(utcGuess.getTime() - offset);

  return { start, end: now };
}

// Phase 2.1
r.post('/heartbeat', routerAuth, async (req, res) => {
  try {
    const { uptimeSec, fwVersion, wanIp, lanIp } = req.body || {};
    const update = {
      lastSeenAt: new Date(),
      'meta.uptimeSec': Number.isFinite(Number(uptimeSec)) ? Number(uptimeSec) : null,
      'meta.fwVersion': fwVersion ? String(fwVersion) : null,
      'meta.wanIp': wanIp ? String(wanIp) : null,
      'meta.lanIp': lanIp ? String(lanIp) : null
    };

    await Router.updateOne({ routerId: req.router.routerId }, { $set: update });

    return res.json({
      ok: true,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Phase 2.2 + Phase 3: full config (profile, hotspot, portal, status, commands)
r.get('/config', routerAuth, async (req, res) => {
  const profile = sanitizeProfile(req.router.profile);
  const router = req.router;
  const hotspot = router.hotspot || {};
  const portal = router.portal || {};
  const commands = (router.commandQueue || []).map((c) => ({
    id: c._id.toString(),
    type: c.type,
    payload: c.payload,
    createdAt: c.createdAt
  }));

  return res.json({
    ok: true,
    routerId: router.routerId,
    status: router.status,
    licenseKey: router.licenseKey || null,
    profile,
    hotspot: {
      ssid: hotspot.ssid || null,
      welcomeMsg: hotspot.welcomeMsg || null,
      separateBands: Boolean(hotspot.separateBands),
      ssid24: hotspot.ssid24 || null,
      ssid5: hotspot.ssid5 || null
    },
    portal: { theme: portal.theme || 'default' },
    commands
  });
});

// Phase 3: acknowledge executed commands (removes from queue)
r.post('/commands/ack', routerAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (ids.length === 0) {
      return res.json({ ok: true, acked: 0 });
    }

    const { ObjectId } = require('mongoose').Types;
    const validIds = ids
      .filter((id) => typeof id === 'string' && ObjectId.isValid(id))
      .map((id) => new ObjectId(id));

    const result = await Router.updateOne(
      { routerId: req.router.routerId },
      { $pull: { commandQueue: { _id: { $in: validIds } } } }
    );

    return res.json({ ok: true, acked: result.modifiedCount });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Phase 3.1
r.post('/vouchers/create', routerAuth, async (req, res) => {
  try {
    const profile = sanitizeProfile(req.router.profile);
    const routerId = req.router.routerId;

    if (isRateLimited(routerId, 'create', profile.limits.maxCreatePerMinute)) {
      return res.status(429).json({ ok: false, error: 'Rate limit exceeded' });
    }

    const matched = resolveRate(profile, req.body || {});
    if (!matched) {
      return res.status(400).json({ ok: false, error: 'Rate not found' });
    }

    const deviceId = req.body && req.body.deviceId ? String(req.body.deviceId) : null;
    const clientHint = req.body && req.body.clientHint ? req.body.clientHint : null;
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);

    const downloadKbps = matched.downloadKbps || DEFAULT_DOWNLOAD_KBPS;
    const uploadKbps = matched.uploadKbps || DEFAULT_UPLOAD_KBPS;
    const downloadQuotaKB = Number.isFinite(matched.downloadQuotaKB) ? matched.downloadQuotaKB : 0;
    const uploadQuotaKB = Number.isFinite(matched.uploadQuotaKB) ? matched.uploadQuotaKB : 0;

    let voucher = null;
    const tenantId = req.router.tenantId || null;
    for (let i = 0; i < 8; i += 1) {
      const code = randomVoucherRandom(profile.voucherLength);
      try {
        voucher = await Voucher.create({
          routerId,
          tenantId,
          code,
          minutes: matched.minutes,
          amount: matched.amount,
          downloadKbps,
          uploadKbps,
          downloadQuotaKB,
          uploadQuotaKB,
          deviceId,
          status: 'unused',
          expiresAt,
          clientHint
        });
        break;
      } catch (error) {
        if (error && error.code === 11000) {
          continue;
        }
        throw error;
      }
    }

    if (!voucher) {
      return res.status(500).json({ ok: false, error: 'Failed to generate unique voucher code' });
    }

    return res.json({
      ok: true,
      // Backward compatibility for older router scripts expecting top-level fields.
      code: voucher.code,
      minutes: voucher.minutes,
      amount: voucher.amount,
      expiresAt: voucher.expiresAt,
      status: voucher.status,
      voucher: {
        code: voucher.code,
        minutes: voucher.minutes,
        amount: voucher.amount,
        expiresAt: voucher.expiresAt,
        status: voucher.status
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Phase 5: batch voucher create for offline pool (ESP offline-first)
r.post('/vouchers/batch', routerAuth, async (req, res) => {
  try {
    const profile = sanitizeProfile(req.router.profile);
    const routerId = req.router.routerId;
    const body = req.body || {};
    const count = Math.min(Math.max(1, Number(body.count) || 5), 20);
    const amount = toPositiveNumber(body.amount);
    const deviceId = body.deviceId ? String(body.deviceId) : 'pool';

    const matched = amount
      ? profile.rates.find((r) => r.amount === amount) || profile.rates[0]
      : profile.rates[0];
    if (!matched) {
      return res.status(400).json({ ok: false, error: 'No rate configured' });
    }

    const downloadKbps = matched.downloadKbps || DEFAULT_DOWNLOAD_KBPS;
    const uploadKbps = matched.uploadKbps || DEFAULT_UPLOAD_KBPS;
    const downloadQuotaKB = Number.isFinite(matched.downloadQuotaKB) ? matched.downloadQuotaKB : 0;
    const uploadQuotaKB = Number.isFinite(matched.uploadQuotaKB) ? matched.uploadQuotaKB : 0;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const vouchers = [];
    const tenantId = req.router.tenantId || null;
    for (let i = 0; i < count; i += 1) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = randomVoucherRandom(profile.voucherLength);
        try {
          const v = await Voucher.create({
            routerId,
            tenantId,
            code,
            minutes: matched.minutes,
            amount: matched.amount,
            downloadKbps,
            uploadKbps,
            downloadQuotaKB,
            uploadQuotaKB,
            deviceId,
            status: 'unused',
            expiresAt
          });
          vouchers.push({
            code: v.code,
            minutes: v.minutes,
            amount: v.amount,
            expiresAt: v.expiresAt
          });
          break;
        } catch (err) {
          if (err && err.code === 11000) continue;
          throw err;
        }
      }
    }

    return res.json({
      ok: true,
      vouchers
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Phase 5: sync pending offline sales to cloud
r.post('/sales/sync', routerAuth, async (req, res) => {
  try {
    const routerId = req.router.routerId;
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.json({ ok: true, synced: 0 });
    }
    if (items.length > 100) {
      return res.status(400).json({ ok: false, error: 'Max 100 items per sync' });
    }

    const created = [];
    for (const it of items) {
      const amount = Number(it.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const ts = it.ts ? new Date(it.ts) : new Date();
      if (Number.isNaN(ts.getTime())) continue;

      await SaleEvent.create({
        routerId,
        deviceId: it.deviceId ? String(it.deviceId) : null,
        amount,
        voucherCode: it.voucherCode ? String(it.voucherCode) : null,
        ts
      });
      created.push({ voucherCode: it.voucherCode, amount, ts });
    }

    return res.json({ ok: true, synced: created.length });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Phase 3.2
r.post('/vouchers/redeem', routerAuth, async (req, res) => {
  try {
    const profile = sanitizeProfile(req.router.profile);
    const routerId = req.router.routerId;
    if (isRateLimited(routerId, 'redeem', profile.limits.maxRedeemPerMinute)) {
      return res.status(429).json({ ok: false, error: 'Rate limit exceeded' });
    }

    const code = req.body && req.body.code ? String(req.body.code).trim().toUpperCase() : '';
    if (!code) {
      return res.status(400).json({ ok: false, error: 'Voucher code is required' });
    }

    const client = (req.body && req.body.client) || {};
    const now = new Date();
    const tenantId = req.router.tenantId || null;
    const redeemQuery = {
      code,
      status: 'unused',
      expiresAt: { $gt: now }
    };
    if (tenantId) {
      // Tenant-wide vouchers + legacy router-scoped vouchers still redeem.
      redeemQuery.$or = [{ tenantId }, { routerId }];
    } else {
      redeemQuery.routerId = routerId;
    }
    const redeemed = await Voucher.findOneAndUpdate(
      redeemQuery,
      {
        $set: {
          status: 'redeemed',
          redeemedAt: now,
          redeemedRouterId: routerId,
          redeemedClient: {
            ip: client.ip ? String(client.ip) : null,
            mac: client.mac ? String(client.mac) : null
          }
        }
      },
      { new: true }
    );

    if (!redeemed) {
      const existing = await Voucher.findOne(
        tenantId
          ? { code, $or: [{ tenantId }, { routerId }] }
          : { routerId, code }
      ).lean();
      if (!existing) {
        return res.status(404).json({ ok: false, error: 'Voucher not found' });
      }
      if (existing.status === 'redeemed') {
        return res.status(400).json({ ok: false, error: 'Voucher already redeemed' });
      }
      if (existing.expiresAt && new Date(existing.expiresAt).getTime() <= now.getTime()) {
        return res.status(400).json({ ok: false, error: 'Voucher expired' });
      }
      return res.status(400).json({ ok: false, error: 'Voucher not found' });
    }

    const downloadKbps = redeemed.downloadKbps || DEFAULT_DOWNLOAD_KBPS;
    const uploadKbps = redeemed.uploadKbps || DEFAULT_UPLOAD_KBPS;
    const downloadQuotaKB = Number.isFinite(redeemed.downloadQuotaKB) ? redeemed.downloadQuotaKB : 0;
    const uploadQuotaKB = Number.isFinite(redeemed.uploadQuotaKB) ? redeemed.uploadQuotaKB : 0;

    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + redeemed.minutes * 60 * 1000);

    await Session.create({
      routerId,
      voucherId: redeemed._id,
      voucherCode: redeemed.code,
      clientIp: client.ip ? String(client.ip) : null,
      clientMac: client.mac ? String(client.mac) : null,
      deviceId: redeemed.deviceId || null,
      minutesGranted: redeemed.minutes,
      downloadKbps,
      uploadKbps,
      startedAt,
      expiresAt,
      status: 'active'
    });

    return res.json({
      ok: true,
      grant: {
        minutes: redeemed.minutes,
        downloadKbps,
        uploadKbps,
        downloadQuotaKB,
        uploadQuotaKB
      },
      voucher: {
        code: redeemed.code,
        status: redeemed.status
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

r.post('/grants/topup', routerAuth, async (req, res) => {
  try {
    const profile = sanitizeProfile(req.router.profile);
    const routerId = req.router.routerId;

    if (isRateLimited(routerId, 'grant_topup', profile.limits.maxCreatePerMinute)) {
      return res.status(429).json({ ok: false, error: 'Rate limit exceeded' });
    }

    const matched = resolveRate(profile, req.body || {});
    if (!matched) {
      return res.status(400).json({ ok: false, error: 'Rate not found' });
    }

    const clientIdentity = resolveClientIdentity((req.body && req.body.client) || {});
    if (clientIdentity.error) {
      return res.status(400).json({ ok: false, error: clientIdentity.error });
    }

    const nowMs = Date.now();
    const nowDate = new Date(nowMs);
    const scopeId = scopeIdForRouter(req.router);
    const addedSeconds = Math.max(0, Math.floor(Number(matched.minutes) * 60));
    if (addedSeconds <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid rate minutes' });
    }

    const existing = await PortableGrant.findOne({ scopeId, clientKey: clientIdentity.key });
    const existingRemaining = existing ? computeGrantRemainingSeconds(existing, nowMs) : 0;
    const newRemaining = existingRemaining + addedSeconds;

    const downloadKbps = matched.downloadKbps || DEFAULT_DOWNLOAD_KBPS;
    const uploadKbps = matched.uploadKbps || DEFAULT_UPLOAD_KBPS;
    const downloadQuotaKB = Number.isFinite(matched.downloadQuotaKB) ? matched.downloadQuotaKB : 0;
    const uploadQuotaKB = Number.isFinite(matched.uploadQuotaKB) ? matched.uploadQuotaKB : 0;
    const deviceId = req.body && req.body.deviceId ? String(req.body.deviceId) : null;

    let grantDoc = existing;
    if (!grantDoc) {
      grantDoc = new PortableGrant({
        scopeId,
        tenantId: req.router.tenantId || null,
        clientKey: clientIdentity.key
      });
    }

    grantDoc.clientMac = clientIdentity.mac;
    grantDoc.clientIp = clientIdentity.ip;
    grantDoc.status = 'active';
    grantDoc.remainingSeconds = newRemaining;
    grantDoc.activeRouterId = routerId;
    grantDoc.lastRouterId = routerId;
    grantDoc.deviceId = deviceId;
    grantDoc.downloadKbps = downloadKbps;
    grantDoc.uploadKbps = uploadKbps;
    grantDoc.downloadQuotaKB = downloadQuotaKB;
    grantDoc.uploadQuotaKB = uploadQuotaKB;
    grantDoc.stateChangedAt = nowDate;
    await grantDoc.save();

    await SaleEvent.create({
      routerId,
      deviceId,
      amount: matched.amount,
      voucherCode: null,
      ts: nowDate
    });

    const sessionFilters = buildSessionClientFilters(clientIdentity);
    if (sessionFilters.length > 0) {
      await Session.updateMany(
        {
          routerId,
          status: 'active',
          $or: sessionFilters
        },
        { $set: { status: 'ended', endedAt: nowDate } }
      );
    }

    await Session.create({
      routerId,
      voucherId: null,
      voucherCode: null,
      clientIp: clientIdentity.ip,
      clientMac: clientIdentity.mac,
      deviceId,
      minutesGranted: Math.max(1, Math.ceil(newRemaining / 60)),
      downloadKbps,
      uploadKbps,
      startedAt: nowDate,
      expiresAt: new Date(nowMs + newRemaining * 1000),
      status: 'active'
    });

    return res.json({
      ok: true,
      method: 'portable_grant',
      amount: matched.amount,
      addedMinutes: matched.minutes,
      grant: {
        minutes: Math.max(1, Math.ceil(newRemaining / 60)),
        remainingSeconds: newRemaining,
        downloadKbps,
        uploadKbps,
        downloadQuotaKB,
        uploadQuotaKB
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

async function handleGrantState(req, res) {
  try {
    const bodyClient = req.body && typeof req.body === 'object' ? req.body.client : null;
    const queryClient = {
      ip: req.query.clientIp || req.query.ip || null,
      mac: req.query.clientMac || req.query.mac || null
    };
    const sourceClient = bodyClient || queryClient;
    const clientIdentity = resolveClientIdentity(sourceClient);
    if (clientIdentity.error) {
      return res.status(400).json({ ok: false, error: clientIdentity.error });
    }

    const scopeId = scopeIdForRouter(req.router);
    const grant = await PortableGrant.findOne({ scopeId, clientKey: clientIdentity.key }).lean();
    if (!grant) {
      return res.json({
        ok: true,
        connected: false,
        clientIp: clientIdentity.ip || null,
        clientMac: clientIdentity.mac || null
      });
    }

    const remainingSeconds = computeGrantRemainingSeconds(grant, Date.now());
    if (remainingSeconds <= 0) {
      await PortableGrant.updateOne(
        { _id: grant._id },
        { $set: { status: 'ended', remainingSeconds: 0, activeRouterId: null, stateChangedAt: new Date() } }
      );
    }

    return res.json(
      buildGrantStatePayload(grant, req.router.routerId, remainingSeconds, clientIdentity)
    );
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

r.get('/grants/state', routerAuth, handleGrantState);
r.post('/grants/state', routerAuth, handleGrantState);

r.post('/grants/pause', routerAuth, async (req, res) => {
  try {
    const clientIdentity = resolveClientIdentity((req.body && req.body.client) || {});
    if (clientIdentity.error) {
      return res.status(400).json({ ok: false, error: clientIdentity.error });
    }

    const scopeId = scopeIdForRouter(req.router);
    const grant = await PortableGrant.findOne({ scopeId, clientKey: clientIdentity.key });
    if (!grant) {
      return res.status(404).json({ ok: false, error: 'No active session found' });
    }

    const nowMs = Date.now();
    const remainingSeconds = computeGrantRemainingSeconds(grant, nowMs);
    if (remainingSeconds <= 0) {
      grant.status = 'ended';
      grant.remainingSeconds = 0;
      grant.activeRouterId = null;
      grant.stateChangedAt = new Date(nowMs);
      await grant.save();
      return res.status(400).json({ ok: false, error: 'No time left' });
    }

    grant.clientMac = clientIdentity.mac;
    grant.clientIp = clientIdentity.ip;
    grant.status = 'paused';
    grant.remainingSeconds = remainingSeconds;
    grant.activeRouterId = null;
    grant.lastRouterId = req.router.routerId;
    grant.stateChangedAt = new Date(nowMs);
    await grant.save();

    return res.json(
      buildGrantStatePayload(grant, req.router.routerId, remainingSeconds, clientIdentity)
    );
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

r.post('/grants/resume', routerAuth, async (req, res) => {
  try {
    const clientIdentity = resolveClientIdentity((req.body && req.body.client) || {});
    if (clientIdentity.error) {
      return res.status(400).json({ ok: false, error: clientIdentity.error });
    }

    const scopeId = scopeIdForRouter(req.router);
    const grant = await PortableGrant.findOne({ scopeId, clientKey: clientIdentity.key });
    if (!grant) {
      return res.status(404).json({ ok: false, error: 'No paused session found' });
    }

    const nowMs = Date.now();
    const nowDate = new Date(nowMs);
    const remainingSeconds = computeGrantRemainingSeconds(grant, nowMs);
    if (remainingSeconds <= 0) {
      grant.status = 'ended';
      grant.remainingSeconds = 0;
      grant.activeRouterId = null;
      grant.stateChangedAt = nowDate;
      await grant.save();
      return res.status(400).json({ ok: false, error: 'No time left' });
    }

    grant.clientMac = clientIdentity.mac;
    grant.clientIp = clientIdentity.ip;
    grant.status = 'active';
    grant.remainingSeconds = remainingSeconds;
    grant.activeRouterId = req.router.routerId;
    grant.lastRouterId = req.router.routerId;
    grant.stateChangedAt = nowDate;
    await grant.save();

    const sessionFilters = buildSessionClientFilters(clientIdentity);
    if (sessionFilters.length > 0) {
      await Session.updateMany(
        {
          routerId: req.router.routerId,
          status: 'active',
          $or: sessionFilters
        },
        { $set: { status: 'ended', endedAt: nowDate } }
      );
    }

    await Session.create({
      routerId: req.router.routerId,
      voucherId: null,
      voucherCode: null,
      clientIp: clientIdentity.ip,
      clientMac: clientIdentity.mac,
      deviceId: grant.deviceId || null,
      minutesGranted: Math.max(1, Math.ceil(remainingSeconds / 60)),
      downloadKbps: Number(grant.downloadKbps) || DEFAULT_DOWNLOAD_KBPS,
      uploadKbps: Number(grant.uploadKbps) || DEFAULT_UPLOAD_KBPS,
      startedAt: nowDate,
      expiresAt: new Date(nowMs + remainingSeconds * 1000),
      status: 'active'
    });

    return res.json(
      buildGrantStatePayload(grant, req.router.routerId, remainingSeconds, clientIdentity)
    );
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Phase 4.1
r.post('/sales/event', routerAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid amount' });
    }

    const ts = body.ts ? new Date(body.ts) : new Date();
    if (Number.isNaN(ts.getTime())) {
      return res.status(400).json({ ok: false, error: 'Invalid timestamp' });
    }

    await SaleEvent.create({
      routerId: req.router.routerId,
      deviceId: body.deviceId ? String(body.deviceId) : null,
      amount,
      voucherCode: body.voucherCode ? String(body.voucherCode) : null,
      ts
    });

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Phase 4: session end (router reports when client disconnects / time expires)
r.post('/sessions/end', routerAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const routerId = req.router.routerId;
    const clientIp = body.clientIp || body.ip ? String(body.clientIp || body.ip) : null;
    const clientMac = body.clientMac || body.mac ? String(body.clientMac || body.mac) : null;
    const voucherCode = body.voucherCode ? String(body.voucherCode).trim().toUpperCase() : null;

    const query = { routerId, status: 'active' };
    if (clientIp) query.clientIp = clientIp;
    if (clientMac) query.clientMac = clientMac;
    if (voucherCode) query.voucherCode = voucherCode;
    if (!clientIp && !clientMac && !voucherCode) {
      return res.status(400).json({ ok: false, error: 'Provide clientIp, clientMac, or voucherCode' });
    }

    const result = await Session.updateMany(
      query,
      { $set: { status: 'ended', endedAt: new Date() } }
    );

    return res.json({ ok: true, ended: result.modifiedCount });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Phase 4.2
r.get('/reports/summary', routerAuth, async (req, res) => {
  try {
    const range = req.query.range || 'today';
    if (range !== 'today') {
      return res.status(400).json({ ok: false, error: 'Unsupported range' });
    }

    const profile = sanitizeProfile(req.router.profile);
    const { start, end } = todayRangeInTimezone(profile.timezone || 'Asia/Manila');
    const routerId = req.router.routerId;

    const [summary] = await SaleEvent.aggregate([
      {
        $match: {
          routerId,
          ts: { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$amount' },
          totalVouchers: { $sum: 1 }
        }
      }
    ]);

    const [topDeviceRow] = await SaleEvent.aggregate([
      {
        $match: {
          routerId,
          ts: { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: '$deviceId',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' }
        }
      },
      { $sort: { count: -1, totalAmount: -1 } },
      { $limit: 1 }
    ]);

    const activeSessionCount = await Session.countDocuments({
      routerId,
      status: 'active',
      expiresAt: { $gt: new Date() }
    });

    return res.json({
      ok: true,
      range: 'today',
      totalAmount: summary ? summary.totalAmount : 0,
      totalVouchers: summary ? summary.totalVouchers : 0,
      topDevice: topDeviceRow ? topDeviceRow._id : null,
      activeSessionCount
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Phase 4: voucher usage report (range: today | week)
r.get('/reports/vouchers', routerAuth, async (req, res) => {
  try {
    const range = req.query.range || 'today';
    const profile = sanitizeProfile(req.router.profile);
    const routerId = req.router.routerId;
    const now = new Date();

    let start;
    if (range === 'week') {
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else {
      const { start: s } = todayRangeInTimezone(profile.timezone || 'Asia/Manila');
      start = s;
    }

    const [created] = await Voucher.aggregate([
      { $match: { routerId, createdAt: { $gte: start, $lte: now } } },
      { $group: { _id: null, count: { $sum: 1 } } }
    ]);

    const [redeemed] = await Voucher.aggregate([
      {
        $match: {
          status: 'redeemed',
          redeemedAt: { $gte: start, $lte: now },
          $or: [
            { redeemedRouterId: routerId },
            { redeemedRouterId: null, routerId }
          ]
        }
      },
      { $group: { _id: null, count: { $sum: 1 }, totalMinutes: { $sum: '$minutes' } } }
    ]);

    const byDevice = await Voucher.aggregate([
      {
        $match: {
          status: 'redeemed',
          redeemedAt: { $gte: start, $lte: now },
          deviceId: { $ne: null, $exists: true },
          $or: [
            { redeemedRouterId: routerId },
            { redeemedRouterId: null, routerId }
          ]
        }
      },
      { $group: { _id: '$deviceId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);

    return res.json({
      ok: true,
      range,
      created: created ? created.count : 0,
      redeemed: redeemed ? redeemed.count : 0,
      totalMinutesRedeemed: redeemed ? redeemed.totalMinutes : 0,
      topDevices: byDevice.map((d) => ({ deviceId: d._id, count: d.count }))
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Phase 4: active sessions list
r.get('/reports/sessions/active', routerAuth, async (req, res) => {
  try {
    const routerId = req.router.routerId;
    const now = new Date();

    await Session.updateMany(
      { routerId, status: 'active', expiresAt: { $lte: now } },
      { $set: { status: 'ended', endedAt: now } }
    );

    const sessions = await Session.find({
      routerId,
      status: 'active',
      expiresAt: { $gt: now }
    })
      .sort({ startedAt: -1 })
      .limit(50)
      .select('voucherCode clientIp clientMac deviceId minutesGranted startedAt expiresAt')
      .lean();

    const count = await Session.countDocuments({
      routerId,
      status: 'active',
      expiresAt: { $gt: now }
    });

    return res.json({
      ok: true,
      count,
      sessions
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = r;

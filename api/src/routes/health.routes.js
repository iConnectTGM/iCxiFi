/**
 * Health check for monitoring and load balancers.
 * Unauthenticated; reports API and DB status.
 */
const express = require('express');
const mongoose = require('mongoose');

const r = express.Router();
const startTime = Date.now();

r.get('/', async (_req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbOk = dbState === 1; // 1 = connected

  return res.json({
    ok: dbOk,
    db: dbOk ? 'connected' : ['disconnected', 'connecting', 'connected', 'disconnecting'][dbState] || 'unknown',
    uptimeSec: Math.floor((Date.now() - startTime) / 1000),
    adminConfigured: !!(process.env.ADMIN_API_KEY || '').trim()
  });
});

module.exports = r;

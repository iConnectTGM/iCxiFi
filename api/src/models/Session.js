/**
 * Phase 4: Session accounting.
 * Tracks active/recent voucher sessions for reporting.
 */
const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  routerId: { type: String, index: true, required: true },
  voucherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher', default: null },
  voucherCode: { type: String, default: null },
  clientIp: { type: String, default: null },
  clientMac: { type: String, default: null },
  deviceId: { type: String, default: null },
  minutesGranted: { type: Number, required: true },
  downloadKbps: { type: Number, default: 10000 },
  uploadKbps: { type: Number, default: 10000 },
  startedAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true, index: true },
  endedAt: { type: Date, default: null },
  status: { type: String, enum: ['active', 'ended'], default: 'active', index: true }
});

sessionSchema.index({ routerId: 1, status: 1 });
sessionSchema.index({ routerId: 1, expiresAt: 1 });

module.exports = mongoose.model('Session', sessionSchema);

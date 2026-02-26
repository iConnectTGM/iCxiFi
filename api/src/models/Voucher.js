const mongoose = require('mongoose');

const voucherSchema = new mongoose.Schema({
  routerId: { type: String, index: true, required: true },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
  code: { type: String, required: true },
  minutes: { type: Number, required: true },
  amount: { type: Number, required: true },
  downloadKbps: { type: Number, default: 10000 },
  uploadKbps: { type: Number, default: 10000 },
  downloadQuotaKB: { type: Number, default: 0 },
  uploadQuotaKB: { type: Number, default: 0 },
  deviceId: { type: String, default: null },
  status: { type: String, enum: ['unused', 'redeemed'], default: 'unused' },
  expiresAt: { type: Date, required: true },
  clientHint: { type: mongoose.Schema.Types.Mixed, default: null },
  redeemedClient: {
    type: new mongoose.Schema(
      {
        ip: { type: String, default: null },
        mac: { type: String, default: null }
      },
      { _id: false }
    ),
    default: () => ({ ip: null, mac: null })
  },
  createdAt: { type: Date, default: Date.now },
  redeemedAt: { type: Date, default: null },
  redeemedRouterId: { type: String, default: null, index: true }
});

voucherSchema.index({ routerId: 1, code: 1 }, { unique: true });
voucherSchema.index(
  { tenantId: 1, code: 1 },
  { unique: true, partialFilterExpression: { tenantId: { $exists: true, $ne: null } } }
);

module.exports = mongoose.model('Voucher', voucherSchema);

const mongoose = require('mongoose');

const portableGrantSchema = new mongoose.Schema(
  {
    scopeId: { type: String, required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    clientKey: { type: String, required: true },
    clientMac: { type: String, default: null },
    clientIp: { type: String, default: null },
    status: { type: String, enum: ['active', 'paused', 'ended'], default: 'active', index: true },
    remainingSeconds: { type: Number, default: 0 },
    activeRouterId: { type: String, default: null, index: true },
    lastRouterId: { type: String, default: null },
    deviceId: { type: String, default: null },
    downloadKbps: { type: Number, default: 10000 },
    uploadKbps: { type: Number, default: 10000 },
    downloadQuotaKB: { type: Number, default: 0 },
    uploadQuotaKB: { type: Number, default: 0 },
    stateChangedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

portableGrantSchema.index({ scopeId: 1, clientKey: 1 }, { unique: true });

module.exports = mongoose.model('PortableGrant', portableGrantSchema);

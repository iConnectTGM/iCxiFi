const mongoose = require('mongoose');

const licenseOnlyTransferRequestSchema = new mongoose.Schema({
  licenseKey: { type: String, required: true, index: true },
  fromTenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  toTenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  targetEmail: { type: String, required: true, index: true },
  mode: { type: String, enum: ['internal', 'email'], default: 'internal', index: true },
  tokenHash: { type: String, required: true, index: true },
  resendCount: { type: Number, default: 0 },
  lastResentAt: { type: Date, default: null },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected', 'cancelled', 'expired'],
    default: 'pending',
    index: true
  },
  expiresAt: { type: Date, required: true, index: true },
  acceptedAt: { type: Date, default: null },
  rejectedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, index: true }
});

module.exports = mongoose.model('LicenseOnlyTransferRequest', licenseOnlyTransferRequestSchema);


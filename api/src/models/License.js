const mongoose = require('mongoose');

const licenseSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  seatsRouters: { type: Number, default: 1 },
  isActive: { type: Boolean, default: true },
  assignedTenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null },
  assignedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null }
});

module.exports = mongoose.model('License', licenseSchema);

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null }, // null for super_admin
  email: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  resetPasswordTokenHash: { type: String, default: null },
  resetPasswordExpiresAt: { type: Date, default: null },
  role: { type: String, enum: ['super_admin', 'owner'], default: 'owner' }, // super_admin = platform owner, owner = client
  name: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);

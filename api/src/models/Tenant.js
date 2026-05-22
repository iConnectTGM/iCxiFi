const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({
  name: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  transactionHistoryClearedAt: { type: Date, default: null }
});

module.exports = mongoose.model('Tenant', tenantSchema);

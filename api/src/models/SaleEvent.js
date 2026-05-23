const mongoose = require('mongoose');

const saleEventSchema = new mongoose.Schema({
  routerId: { type: String, index: true, required: true },
  deviceId: { type: String, default: null },
  amount: { type: Number, required: true },
  voucherCode: { type: String, default: null },
  localEventId: { type: String, default: null },
  ts: { type: Date, index: true, required: true },
  createdAt: { type: Date, default: Date.now }
});

saleEventSchema.index(
  { routerId: 1, localEventId: 1 },
  { unique: true, partialFilterExpression: { localEventId: { $type: 'string' } } }
);

module.exports = mongoose.model('SaleEvent', saleEventSchema);

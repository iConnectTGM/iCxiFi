const mongoose = require('mongoose');

const defaultRates = [
  { amount: 5, minutes: 15 },
  { amount: 10, minutes: 35 },
  { amount: 20, minutes: 90 }
];

const profileSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: ['vendo', 'voucher', 'hybrid'], default: 'hybrid' },
    currency: { type: String, default: 'PHP' },
    timezone: { type: String, default: 'Asia/Manila' },
    voucherLength: { type: Number, default: 8 },
    rates: {
      type: [
        new mongoose.Schema(
          {
            amount: { type: Number, required: true },
            minutes: { type: Number, required: true },
            downloadKbps: { type: Number, default: 10000 },
            uploadKbps: { type: Number, default: 10000 },
            downloadQuotaKB: { type: Number, default: 0 },
            uploadQuotaKB: { type: Number, default: 0 }
          },
          { _id: false }
        )
      ],
      default: () => defaultRates.map((r) => ({ amount: r.amount, minutes: r.minutes }))
    },
    limits: {
      type: new mongoose.Schema(
        {
          maxCreatePerMinute: { type: Number, default: 60 },
          maxRedeemPerMinute: { type: Number, default: 120 }
        },
        { _id: false }
      ),
      default: () => ({ maxCreatePerMinute: 60, maxRedeemPerMinute: 120 })
    },
    speedCalibration: {
      type: new mongoose.Schema(
        {
          downloadPercent: { type: Number, default: 100 },
          uploadPercent: { type: Number, default: 100 }
        },
        { _id: false }
      ),
      default: () => ({ downloadPercent: 100, uploadPercent: 100 })
    }
  },
  { _id: false }
);

const metaSchema = new mongoose.Schema(
  {
    uptimeSec: { type: Number, default: null },
    fwVersion: { type: String, default: null },
    wanIp: { type: String, default: null },
    lanIp: { type: String, default: null }
  },
  { _id: false }
);

// Phase 3: remote-manage config
const hotspotSchema = new mongoose.Schema(
  {
    ssid: { type: String, default: null },
    welcomeMsg: { type: String, default: null },
    separateBands: { type: Boolean, default: false },
    ssid24: { type: String, default: null },
    ssid5: { type: String, default: null }
  },
  { _id: false }
);

const portalSchema = new mongoose.Schema(
  {
    theme: { type: String, enum: ['default', 'blue', 'starlink'], default: 'default' }
  },
  { _id: false }
);

const commandSchema = new mongoose.Schema(
  {
    type: { type: String, required: true }, // restart_opennds, restart_wireless, rotate_key
    payload: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const routerSchema = new mongoose.Schema({
  routerId: { type: String, unique: true, index: true, required: true },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null },
  licenseKey: { type: String, default: null },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  routerApiKeyHash: { type: String, default: null },
  status: { type: String, enum: ['active', 'disabled', 'revoked'], default: 'active' }, // active | revoked | disabled
  profile: { type: profileSchema, default: () => ({}) },
  meta: { type: metaSchema, default: () => ({}) },
  hotspot: { type: hotspotSchema, default: () => ({}) },
  portal: { type: portalSchema, default: () => ({}) },
  commandQueue: { type: [commandSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  lastActivatedAt: { type: Date, default: null },
  lastSeenAt: { type: Date, default: null }
});

module.exports = mongoose.model('Router', routerSchema);

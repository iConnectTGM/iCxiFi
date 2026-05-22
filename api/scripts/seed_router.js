const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

const Router = require('../src/models/Router');
const { hashApiKey } = require('../src/utils/crypto');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const routerId = process.env.SEED_ROUTER_ID || '10:82:3d:54:6e:fe';
const routerApiKeyPlaintext =
  process.env.SEED_ROUTER_API_KEY || `rk_live_${crypto.randomBytes(24).toString('hex')}`;
const routerName = process.env.SEED_ROUTER_NAME || 'Ruijie EW1200G Pro';

const defaultProfile = {
  mode: 'hybrid',
  currency: 'PHP',
  timezone: 'Asia/Manila',
  voucherLength: 8,
  rates: [
    { amount: 5, minutes: 15 },
    { amount: 10, minutes: 35 },
    { amount: 20, minutes: 90 }
  ],
  limits: {
    maxCreatePerMinute: 60,
    maxRedeemPerMinute: 120
  }
};

async function run() {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is required');
  }
  await mongoose.connect(process.env.MONGO_URI);

  const router = await Router.findOneAndUpdate(
    { routerId },
    {
      $set: {
        name: routerName,
        status: 'active',
        routerApiKeyHash: hashApiKey(routerApiKeyPlaintext),
        profile: defaultProfile
      }
    },
    { upsert: true, new: true }
  );

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        routerId: router.routerId,
        routerApiKey: routerApiKeyPlaintext,
        status: router.status,
        profile: router.profile
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

run().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});

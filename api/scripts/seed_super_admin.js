#!/usr/bin/env node
/**
 * Create the first super_admin user (optional).
 * Run: node scripts/seed_super_admin.js
 * Uses env: SEED_SUPER_ADMIN_EMAIL, SEED_SUPER_ADMIN_PASSWORD
 */
const path = require('path');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const User = require('../src/models/User');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const email = (process.env.SEED_SUPER_ADMIN_EMAIL || 'admin@icxifi.local').toLowerCase();
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD || 'admin123';

  const existing = await User.findOne({ email });
  if (existing) {
    console.log('Super admin already exists:', email);
    await mongoose.disconnect();
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await User.create({
    email,
    passwordHash,
    role: 'super_admin',
    tenantId: null,
    name: 'Super Admin'
  });

  console.log('Super admin created:', email);
  console.log('You can login at /admin (if JWT login is enabled) or use ADMIN_API_KEY for API key auth.');
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});

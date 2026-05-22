const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const Tenant = require('../models/Tenant');
const User = require('../models/User');
const { isMailerConfigured, sendPasswordResetEmail } = require('../utils/mailer');

const router = express.Router();
const RESET_SUCCESS_MSG = 'If that email exists, a password reset link has been sent.';
const parsedResetTokenTtlMs = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MS);
const RESET_TOKEN_TTL_MS = Number.isFinite(parsedResetTokenTtlMs) && parsedResetTokenTtlMs > 0
  ? parsedResetTokenTtlMs
  : 15 * 60 * 1000;

function signToken(user) {
  return jwt.sign(
    { userId: user._id, tenantId: user.tenantId, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function buildResetUrl(req, rawToken) {
  const base = process.env.CLIENT_DASHBOARD_URL || `${req.protocol}://${req.get('host')}/dashboard`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}resetToken=${encodeURIComponent(rawToken)}`;
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }

    const normalizedEmail = String(email).toLowerCase();
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const tenant = await Tenant.create({ name });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      tenantId: tenant._id,
      email: normalizedEmail,
      passwordHash,
      role: 'owner',
      name: String(name || '').trim()
    });

    return res.json({ token: signToken(user) });
  } catch (error) {
    return res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const normalizedEmail = String(email).toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    return res.json({ token: signToken(user) });
  } catch (error) {
    return res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });
    let debugResetToken;

    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      user.resetPasswordTokenHash = hashResetToken(rawToken);
      user.resetPasswordExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await user.save();

      const resetUrl = buildResetUrl(req, rawToken);
      const mailConfigured = isMailerConfigured();
      const ttlMinutes = Math.max(1, Math.ceil(RESET_TOKEN_TTL_MS / 60000));
      if (mailConfigured) {
        try {
          await sendPasswordResetEmail({ to: normalizedEmail, resetUrl, ttlMinutes });
          console.log(`[auth] Password reset email sent to ${normalizedEmail}`);
        } catch (mailError) {
          console.error(`[auth] Failed to send reset email to ${normalizedEmail}: ${mailError.message}`);
          console.log(`[auth] Password reset URL fallback for ${normalizedEmail}: ${resetUrl}`);
        }
      } else {
        console.log(`[auth] SMTP not configured. Password reset URL for ${normalizedEmail}: ${resetUrl}`);
      }

      if (process.env.NODE_ENV !== 'production' || process.env.AUTH_DEBUG_TOKENS === '1') {
        debugResetToken = rawToken;
      }
    }

    const payload = { ok: true, message: RESET_SUCCESS_MSG };
    if (debugResetToken) {
      payload.debugResetToken = debugResetToken;
    }
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ error: 'Could not process forgot password request' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ error: 'token and password are required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const tokenHash = hashResetToken(token);
    const user = await User.findOne({
      resetPasswordTokenHash: tokenHash,
      resetPasswordExpiresAt: { $gt: new Date() }
    });
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    user.passwordHash = await bcrypt.hash(password, 10);
    user.resetPasswordTokenHash = null;
    user.resetPasswordExpiresAt = null;
    await user.save();

    return res.json({ ok: true, message: 'Password reset successful. You can now log in.' });
  } catch (error) {
    return res.status(500).json({ error: 'Reset password failed' });
  }
});

module.exports = router;

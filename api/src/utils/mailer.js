const nodemailer = require('nodemailer');

let transporter;

function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true' || String(value) === '1';
}

function getSmtpAuth() {
  const user = process.env.BREVO_SMTP_USER || process.env.SMTP_USER || '';
  const pass = process.env.BREVO_SMTP_PASS || process.env.SMTP_PASS || '';
  return { user, pass };
}

function getFromAddress() {
  const email = process.env.BREVO_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || process.env.MAIL_FROM || '';
  const name = process.env.BREVO_FROM_NAME || process.env.SMTP_FROM_NAME || process.env.MAIL_FROM_NAME || 'iCxiFi Support';
  if (!email) return '';
  return name ? `"${name}" <${email}>` : email;
}

function isMailerConfigured() {
  const auth = getSmtpAuth();
  return Boolean(auth.user && auth.pass && getFromAddress());
}

function getTransporter() {
  if (transporter) return transporter;
  const auth = getSmtpAuth();
  if (!auth.user || !auth.pass) return null;

  const host = process.env.BREVO_SMTP_HOST || process.env.SMTP_HOST || 'smtp-relay.brevo.com';
  const parsedPort = Number(process.env.BREVO_SMTP_PORT || process.env.SMTP_PORT || 587);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 587;
  const secure = parseBool(process.env.BREVO_SMTP_SECURE || process.env.SMTP_SECURE, false);

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth
  });
  return transporter;
}

async function sendPasswordResetEmail({ to, resetUrl, ttlMinutes = 15 }) {
  const from = getFromAddress();
  const tx = getTransporter();
  if (!from || !tx) {
    throw new Error('SMTP is not configured');
  }

  const subject = 'Reset your iCxiFi password';
  const text = [
    'We received a request to reset your iCxiFi password.',
    '',
    `Reset link: ${resetUrl}`,
    '',
    `This link expires in ${ttlMinutes} minutes.`,
    'If you did not request this, you can ignore this email.'
  ].join('\n');
  const html = [
    '<p>We received a request to reset your <strong>iCxiFi</strong> password.</p>',
    `<p><a href="${resetUrl}">Click here to reset your password</a></p>`,
    `<p>This link expires in ${ttlMinutes} minutes.</p>`,
    '<p>If you did not request this, you can ignore this email.</p>'
  ].join('');

  return tx.sendMail({
    from,
    to,
    subject,
    text,
    html
  });
}

async function sendRouterLicenseChangeEmail({
  to,
  ownerName = '',
  routerName = '',
  routerId = '',
  action = 'updated',
  previousLicenseKey = '',
  licenseKey = '',
  dashboardUrl = ''
}) {
  const from = getFromAddress();
  const tx = getTransporter();
  if (!from || !tx) {
    throw new Error('SMTP is not configured');
  }

  const safeRouterName = routerName || routerId || 'Router';
  const actionMap = {
    removed: {
      subject: `License removed: ${safeRouterName}`,
      headline: 'A router license was removed',
      detail: 'The router is now disabled and must be activated again from the router registration page.'
    },
    added: {
      subject: `License added: ${safeRouterName}`,
      headline: 'A router license was added',
      detail: 'The router now has a license in cloud configuration.'
    },
    transferred: {
      subject: `License changed: ${safeRouterName}`,
      headline: 'A router license was transferred',
      detail: 'The router license key was updated in cloud configuration.'
    },
    updated: {
      subject: `Router updated: ${safeRouterName}`,
      headline: 'A router was updated',
      detail: 'Router licensing details were changed.'
    }
  };
  const picked = actionMap[action] || actionMap.updated;

  const text = [
    `Hello${ownerName ? ` ${ownerName}` : ''},`,
    '',
    picked.headline + '.',
    `Router: ${safeRouterName}`,
    `Router ID: ${routerId || '-'}`,
    `Previous license: ${previousLicenseKey || '-'}`,
    `Current license: ${licenseKey || '-'}`,
    '',
    picked.detail,
    dashboardUrl ? `Dashboard: ${dashboardUrl}` : '',
    '',
    'If this was not expected, please review your account activity.'
  ]
    .filter(Boolean)
    .join('\n');

  const html = [
    `<p>Hello${ownerName ? ` ${ownerName}` : ''},</p>`,
    `<p>${picked.headline}.</p>`,
    '<ul>',
    `<li><strong>Router:</strong> ${safeRouterName}</li>`,
    `<li><strong>Router ID:</strong> ${routerId || '-'}</li>`,
    `<li><strong>Previous license:</strong> ${previousLicenseKey || '-'}</li>`,
    `<li><strong>Current license:</strong> ${licenseKey || '-'}</li>`,
    '</ul>',
    `<p>${picked.detail}</p>`,
    dashboardUrl ? `<p><a href="${dashboardUrl}">Open Dashboard</a></p>` : '',
    '<p>If this was not expected, please review your account activity.</p>'
  ].join('');

  return tx.sendMail({
    from,
    to,
    subject: picked.subject,
    text,
    html
  });
}

async function sendRouterTransferRequestEmail({
  to,
  fromOwnerName = '',
  fromOwnerEmail = '',
  routerName = '',
  routerId = '',
  licenseKey = '',
  acceptUrl = '',
  expiresInHours = 24
}) {
  const from = getFromAddress();
  const tx = getTransporter();
  if (!from || !tx) {
    throw new Error('SMTP is not configured');
  }

  const safeRouterName = routerName || routerId || 'Router';
  const subject = `Router transfer request: ${safeRouterName}`;

  const text = [
    `You received a router transfer request${fromOwnerName ? ` from ${fromOwnerName}` : ''}.`,
    '',
    `Router: ${safeRouterName}`,
    `Router ID: ${routerId || '-'}`,
    `License key: ${licenseKey || '-'}`,
    fromOwnerEmail ? `Requested by: ${fromOwnerEmail}` : '',
    '',
    acceptUrl ? `Accept transfer: ${acceptUrl}` : '',
    `This request expires in ${expiresInHours} hour(s).`,
    '',
    'If you did not expect this, ignore this email.'
  ]
    .filter(Boolean)
    .join('\n');

  const html = [
    `<p>You received a router transfer request${fromOwnerName ? ` from <strong>${fromOwnerName}</strong>` : ''}.</p>`,
    '<ul>',
    `<li><strong>Router:</strong> ${safeRouterName}</li>`,
    `<li><strong>Router ID:</strong> ${routerId || '-'}</li>`,
    `<li><strong>License key:</strong> ${licenseKey || '-'}</li>`,
    fromOwnerEmail ? `<li><strong>Requested by:</strong> ${fromOwnerEmail}</li>` : '',
    '</ul>',
    acceptUrl ? `<p><a href="${acceptUrl}">Click here to accept transfer</a></p>` : '',
    `<p>This request expires in ${expiresInHours} hour(s).</p>`,
    '<p>If you did not expect this, ignore this email.</p>'
  ].join('');

  return tx.sendMail({
    from,
    to,
    subject,
    text,
    html
  });
}

async function sendLicenseTransferRequestEmail({
  to,
  fromOwnerName = '',
  fromOwnerEmail = '',
  licenseKey = '',
  acceptUrl = '',
  expiresInHours = 24
}) {
  const from = getFromAddress();
  const tx = getTransporter();
  if (!from || !tx) {
    throw new Error('SMTP is not configured');
  }

  const subject = `License transfer request: ${licenseKey || '-'}`;

  const text = [
    `You received a license transfer request${fromOwnerName ? ` from ${fromOwnerName}` : ''}.`,
    '',
    `License key: ${licenseKey || '-'}`,
    fromOwnerEmail ? `Requested by: ${fromOwnerEmail}` : '',
    '',
    acceptUrl ? `Accept transfer: ${acceptUrl}` : '',
    `This request expires in ${expiresInHours} hour(s).`,
    '',
    'If you did not expect this, ignore this email.'
  ]
    .filter(Boolean)
    .join('\n');

  const html = [
    `<p>You received a license transfer request${fromOwnerName ? ` from <strong>${fromOwnerName}</strong>` : ''}.</p>`,
    '<ul>',
    `<li><strong>License key:</strong> ${licenseKey || '-'}</li>`,
    fromOwnerEmail ? `<li><strong>Requested by:</strong> ${fromOwnerEmail}</li>` : '',
    '</ul>',
    acceptUrl ? `<p><a href="${acceptUrl}">Click here to accept transfer</a></p>` : '',
    `<p>This request expires in ${expiresInHours} hour(s).</p>`,
    '<p>If you did not expect this, ignore this email.</p>'
  ].join('');

  return tx.sendMail({
    from,
    to,
    subject,
    text,
    html
  });
}

module.exports = {
  isMailerConfigured,
  sendPasswordResetEmail,
  sendRouterLicenseChangeEmail,
  sendRouterTransferRequestEmail,
  sendLicenseTransferRequestEmail
};

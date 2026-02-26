const DEFAULT_DOWNLOAD_KBPS = 10000;
const DEFAULT_UPLOAD_KBPS = 10000;
const DEFAULT_SPEED_CALIBRATION = {
  downloadPercent: 100,
  uploadPercent: 100
};

const DEFAULT_PROFILE = {
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

function toPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toPercent(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < 50) return 50;
  if (rounded > 150) return 150;
  return rounded;
}

function sanitizeProfile(rawProfile) {
  const profile = rawProfile || {};

  const mode = ['vendo', 'voucher', 'hybrid'].includes(profile.mode)
    ? profile.mode
    : DEFAULT_PROFILE.mode;
  const currency = profile.currency ? String(profile.currency) : DEFAULT_PROFILE.currency;
  const timezone = profile.timezone ? String(profile.timezone) : DEFAULT_PROFILE.timezone;
  const voucherLength = Number.isInteger(profile.voucherLength) && profile.voucherLength >= 4
    ? profile.voucherLength
    : DEFAULT_PROFILE.voucherLength;

  const rates = Array.isArray(profile.rates)
    ? profile.rates
        .map((rate) => {
          const amount = toPositiveNumber(rate && rate.amount);
          const minutes = toPositiveNumber(rate && rate.minutes);
          if (!amount || !minutes) return null;
          const downloadKbps = toPositiveNumber(rate.downloadKbps) || DEFAULT_DOWNLOAD_KBPS;
          const uploadKbps = toPositiveNumber(rate.uploadKbps) || DEFAULT_UPLOAD_KBPS;
          const downloadQuotaKB = Number.isFinite(Number(rate.downloadQuotaKB)) ? Number(rate.downloadQuotaKB) : 0;
          const uploadQuotaKB = Number.isFinite(Number(rate.uploadQuotaKB)) ? Number(rate.uploadQuotaKB) : 0;
          return {
            amount,
            minutes,
            downloadKbps,
            uploadKbps,
            downloadQuotaKB: downloadQuotaKB >= 0 ? downloadQuotaKB : 0,
            uploadQuotaKB: uploadQuotaKB >= 0 ? uploadQuotaKB : 0
          };
        })
        .filter(Boolean)
    : [];

  const limitsRaw = profile.limits || {};
  const maxCreatePerMinute = Number.isInteger(limitsRaw.maxCreatePerMinute) && limitsRaw.maxCreatePerMinute > 0
    ? limitsRaw.maxCreatePerMinute
    : DEFAULT_PROFILE.limits.maxCreatePerMinute;
  const maxRedeemPerMinute = Number.isInteger(limitsRaw.maxRedeemPerMinute) && limitsRaw.maxRedeemPerMinute > 0
    ? limitsRaw.maxRedeemPerMinute
    : DEFAULT_PROFILE.limits.maxRedeemPerMinute;
  const speedCalibrationRaw = profile.speedCalibration || {};
  const speedCalibration = {
    downloadPercent: toPercent(speedCalibrationRaw.downloadPercent, DEFAULT_SPEED_CALIBRATION.downloadPercent),
    uploadPercent: toPercent(speedCalibrationRaw.uploadPercent, DEFAULT_SPEED_CALIBRATION.uploadPercent)
  };

  const defaultRatesWithSpeed = DEFAULT_PROFILE.rates.map((r) => ({
    ...r,
    downloadKbps: DEFAULT_DOWNLOAD_KBPS,
    uploadKbps: DEFAULT_UPLOAD_KBPS,
    downloadQuotaKB: 0,
    uploadQuotaKB: 0
  }));

  return {
    mode,
    currency,
    timezone,
    voucherLength,
    rates: rates.length ? rates : defaultRatesWithSpeed,
    speedCalibration,
    limits: {
      maxCreatePerMinute,
      maxRedeemPerMinute
    }
  };
}

module.exports = {
  DEFAULT_PROFILE,
  DEFAULT_DOWNLOAD_KBPS,
  DEFAULT_UPLOAD_KBPS,
  DEFAULT_SPEED_CALIBRATION,
  toPositiveNumber,
  sanitizeProfile
};

// OTP Management API — stores OTPs per service (zipy, etrav) with 5-min expiry.
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const OTP_STORE_PATH = path.join(__dirname, '../../state/fraka/otpStore.json');
const OTP_EXPIRY_MS = 5 * 60 * 1000;

function loadStore() {
  try { return JSON.parse(fs.readFileSync(OTP_STORE_PATH, 'utf-8')); }
  catch { return { entries: [] }; }
}
function saveStore(store) {
  fs.writeFileSync(OTP_STORE_PATH, JSON.stringify(store, null, 2));
}
function isExpired(entry) {
  return Date.now() - new Date(entry.submittedAt).getTime() > OTP_EXPIRY_MS;
}

function submitOtpApi(req, res) {
  try {
    const { service, code } = req.body || {};
    if (!service || !['zipy', 'etrav'].includes(service))
      return res.status(400).json({ error: 'service must be "zipy" or "etrav"' });
    if (!code || typeof code !== 'string' || !code.trim())
      return res.status(400).json({ error: 'code is required' });

    const store = loadStore();
    const now = new Date().toISOString();
    store.entries.push({ service, code: code.trim(), submittedAt: now, used: false, usedAt: null });
    store.entries = store.entries.slice(-20);
    saveStore(store);
    logger.info('[OTP] Submitted ' + service + ' OTP');
    res.json({ success: true, service, expiresAt: new Date(Date.now() + OTP_EXPIRY_MS).toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function getLatestOtpApi(req, res) {
  try {
    const service = req.query.service || 'zipy';
    const store = loadStore();
    const c = store.entries.filter(e => e.service === service && !e.used && !isExpired(e))
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    if (c.length === 0) return res.json({ otp: null, service });
    const entry = c[0];
    const expiresIn = OTP_EXPIRY_MS - (Date.now() - new Date(entry.submittedAt).getTime());
    res.json({ otp: entry.code, service, submittedAt: entry.submittedAt, expiresInSec: Math.max(0, Math.floor(expiresIn / 1000)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function otpHistoryApi(req, res) {
  try {
    const store = loadStore();
    const entries = store.entries.slice(-10).reverse().map(e => ({
      ...e, expired: isExpired(e), codeDisplay: e.code.slice(0, 2) + '****',
    }));
    res.json({ entries });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function getOtpForService(service) {
  const store = loadStore();
  const c = store.entries.filter(e => e.service === service && !e.used && !isExpired(e))
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  return c.length > 0 ? c[0].code : null;
}

function markOtpUsed(service, code) {
  const store = loadStore();
  const e = store.entries.find(x => x.service === service && x.code === code && !x.used);
  if (e) { e.used = true; e.usedAt = new Date().toISOString(); saveStore(store); return true; }
  return false;
}

module.exports = { submitOtpApi, getLatestOtpApi, otpHistoryApi, getOtpForService, markOtpUsed, loadStore };

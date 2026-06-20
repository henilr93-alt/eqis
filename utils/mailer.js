/**
 * mailer.js — Gmail API send-only wrapper for EQIS daily digests.
 *
 * Mirrors the OAuth pattern used by utils/driveStorage.js (same googleapis
 * library, different scope: gmail.send instead of drive). Sends RFC-2822
 * messages from eqis@etrav.in (or whichever account the OAuth token belongs
 * to) to one or more recipients.
 *
 * Auth (first match wins):
 *   1. GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_CLIENT_SECRET + GMAIL_OAUTH_REFRESH_TOKEN env vars
 *   2. state/gmail-oauth-client.json + state/gmail-oauth-token.json on disk
 *
 * When neither is present the module runs in DRY-RUN mode: send() returns
 * { ok: true, dryRun: true, messageId: null } without contacting Gmail. The
 * full email payload is still logged + written to emailHistory.json so the
 * operator can preview what would have been sent.
 *
 * Sender identity defaults to "EQIS <eqis@etrav.in>" — override via
 * EQIS_MAILER_FROM env var.
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const logger = require('./logger');

const DEFAULT_FROM = process.env.EQIS_MAILER_FROM || 'EQIS <eqis@etrav.in>';

let _gmailClient = null;
let _authError = null;

function loadOAuthConfig() {
  // 1) env vars (production / Railway)
  if (process.env.GMAIL_OAUTH_CLIENT_ID
      && process.env.GMAIL_OAUTH_CLIENT_SECRET
      && process.env.GMAIL_OAUTH_REFRESH_TOKEN) {
    return {
      client_id: process.env.GMAIL_OAUTH_CLIENT_ID,
      client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
    };
  }
  // 2) local files (dev)
  const clientPath = path.join(__dirname, '..', 'state', 'gmail-oauth-client.json');
  const tokenPath  = path.join(__dirname, '..', 'state', 'gmail-oauth-token.json');
  if (fs.existsSync(clientPath) && fs.existsSync(tokenPath)) {
    const clientRaw = JSON.parse(fs.readFileSync(clientPath, 'utf-8'));
    const c = clientRaw.installed || clientRaw.web || clientRaw;
    const tok = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    if (!c.client_id || !c.client_secret) throw new Error('Gmail OAuth client JSON missing client_id/secret');
    if (!tok.refresh_token) throw new Error('Gmail OAuth token JSON missing refresh_token — run authorize-gmail.js first');
    return {
      client_id: c.client_id,
      client_secret: c.client_secret,
      refresh_token: tok.refresh_token,
    };
  }
  return null; // DRY-RUN mode
}

function getGmailClient() {
  if (_gmailClient) return _gmailClient;
  if (_authError) throw _authError;
  const cfg = loadOAuthConfig();
  if (!cfg) return null; // signal DRY-RUN
  try {
    const auth = new google.auth.OAuth2(cfg.client_id, cfg.client_secret);
    auth.setCredentials({ refresh_token: cfg.refresh_token });
    _gmailClient = google.gmail({ version: 'v1', auth });
    return _gmailClient;
  } catch (err) {
    _authError = err;
    throw err;
  }
}

/**
 * Is the mailer configured to actually send (vs DRY-RUN)?
 */
function isEnabled() {
  return !!loadOAuthConfig();
}

/**
 * Encode a string as base64url (Gmail API's required encoding for the raw
 * RFC-2822 message). Replaces +/= with URL-safe variants.
 */
function base64Url(input) {
  return Buffer.from(input, 'utf-8').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Build a minimal RFC-2822 multipart/alternative message with both plain-text
 * and HTML parts. Keeps deliverability high (most filters expect both).
 */
function buildRawMessage({ from, to, subject, html, text }) {
  const boundary = '----=_eqis_' + Date.now().toString(36);
  const recipients = Array.isArray(to) ? to.join(', ') : to;
  const textPart = text || htmlToPlain(html);
  // Subject must be RFC-2047 encoded if it has non-ASCII chars
  const encodedSubject = /[^\x00-\x7F]/.test(subject)
    ? '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?='
    : subject;
  return [
    'From: ' + from,
    'To: ' + recipients,
    'Subject: ' + encodedSubject,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    textPart,
    '',
    '--' + boundary,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    '',
    '--' + boundary + '--',
    '',
  ].join('\r\n');
}

function htmlToPlain(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Send an email. Returns { ok, dryRun, messageId, error, recipients, subject }.
 * Never throws — always returns a result object so the caller can write to
 * emailHistory.json without try/catch boilerplate.
 *
 * @param {Object} opts
 * @param {string|string[]} opts.to
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {string} [opts.text]   plain-text fallback (auto-derived if omitted)
 * @param {string} [opts.from]   override sender (default: EQIS_MAILER_FROM)
 */
async function send(opts) {
  const from = opts.from || DEFAULT_FROM;
  const recipients = Array.isArray(opts.to) ? opts.to : [opts.to];
  const cleanRecipients = recipients.filter((r) => r && typeof r === 'string' && /\S+@\S+\.\S+/.test(r));
  if (cleanRecipients.length === 0) {
    return { ok: false, dryRun: false, messageId: null, error: 'No valid recipients', recipients: [], subject: opts.subject };
  }

  const client = getGmailClient();
  if (!client) {
    // DRY-RUN — log what would have been sent
    logger.info('[MAILER] DRY-RUN — would send "' + opts.subject + '" to ' + cleanRecipients.join(', ') + ' (' + (opts.html || '').length + ' chars HTML)');
    return { ok: true, dryRun: true, messageId: null, error: null, recipients: cleanRecipients, subject: opts.subject, from };
  }

  try {
    const raw = buildRawMessage({ from, to: cleanRecipients, subject: opts.subject, html: opts.html, text: opts.text });
    const res = await client.users.messages.send({
      userId: 'me',
      requestBody: { raw: base64Url(raw) },
    });
    logger.info('[MAILER] Sent "' + opts.subject + '" to ' + cleanRecipients.join(', ') + ' (id=' + res.data.id + ')');
    return { ok: true, dryRun: false, messageId: res.data.id, error: null, recipients: cleanRecipients, subject: opts.subject, from };
  } catch (err) {
    logger.warn('[MAILER] Send failed: ' + err.message);
    return { ok: false, dryRun: false, messageId: null, error: err.message, recipients: cleanRecipients, subject: opts.subject, from };
  }
}

module.exports = { send, isEnabled, _internals: { buildRawMessage, htmlToPlain, base64Url } };

/**
 * gmailInbox.js — read the eqis@etrav.in inbox for tech-team replies that ask
 * for a run's details (FRAKA Email Reply, Engine 9 Leg 1).
 *
 * Reuses the SAME OAuth config loader as utils/mailer.js (env vars first, then
 * state/gmail-oauth-*.json). Requires the gmail.readonly scope — re-run
 * `node authorize-gmail.js` once to grant it. If OAuth is not configured the
 * reader returns [] (no crash) just like the mailer's DRY-RUN.
 *
 * Privacy / safety: ONLY messages whose sender matches the "tech" team in
 * state/emailRoster.json are returned. Everything else is ignored.
 *
 * ID detection:
 *   - FIA run id   →  FIA-XXXXXXXX-XXXX   (e.g. FIA-MQJJU8JY-1F56)
 *   - Issue number →  Issue #N           (mapped to a runId later by the collector)
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const logger = require('../../utils/logger');

const ROSTER_FILE = path.join(__dirname, '..', '..', 'state', 'emailRoster.json');

const FIA_RE = /FIA-[A-Z0-9]{8}-[A-Z0-9]{4}/i;
const ISSUE_RE = /Issue\s*#\s*(\d+)/i;

// Mirror utils/mailer.js loadOAuthConfig (env vars first, then disk).
function loadOAuthConfig() {
  if (process.env.GMAIL_OAUTH_CLIENT_ID
      && process.env.GMAIL_OAUTH_CLIENT_SECRET
      && process.env.GMAIL_OAUTH_REFRESH_TOKEN) {
    return {
      client_id: process.env.GMAIL_OAUTH_CLIENT_ID,
      client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
    };
  }
  const clientPath = path.join(__dirname, '..', '..', 'state', 'gmail-oauth-client.json');
  const tokenPath = path.join(__dirname, '..', '..', 'state', 'gmail-oauth-token.json');
  if (fs.existsSync(clientPath) && fs.existsSync(tokenPath)) {
    const clientRaw = JSON.parse(fs.readFileSync(clientPath, 'utf-8'));
    const c = clientRaw.installed || clientRaw.web || clientRaw;
    const tok = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    if (!c.client_id || !c.client_secret || !tok.refresh_token) return null;
    return { client_id: c.client_id, client_secret: c.client_secret, refresh_token: tok.refresh_token };
  }
  return null;
}

let _client = null;
function getGmailClient() {
  if (_client) return _client;
  const cfg = loadOAuthConfig();
  if (!cfg) return null;
  const auth = new google.auth.OAuth2(cfg.client_id, cfg.client_secret);
  auth.setCredentials({ refresh_token: cfg.refresh_token });
  _client = google.gmail({ version: 'v1', auth });
  return _client;
}

function isEnabled() {
  return !!loadOAuthConfig();
}

// Lower-cased set of allowed tech-team sender addresses.
function techSenders() {
  try {
    const roster = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf-8'));
    const tech = (roster.teams || []).find(t => t.id === 'tech');
    return new Set((tech && Array.isArray(tech.emails) ? tech.emails : []).map(e => String(e).toLowerCase()));
  } catch { return new Set(); }
}

// Pull the bare email address out of a "Name <addr@x>" From header.
function parseAddress(from) {
  const m = /<([^>]+)>/.exec(from || '');
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

function headerVal(headers, name) {
  const h = (headers || []).find(x => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// Recursively pull a text/plain body out of a Gmail payload tree.
function extractBodyText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const t = extractBodyText(part);
      if (t) return t;
    }
  }
  // Fall back to html-stripped if no plain part exists.
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8').replace(/<[^>]+>/g, ' ');
  }
  return '';
}

function detectId(text, subject) {
  const hay = (subject || '') + '\n' + (text || '');
  const fia = FIA_RE.exec(hay);
  if (fia) return fia[0].toUpperCase();
  const issue = ISSUE_RE.exec(hay);
  if (issue) return 'Issue #' + issue[1];
  return null;
}

/**
 * Fetch recent tech-team requests that contain a detectable ID.
 * @param {Object} opts
 * @param {number} [opts.maxResults=20]  how many recent inbox messages to scan
 * @param {string} [opts.query]          Gmail search query (default: unread inbox)
 * @returns {Promise<Array>} parsed requests
 *          { messageId, threadId, from, fromAddress, subject, references, bodyText, detectedId }
 */
async function fetchTechRequests(opts = {}) {
  const client = getGmailClient();
  if (!client) {
    logger.info('[EMAIL-INBOX] Gmail not configured (no readonly token) — returning no requests.');
    return [];
  }
  const allowed = techSenders();
  const maxResults = Math.max(1, Math.min(50, opts.maxResults || 20));
  const query = opts.query || 'in:inbox newer_than:7d';

  let list;
  try {
    const res = await client.users.messages.list({ userId: 'me', q: query, maxResults });
    list = res.data.messages || [];
  } catch (err) {
    logger.warn('[EMAIL-INBOX] list failed: ' + err.message);
    return [];
  }

  const out = [];
  for (const item of list) {
    let msg;
    try {
      const r = await client.users.messages.get({ userId: 'me', id: item.id, format: 'full' });
      msg = r.data;
    } catch (err) {
      logger.warn('[EMAIL-INBOX] get(' + item.id + ') failed: ' + err.message);
      continue;
    }
    const headers = (msg.payload && msg.payload.headers) || [];
    const from = headerVal(headers, 'From');
    const fromAddress = parseAddress(from);
    if (!allowed.has(fromAddress)) continue; // tech-team only — fail closed if roster empty/unreadable

    const subject = headerVal(headers, 'Subject');
    const bodyText = extractBodyText(msg.payload);
    const detectedId = detectId(bodyText, subject);
    if (!detectedId) continue; // no ID to answer — ignore

    out.push({
      messageId: msg.id,
      threadId: msg.threadId,
      from,
      fromAddress,
      subject,
      references: headerVal(headers, 'Message-ID') || null,
      bodyText,
      detectedId,
    });
  }
  logger.info('[EMAIL-INBOX] Scanned ' + list.length + ' messages — ' + out.length + ' tech request(s) with an ID.');
  return out;
}

module.exports = { fetchTechRequests, isEnabled, detectId, getGmailClient, _internals: { parseAddress, extractBodyText, techSenders } };

/**
 * requestStore.js — JSON store for FRAKA's email-reply requests (Engine 9 Leg 1).
 *
 * Mirrors fraka/proposalsStore.js. Each record tracks one tech-team email that
 * asked for the details of a run/issue ID. Records are de-duped by Gmail
 * messageId so FRAKA never replies to the same email twice.
 *
 * Store file: state/fraka/emailRequests.json  (an array of records)
 *
 * Record shape:
 *   {
 *     id,            // EMReq-<base36>-<rand>
 *     messageId,     // Gmail message id (dedupe key)
 *     threadId,      // Gmail thread id (for threaded replies)
 *     from,          // sender address
 *     subject,       // original subject
 *     references,    // original RFC Message-ID header (for In-Reply-To/References)
 *     detectedId,    // FIA-XXXXXXXX-XXXX runId, or "Issue #N" (normalised)
 *     status,        // pending | drafted | sent | skipped | failed
 *     skipReason,    // why it was skipped (no ID / no data / unknown sender)
 *     draft: { subject, bodyHtml, attachments: [{ path, filename, contentType, bytes }] },
 *     createdAt, draftedAt, sentAt, error
 *   }
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const STORE_DIR = path.join(__dirname, '..', '..', 'state', 'fraka');
const STORE_PATH = path.join(STORE_DIR, 'emailRequests.json');

function _load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch { return []; }
}

function _save(list) {
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2));
  } catch (err) {
    logger.error('[EMAIL-REQ] save failed: ' + err.message);
  }
}

function _nextId() {
  return 'EMReq-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function listRequests(filter = {}) {
  let list = _load();
  if (filter.status) list = list.filter(r => r.status === filter.status);
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return list;
}

function getRequest(id) {
  return _load().find(r => r.id === id) || null;
}

function findByMessageId(messageId) {
  return _load().find(r => r.messageId === messageId) || null;
}

/**
 * Create a new request record. Returns the existing record if the messageId was
 * already seen (idempotent — protects against double-replies).
 */
function createRequest(rec) {
  const list = _load();
  if (rec.messageId) {
    const existing = list.find(r => r.messageId === rec.messageId);
    if (existing) return existing;
  }
  const r = {
    id: _nextId(),
    messageId: rec.messageId || null,
    threadId: rec.threadId || null,
    from: rec.from || '',
    subject: rec.subject || '',
    references: rec.references || null,
    detectedId: rec.detectedId || null,
    status: rec.status || 'pending',
    skipReason: rec.skipReason || null,
    draft: rec.draft || null,
    createdAt: new Date().toISOString(),
    draftedAt: null,
    sentAt: null,
    error: null,
  };
  list.push(r);
  _save(list);
  logger.info('[EMAIL-REQ] Created ' + r.id + ' (' + (r.detectedId || 'no-id') + ', status=' + r.status + ')');
  return r;
}

function updateRequest(id, updates) {
  const list = _load();
  const idx = list.findIndex(r => r.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...updates };
  _save(list);
  return list[idx];
}

module.exports = {
  listRequests,
  getRequest,
  findByMessageId,
  createRequest,
  updateRequest,
  STORE_PATH,
};

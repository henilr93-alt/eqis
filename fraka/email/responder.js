/**
 * responder.js — FRAKA's email-reply orchestrator (Engine 9 Leg 1).
 *
 * Flow:
 *   pollAndDraft()
 *     1. Read the eqis@etrav.in inbox for tech-team replies that mention an ID.
 *     2. For each NEW message (deduped by Gmail messageId):
 *          - collect the run's data + evidence (auditDataCollector)
 *          - build a reply DRAFT (summary + photos + video listed)
 *          - if FRAKA_EMAIL_AUTO_SEND is on → send it now (status 'sent')
 *            else                          → save as 'drafted' for human approval
 *          - no ID / no data → save as 'skipped' (nothing is ever sent)
 *
 *   sendDraft(id)  — send a previously-drafted reply (dashboard Approve button).
 *
 * Safety: master switch FRAKA_EMAIL_REPLY_ENABLED. Auto-send ON by default
 * (CEO 2026-06-23 — this is just info passing to the tech team, no approval needed).
 * Only known tech-team senders with a valid ID + real data ever produce a reply.
 * Set FRAKA_EMAIL_AUTO_SEND=false to fall back to draft-only review.
 */

const path = require('path');
const logger = require('../../utils/logger');
const settings = require('../../config/settings');
const inbox = require('./gmailInbox');
const collector = require('./auditDataCollector');
const replyMailer = require('./replyMailer');
const store = require('./requestStore');

function isEnabled() {
  return String(settings.FRAKA_EMAIL_REPLY_ENABLED || 'false').toLowerCase() === 'true';
}
function isAutoSend() {
  return String(settings.FRAKA_EMAIL_AUTO_SEND || 'false').toLowerCase() === 'true';
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Compose the HTML reply body from the collected summary + evidence note.
function buildDraftBody(collected, skipped) {
  const summaryHtml = '<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;'
    + 'line-height:1.5;white-space:pre-wrap;background:#f5f5f7;border:1px solid #e5e5ea;'
    + 'border-radius:8px;padding:14px 16px;color:#1d1d1f;">' + _esc(collected.summaryText) + '</pre>';

  const ev = collected.evidence || {};
  const attached = [];
  if (ev.screenshotPath) attached.push('Results screenshot');
  if (ev.passengerShotPath) attached.push('Passenger / itinerary screenshot');
  if (ev.recordingPath) attached.push('Full session video (' + path.extname(ev.recordingPath).slice(1).toUpperCase() + ')');

  let evidenceNote = attached.length
    ? '<p style="font-size:13px;color:#1d1d1f;">Attached to this email: <b>' + attached.join('</b>, <b>') + '</b>.</p>'
    : '<p style="font-size:13px;color:#6e6e73;">No screenshots or video are stored for this run.</p>';

  if (skipped && skipped.length) {
    const big = skipped.filter(s => s.reason === 'too_large').map(s => _esc(s.filename));
    if (big.length) {
      evidenceNote += '<p style="font-size:12px;color:#c2410c;">Note: ' + big.join(', ')
        + ' was too large to attach — available on the EQIS dashboard.</p>';
    }
  }

  return [
    '<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1d1d1f;">',
    '<p style="font-size:14px;">Hi,</p>',
    '<p style="font-size:14px;">Here are the full details for <b>' + _esc(collected.runId) + '</b>'
      + (collected.issueNumber ? ' (Issue #' + collected.issueNumber + ')' : '') + ':</p>',
    summaryHtml,
    evidenceNote,
    '<p style="font-size:12px;color:#6e6e73;margin-top:18px;">— EQIS (automated reply, prepared by FRAKA)</p>',
    '</div>',
  ].join('\n');
}

// Turn a collected result into a stored draft object.
function buildDraft(req, collected, skipped) {
  const ev = collected.evidence || {};
  const paths = [ev.screenshotPath, ev.passengerShotPath, ev.recordingPath].filter(Boolean);
  const { attachments } = replyMailer.prepareAttachments(paths);
  return {
    subject: req.subject,
    bodyHtml: buildDraftBody(collected, skipped),
    attachments: attachments.map(a => ({ path: a.path, filename: a.filename, contentType: a.contentType, bytes: a.bytes })),
  };
}

/**
 * Poll the inbox and create drafts (or auto-send) for new tech requests.
 * @returns {Promise<{ scanned, drafted, sent, skipped, records: [] }>}
 */
async function pollAndDraft(opts = {}) {
  if (!isEnabled()) {
    logger.info('[EMAIL-RESPONDER] Disabled (FRAKA_EMAIL_REPLY_ENABLED!=true) — skipping poll.');
    return { scanned: 0, drafted: 0, sent: 0, skipped: 0, records: [], disabled: true };
  }

  let requests = [];
  try {
    requests = await inbox.fetchTechRequests({ maxResults: opts.maxResults || 20, query: opts.query });
  } catch (err) {
    logger.error('[EMAIL-RESPONDER] inbox fetch failed: ' + err.message);
    return { scanned: 0, drafted: 0, sent: 0, skipped: 0, records: [], error: err.message };
  }

  const out = { scanned: requests.length, drafted: 0, sent: 0, skipped: 0, records: [] };

  for (const req of requests) {
    // Dedupe — never act on the same email twice.
    if (store.findByMessageId(req.messageId)) continue;

    const collected = collector.collect(req.detectedId);
    if (!collected.found) {
      const rec = store.createRequest({
        messageId: req.messageId, threadId: req.threadId, from: req.from,
        subject: req.subject, references: req.references, detectedId: req.detectedId,
        status: 'skipped', skipReason: collected.reason,
      });
      out.skipped++; out.records.push(rec);
      continue;
    }

    const { skipped } = replyMailer.prepareAttachments(
      [collected.evidence.screenshotPath, collected.evidence.passengerShotPath, collected.evidence.recordingPath].filter(Boolean)
    );
    const draft = buildDraft(req, collected, skipped);

    let rec = store.createRequest({
      messageId: req.messageId, threadId: req.threadId, from: req.from,
      subject: req.subject, references: req.references, detectedId: collected.runId,
      status: 'drafted', draft,
    });
    rec = store.updateRequest(rec.id, { draftedAt: new Date().toISOString() });
    out.drafted++;

    if (isAutoSend()) {
      const sentRec = await sendDraft(rec.id);
      if (sentRec && sentRec.status === 'sent') out.sent++;
      out.records.push(sentRec || rec);
    } else {
      out.records.push(rec);
    }
  }

  logger.info('[EMAIL-RESPONDER] Poll done — scanned ' + out.scanned + ', drafted ' + out.drafted
    + ', sent ' + out.sent + ', skipped ' + out.skipped + '.');
  return out;
}

/**
 * Send a drafted reply (dashboard Approve & Send, or auto-send path).
 * @param {string} id  request id
 */
async function sendDraft(id) {
  const rec = store.getRequest(id);
  if (!rec) { logger.warn('[EMAIL-RESPONDER] sendDraft: ' + id + ' not found'); return null; }
  if (rec.status === 'sent') return rec;
  if (!rec.draft) return store.updateRequest(id, { status: 'failed', error: 'No draft to send' });

  const result = await replyMailer.sendReply({
    to: rec.from,
    subject: rec.draft.subject,
    html: rec.draft.bodyHtml,
    threadId: rec.threadId,
    inReplyTo: rec.references,
    attachments: (rec.draft.attachments || []).map(a => ({
      path: a.path, filename: a.filename, contentType: a.contentType, bytes: a.bytes,
    })),
  });

  if (result.ok) {
    return store.updateRequest(id, { status: 'sent', sentAt: new Date().toISOString(), error: null });
  }
  return store.updateRequest(id, { status: 'failed', error: result.error || 'send failed' });
}

function skipDraft(id, reason) {
  const rec = store.getRequest(id);
  if (!rec) return null;
  return store.updateRequest(id, { status: 'skipped', skipReason: reason || 'Skipped by operator' });
}

module.exports = { pollAndDraft, sendDraft, skipDraft, isEnabled, isAutoSend, buildDraftBody };

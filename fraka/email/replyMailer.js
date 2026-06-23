/**
 * replyMailer.js — send a THREADED Gmail reply WITH attachments.
 *
 * The daily-digest mailer (utils/mailer.js) is send-only with no attachments and
 * no threading, so this is a separate, isolated sender for the FRAKA email-reply
 * leg. It does NOT modify utils/mailer.js — it reuses:
 *   - the same OAuth Gmail client (via fraka/email/gmailInbox.getGmailClient)
 *   - mailer._internals.base64Url for the raw-message encoding
 *
 * It builds a multipart/mixed RFC-2822 message (HTML body + PNG/MP4 parts), sets
 * In-Reply-To + References to the original Message-ID, and passes threadId to
 * gmail.users.messages.send so the reply lands in the same conversation.
 *
 * Attachments over MAX_ATTACH_BYTES are skipped (Gmail caps ~25 MB); the caller
 * can note the skip in the body instead.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const mailer = require('../../utils/mailer');
const { getGmailClient } = require('./gmailInbox');

const DEFAULT_FROM = process.env.EQIS_MAILER_FROM || 'EQIS <eqis@etrav.in>';
const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // 20 MB safety margin under Gmail's 25 MB

function _ext(p) { return path.extname(p || '').toLowerCase(); }
function _contentType(p) {
  switch (_ext(p)) {
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    default: return 'application/octet-stream';
  }
}

// Split base64 into 76-char MIME lines.
function _chunk76(b64) {
  return b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

/**
 * Build attachment descriptors from file paths, skipping missing / oversized files.
 * @returns {{ attachments: Array, skipped: Array }}
 */
function prepareAttachments(filePaths) {
  const attachments = [];
  const skipped = [];
  for (const fp of (filePaths || [])) {
    if (!fp) continue;
    if (!fs.existsSync(fp)) { skipped.push({ path: fp, reason: 'missing' }); continue; }
    const bytes = fs.statSync(fp).size;
    if (bytes > MAX_ATTACH_BYTES) { skipped.push({ path: fp, filename: path.basename(fp), bytes, reason: 'too_large' }); continue; }
    attachments.push({ path: fp, filename: path.basename(fp), contentType: _contentType(fp), bytes });
  }
  return { attachments, skipped };
}

function buildRawReply({ from, to, subject, html, inReplyTo, attachments }) {
  const boundary = '----=_eqisreply_' + Date.now().toString(36);
  const recipients = Array.isArray(to) ? to.join(', ') : to;
  const replySubject = /^re:/i.test(subject) ? subject : ('Re: ' + subject);
  const encodedSubject = /[^\x00-\x7F]/.test(replySubject)
    ? '=?UTF-8?B?' + Buffer.from(replySubject, 'utf-8').toString('base64') + '?='
    : replySubject;

  const lines = [
    'From: ' + from,
    'To: ' + recipients,
    'Subject: ' + encodedSubject,
  ];
  if (inReplyTo) {
    lines.push('In-Reply-To: ' + inReplyTo);
    lines.push('References: ' + inReplyTo);
  }
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
  lines.push('');
  // HTML body part
  lines.push('--' + boundary);
  lines.push('Content-Type: text/html; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: 7bit');
  lines.push('');
  lines.push(html);
  lines.push('');
  // Attachment parts
  for (const a of (attachments || [])) {
    const data = fs.readFileSync(a.path).toString('base64');
    lines.push('--' + boundary);
    lines.push('Content-Type: ' + a.contentType + '; name="' + a.filename + '"');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('Content-Disposition: attachment; filename="' + a.filename + '"');
    lines.push('');
    lines.push(_chunk76(data));
    lines.push('');
  }
  lines.push('--' + boundary + '--');
  lines.push('');
  return lines.join('\r\n');
}

/**
 * Send a threaded reply with attachments.
 * @param {Object} opts
 * @param {string|string[]} opts.to
 * @param {string} opts.subject       original subject (Re: is prepended if absent)
 * @param {string} opts.html
 * @param {string} [opts.threadId]    Gmail thread id of the original message
 * @param {string} [opts.inReplyTo]   original RFC Message-ID header
 * @param {Array}  [opts.attachments] descriptors from prepareAttachments()
 * @param {string} [opts.from]
 * @returns {Promise<{ ok, dryRun, messageId, error }>}
 */
async function sendReply(opts) {
  const from = opts.from || DEFAULT_FROM;
  const to = Array.isArray(opts.to) ? opts.to : [opts.to];
  const cleanTo = to.filter(r => r && typeof r === 'string' && /\S+@\S+\.\S+/.test(r));
  if (cleanTo.length === 0) return { ok: false, dryRun: false, messageId: null, error: 'No valid recipients' };

  const client = getGmailClient();
  if (!client) {
    logger.info('[EMAIL-REPLY] DRY-RUN — would reply "' + opts.subject + '" to ' + cleanTo.join(', ')
      + ' with ' + (opts.attachments || []).length + ' attachment(s).');
    return { ok: true, dryRun: true, messageId: null, error: null };
  }

  try {
    const raw = buildRawReply({
      from, to: cleanTo, subject: opts.subject, html: opts.html,
      inReplyTo: opts.inReplyTo, attachments: opts.attachments,
    });
    const requestBody = { raw: mailer._internals.base64Url(raw) };
    if (opts.threadId) requestBody.threadId = opts.threadId;
    const res = await client.users.messages.send({ userId: 'me', requestBody });
    logger.info('[EMAIL-REPLY] Sent reply to ' + cleanTo.join(', ') + ' (id=' + res.data.id + ', thread=' + (opts.threadId || 'new') + ')');
    return { ok: true, dryRun: false, messageId: res.data.id, error: null };
  } catch (err) {
    logger.warn('[EMAIL-REPLY] Send failed: ' + err.message);
    return { ok: false, dryRun: false, messageId: null, error: err.message };
  }
}

module.exports = { sendReply, prepareAttachments, buildRawReply, MAX_ATTACH_BYTES };

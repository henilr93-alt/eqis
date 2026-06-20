/**
 * emailHistory.js — Tiny store for the daily-digest send log.
 *
 * Backing file: state/emailHistory.json
 * Schema:
 *   {
 *     sends: [
 *       {
 *         id: "send-<timestamp>-<rand>",
 *         teamId: "marketing",
 *         teamName: "Marketing Team",
 *         reportType: "ecd_promote_digest",
 *         sentAt: "2026-06-10T03:30:00Z",
 *         status: "OK" | "DRY_RUN" | "SUPPRESSED" | "FAILED",
 *         suppressionReason: "ecdBrokenCount=3" | null,
 *         recipients: ["marketing@etrav.in"],
 *         subject: "EQIS · Marketing — ...",
 *         summaryLine: "10 promote · ₹1,17,064 total savings",
 *         recordCount: 10,
 *         messageId: "gmail-msg-id" | null,
 *         dryRun: true | false,
 *         error: string | null
 *       },
 *       ...
 *     ]
 *   }
 *
 * Trims to last 500 entries to keep the file bounded.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'state', 'emailHistory.json');
const MAX_ENTRIES = 500;

function read() {
  try {
    if (!fs.existsSync(FILE)) return { sends: [] };
    const data = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    if (!data || !Array.isArray(data.sends)) return { sends: [] };
    return data;
  } catch {
    return { sends: [] };
  }
}

function _write(data) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch { /* ignore */ }
}

function append(entry) {
  const cur = read();
  const id = 'send-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const enriched = { id, sentAt: new Date().toISOString(), ...entry };
  cur.sends.unshift(enriched); // newest first
  if (cur.sends.length > MAX_ENTRIES) cur.sends.length = MAX_ENTRIES;
  _write(cur);
  return enriched;
}

function recent(limit) {
  const cur = read();
  return cur.sends.slice(0, Math.max(1, Number(limit || 50)));
}

/**
 * Was a digest of this type sent successfully to this team in the last N hours?
 * Used to dedupe — don't send the same digest twice on the same day.
 */
function wasSentRecently(teamId, reportType, hoursAgo) {
  const h = Number(hoursAgo || 20); // default 20h dedupe window (avoids same-day double-send)
  const cutoff = Date.now() - (h * 60 * 60 * 1000);
  return read().sends.some(s =>
    s.teamId === teamId
    && s.reportType === reportType
    && (s.status === 'OK' || s.status === 'DRY_RUN')
    && new Date(s.sentAt).getTime() >= cutoff);
}

module.exports = { read, append, recent, wasSentRecently };

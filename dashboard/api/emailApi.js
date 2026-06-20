/**
 * emailApi.js — Dashboard endpoints for the daily-digest emailer.
 *
 * Endpoints (all mounted from dashboard/server.js):
 *
 *   GET  /api/email/status        → { enabled, from, registered, lastSendAt }
 *   GET  /api/email/roster        → { teams: [...], _meta }
 *   POST /api/email/roster        → body { teams: [...] }    saves the roster
 *   GET  /api/email/history       → { sends: [last 50] }
 *   POST /api/email/send-test     → body { teamId, reportType, recipientOverride? }
 *                                    forces a send (bypasses dedupe & gate)
 *   POST /api/email/run-now       → triggers the full 9am pipeline immediately
 *
 * Roster writes are validated minimally: each team must have id, name,
 * emails (array of valid-looking strings), and reports (array of known
 * report ids).
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const mailer = require('../../utils/mailer');
const sched  = require('../../utils/dailyDigestScheduler');
const emailHistory = require('../../utils/emailHistory');

const ROSTER_FILE = path.join(__dirname, '..', '..', 'state', 'emailRoster.json');
const VALID_REPORTS = new Set(['searchpulse_digest', 'ecd_promote_digest', 'ecd_renegotiate_digest']);

function statusApi(req, res) {
  const recent = emailHistory.recent(1);
  res.json({
    enabled: mailer.isEnabled(),
    mode: mailer.isEnabled() ? 'LIVE' : 'DRY_RUN',
    from: process.env.EQIS_MAILER_FROM || 'EQIS <eqis@etrav.in>',
    sendTimeIST: '09:00',
    lastSendAt: recent.length > 0 ? recent[0].sentAt : null,
    setupHint: mailer.isEnabled() ? null : 'To enable LIVE sending, configure GMAIL_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN env vars or place state/gmail-oauth-client.json + state/gmail-oauth-token.json on disk.',
  });
}

function getRosterApi(req, res) {
  res.json(sched.readRoster());
}

function postRosterApi(req, res) {
  const body = req.body || {};
  const teams = Array.isArray(body.teams) ? body.teams : null;
  if (!teams) return res.status(400).json({ error: 'Body must contain a `teams` array' });

  // Validate
  const cleaned = [];
  for (const t of teams) {
    if (!t || typeof t !== 'object') continue;
    if (!t.id || typeof t.id !== 'string') return res.status(400).json({ error: 'Each team needs an `id` string' });
    if (!t.name || typeof t.name !== 'string') return res.status(400).json({ error: 'Each team needs a `name` string' });
    const emails = Array.isArray(t.emails) ? t.emails.filter(e => typeof e === 'string' && /\S+@\S+\.\S+/.test(e)) : [];
    const reports = Array.isArray(t.reports) ? t.reports.filter(r => VALID_REPORTS.has(r)) : [];
    cleaned.push({
      id: t.id,
      name: t.name,
      enabled: t.enabled !== false,
      emails,
      reports,
      notes: typeof t.notes === 'string' ? t.notes : '',
    });
  }

  const next = {
    _meta: {
      description: 'Daily-digest mailing roster. Each team gets ONE consolidated email at 9am IST per day, containing the reports listed in `reports`. Edit recipients via the dashboard Notifications tab.',
      sendTimeIST: '09:00',
      updatedAt: new Date().toISOString(),
    },
    teams: cleaned,
  };
  try {
    fs.writeFileSync(ROSTER_FILE, JSON.stringify(next, null, 2));
    logger.info('[EMAIL-API] Roster updated — ' + cleaned.length + ' teams (' + cleaned.reduce((a, t) => a + t.emails.length, 0) + ' total recipients)');
    res.json({ ok: true, teams: cleaned.length, recipients: cleaned.reduce((a, t) => a + t.emails.length, 0) });
  } catch (err) {
    logger.error('[EMAIL-API] Roster save failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

function historyApi(req, res) {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50));
  res.json({ sends: emailHistory.recent(limit) });
}

async function sendTestApi(req, res) {
  const body = req.body || {};
  const teamId = body.teamId;
  const reportType = body.reportType;
  if (!teamId || !reportType) return res.status(400).json({ error: 'Body needs { teamId, reportType }' });
  if (!VALID_REPORTS.has(reportType)) return res.status(400).json({ error: 'Unknown reportType — must be one of ' + Array.from(VALID_REPORTS).join(', ') });

  const roster = sched.readRoster();
  let team = roster.teams.find(t => t.id === teamId);
  if (!team) return res.status(404).json({ error: 'Team not found in roster' });

  // Optional recipient override (for "send to me as a preview" use case)
  if (body.recipientOverride && typeof body.recipientOverride === 'string') {
    team = { ...team, emails: [body.recipientOverride] };
  }

  try {
    const entry = await sched.runForTeamReport(team, reportType, { force: true });
    res.json({ ok: true, entry });
  } catch (err) {
    logger.error('[EMAIL-API] send-test failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

// Human-readable labels + send conditions per report type. Mirrors the
// quality gates in utils/dailyDigestScheduler.js so the dashboard can tell
// the operator WHY a given digest might not go out on a low-data day.
const REPORT_LABELS = {
  searchpulse_digest:     'SearchPulse SPF digest',
  ecd_promote_digest:     'ECD Promote (good pricing)',
  ecd_renegotiate_digest: 'ECD Renegotiate (bad pricing)',
};
const REPORT_CONDITIONS = {
  searchpulse_digest:     'Sent when ≥1 SearchPulse search ran in the window',
  ecd_promote_digest:     'Sent when the latest ECD cycle is healthy and ≥1 ECD-cheaper hotel was found',
  ecd_renegotiate_digest: 'Sent when the latest ECD cycle is healthy and ≥3 hotels need renegotiation',
};

/**
 * GET /api/email/schedule
 * Derived view of every scheduled email: which digest goes to which
 * recipients, when, how often, the send condition, and the most recent
 * outcome for that team+report pairing. Read-only.
 */
function scheduleApi(req, res) {
  const roster = sched.readRoster();
  const sends = emailHistory.read().sends || [];
  const sendTimeIST = (roster._meta && roster._meta.sendTimeIST) || '09:00';

  const schedules = [];
  for (const t of (roster.teams || [])) {
    for (const rt of (t.reports || [])) {
      const last = sends.find(s => s.teamId === t.id && s.reportType === rt);
      schedules.push({
        teamId: t.id,
        teamName: t.name,
        enabled: t.enabled !== false,
        reportType: rt,
        reportLabel: REPORT_LABELS[rt] || rt,
        recipients: Array.isArray(t.emails) ? t.emails : [],
        whenIST: sendTimeIST,
        frequency: 'Daily',
        condition: REPORT_CONDITIONS[rt] || '',
        lastSentAt: last ? last.sentAt : null,
        lastStatus: last ? last.status : null,
        lastReason: last ? (last.suppressionReason || last.error || null) : null,
      });
    }
  }

  res.json({
    sendTimeIST,
    timezone: 'Asia/Kolkata',
    cadence: 'Daily at ' + sendTimeIST + ' IST · hourly catch-up until each team is delivered for the day',
    mode: mailer.isEnabled() ? 'LIVE' : 'DRY_RUN',
    totalScheduled: schedules.length,
    schedules,
  });
}

async function runNowApi(req, res) {
  try {
    const results = await sched.runOnce({ force: true });
    res.json({ ok: true, attempts: results.length, results });
  } catch (err) {
    logger.error('[EMAIL-API] run-now failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  statusApi,
  getRosterApi,
  postRosterApi,
  historyApi,
  scheduleApi,
  sendTestApi,
  runNowApi,
};

/**
 * auditDataCollector.js — given an ID from a tech-team email, gather everything
 * EQIS has for that run: the search/review details (as a readable summary) plus
 * the evidence files (2 screenshots + 1 video).
 *
 * Data source = Engine 9 Flight INTL Audit (the only engine that stores photos +
 * a video per run). Logic mirrors dashboard/api/flightIntlAuditApi.js
 * (_findRowByRunId scans 14 IST days of AUDIT-<date>.json; evidence path
 * templates under reports/flight-intl-audit/). Those helpers are not exported,
 * so the proven lookup is replicated here (read-only, no shared state).
 *
 * Accepted IDs:
 *   - FIA-XXXXXXXX-XXXX  → looked up directly
 *   - "Issue #N"         → mapped to a runId via state/auditEscalations.json
 *
 * Returns:
 *   { found, runId, issueNumber, row, summaryText,
 *     evidence: { screenshotPath, passengerShotPath, recordingPath } }
 * Evidence paths are only included when the file actually exists on disk.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const { TZ } = require('../../utils/timezone');

const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports', 'flight-intl-audit');
const ESCALATIONS_FILE = path.join(__dirname, '..', '..', 'state', 'auditEscalations.json');

function _istDay(offset) {
  const d = new Date();
  if (offset) d.setTime(d.getTime() + offset * 86400000);
  return d.toLocaleString('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).slice(0, 10);
}

function _loadDay(dateIso) {
  try {
    const p = path.join(REPORTS_DIR, 'AUDIT-' + dateIso + '.json');
    if (!fs.existsSync(p)) return { rows: [] };
    return JSON.parse(fs.readFileSync(p, 'utf-8')) || { rows: [] };
  } catch (e) {
    logger.warn('[EMAIL-DATA] read ' + dateIso + ' failed: ' + e.message);
    return { rows: [] };
  }
}

// Scan up to 14 IST days for a row with this runId (matches flightIntlAuditApi).
function findRowByRunId(runId) {
  if (!runId || !/^[A-Z0-9-]+$/i.test(runId)) return null;
  for (let i = 0; i < 14; i++) {
    const day = _loadDay(_istDay(-i));
    const hit = (day.rows || []).find(r => r && r.runId === runId);
    if (hit) return hit;
  }
  return null;
}

// "Issue #N" → runId, via the escalation log that the CMT escalator writes.
function runIdForIssue(issueNumber) {
  try {
    const data = JSON.parse(fs.readFileSync(ESCALATIONS_FILE, 'utf-8'));
    const hit = (data.escalations || []).find(e => Number(e.issueNumber) === Number(issueNumber));
    return hit ? hit.runId : null;
  } catch (e) {
    logger.warn('[EMAIL-DATA] escalations read failed: ' + e.message);
    return null;
  }
}

// Normalise the raw detectedId into { runId, issueNumber }.
function resolveId(detectedId) {
  if (!detectedId) return { runId: null, issueNumber: null };
  const issue = /Issue\s*#\s*(\d+)/i.exec(detectedId);
  if (issue) {
    const n = Number(issue[1]);
    return { runId: runIdForIssue(n), issueNumber: n };
  }
  const fia = /FIA-[A-Z0-9]{8}-[A-Z0-9]{4}/i.exec(detectedId);
  if (fia) return { runId: fia[0].toUpperCase(), issueNumber: null };
  return { runId: null, issueNumber: null };
}

function _line(label, value) {
  return value == null || value === '' ? null : label + ': ' + value;
}

// Build the readable search + review summary (same fields the CMT ticket uses).
function buildSummary(row, runId) {
  const search = row.search || {};
  const review = row.review || {};
  const target = row.target || review.target || {};
  const metrics = review.metrics || row.metrics || {};
  const startedHuman = row.startedAt
    ? new Date(row.startedAt).toLocaleString('en-IN', { timeZone: TZ, hour12: false }) + ' IST'
    : '—';
  const fmtMs = (ms) => (ms == null ? null : ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s');

  const lines = [
    '=== EQIS Flight INTL Audit — Run ' + runId + ' ===',
    '',
    '--- SEARCH DETAILS ---',
    _line('Sector', row.sector),
    _line('Run time', startedHuman),
    _line('Passengers', row.paxCount),
    _line('Cabin Class', row.cabinClass),
    _line('Trip Type', row.tripType),
    _line('Round-Trip Fare', row.roundTripFareChecked == null ? null : (row.roundTripFareChecked ? 'TICKED (combined RT fare)' : 'UNTICKED (two one-way legs)')),
    _line('Search Date', row.searchDate),
    _line('Search Status', search.status || row.searchStatus),
    _line('Search Duration', fmtMs(search.loadTimeMs)),
    _line('Results Found', search.resultCount),
    _line('Airlines Shown', search.airlineCount),
    _line('Search URL', search.searchUrl),
    _line('Failure Reason', search.failureReason || row.failureReason),
    '',
    '--- REVIEW DETAILS ---',
    _line('Verdict', row.verdict || review.verdict),
    _line('Severity', row.severity || review.severity),
    _line('Flight Picked', target && (target.airlineCode || target.flightNumber) ? [target.airlineCode, target.flightNumber, target.fareType, target.price ? '₹' + target.price : ''].filter(Boolean).join(' ') : null),
    _line('Review Load Time', fmtMs(metrics.loadMs)),
  ].filter(Boolean);

  return lines.join('\n');
}

/**
 * Collect data + evidence for a detected ID.
 * @param {string} detectedId  "FIA-..." or "Issue #N"
 */
function collect(detectedId) {
  const { runId, issueNumber } = resolveId(detectedId);
  if (!runId) {
    return { found: false, runId: null, issueNumber, row: null, summaryText: null, evidence: {}, reason: 'Could not resolve "' + detectedId + '" to a run id.' };
  }

  const row = findRowByRunId(runId);
  if (!row) {
    return { found: false, runId, issueNumber, row: null, summaryText: null, evidence: {}, reason: 'No audit row found for ' + runId + ' (older than 14 days or never recorded).' };
  }

  const shot = path.join(REPORTS_DIR, 'screenshots', 'audit-' + runId + '.png');
  const pax = path.join(REPORTS_DIR, 'screenshots', 'audit-' + runId + '-passenger.png');
  const mp4 = path.join(REPORTS_DIR, 'recordings', 'audit-' + runId + '.mp4');
  const webm = path.join(REPORTS_DIR, 'recordings', 'audit-' + runId + '.webm');

  const evidence = {};
  if (fs.existsSync(shot)) evidence.screenshotPath = shot;
  if (fs.existsSync(pax)) evidence.passengerShotPath = pax;
  if (fs.existsSync(mp4)) evidence.recordingPath = mp4;
  else if (fs.existsSync(webm)) evidence.recordingPath = webm;

  return {
    found: true,
    runId,
    issueNumber,
    row,
    summaryText: buildSummary(row, runId),
    evidence,
    reason: null,
  };
}

module.exports = { collect, resolveId, findRowByRunId, runIdForIssue, buildSummary };

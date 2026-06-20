/**
 * dailyDigestScheduler.js — runs once per day at 9am IST and sends each
 * roster team their subscribed daily-digest emails.
 *
 * Pipeline per team:
 *   1. Resolve which reports the team is subscribed to (from state/emailRoster.json)
 *   2. For each report:
 *      a. Gather the underlying data (latest ECD report, SearchPulse SPF matrix)
 *      b. Run the quality gate — skip if data is broken/missing
 *      c. Render the email via emailTemplates
 *      d. Send via mailer.send (DRY-RUN when no OAuth configured)
 *      e. Record outcome to emailHistory
 *
 * Boot integration: call `register()` once at EQIS boot. It schedules the
 * cron + exposes runOnce() / runForTeam() for manual triggering via the
 * dashboard API.
 *
 * Quality-gate philosophy: silence is better than spam. If we'd send a
 * digest that says "0 hotels" or "data was broken", suppress it instead
 * and write an explanatory entry to emailHistory so the operator can see
 * the suppression on the dashboard.
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const logger = require('./logger');
const settings = require('../config/settings');
const mailer = require('./mailer');
const templates = require('./emailTemplates');
const emailHistory = require('./emailHistory');
const supplierHealth = require('./supplierHealth');
const ecdLiveProgress = require('./ecdLiveProgress');

const ROSTER_FILE = path.join(__dirname, '..', 'state', 'emailRoster.json');
const ECD_REPORTS_DIR = path.join(__dirname, '..', 'reports', 'ecd');

// All known report types and which template / data source they use.
const REPORT_REGISTRY = {
  searchpulse_digest: {
    label: 'SearchPulse SPF digest',
    gather: gatherSpfData,
    render: templates.renderTechDigest,
    gate:   spfQualityGate,
  },
  ecd_promote_digest: {
    label: 'ECD Promote digest',
    gather: gatherEcdData,
    render: templates.renderMarketingDigest,
    gate:   ecdPromoteQualityGate,
  },
  ecd_renegotiate_digest: {
    label: 'ECD Renegotiate digest',
    gather: gatherEcdData,
    render: templates.renderContractingDigest,
    gate:   ecdRenegotiateQualityGate,
  },
};

/* ─────────────────────────── Roster loader ─────────────────────────── */

function readRoster() {
  try {
    if (!fs.existsSync(ROSTER_FILE)) return { teams: [] };
    const data = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf-8'));
    if (!data || !Array.isArray(data.teams)) return { teams: [] };
    return data;
  } catch (err) {
    logger.warn('[DIGEST] Failed to read roster: ' + err.message);
    return { teams: [] };
  }
}

/* ─────────────────────── Data gatherers (read-only) ────────────────── */

/**
 * Latest ECD comparison data — prefers the freshest finished report from
 * reports/ecd/ over the in-flight ecdLiveProgress (since the live progress
 * may be partially populated mid-cycle).
 */
function gatherEcdData() {
  let report = null;
  let source = null;
  // 1) Prefer the most-recent finished JSON report
  try {
    if (fs.existsSync(ECD_REPORTS_DIR)) {
      const files = fs.readdirSync(ECD_REPORTS_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();
      for (const f of files) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(ECD_REPORTS_DIR, f), 'utf-8'));
          const hotels = r.hotelComparisons || r.comparisons || [];
          if (hotels.length > 0) {
            report = r;
            source = 'reports/ecd/' + f;
            break;
          }
        } catch { /* keep looking */ }
      }
    }
  } catch { /* fall through */ }

  // 2) Fall back to live progress
  if (!report) {
    const live = ecdLiveProgress.read();
    if (live && Array.isArray(live.hotelComparisons) && live.hotelComparisons.length > 0) {
      report = live;
      source = 'state/ecdLiveProgress.json';
    }
  }

  if (!report) return { hotels: [], runId: null, summary: null, source: null };
  return {
    hotels: report.hotelComparisons || [],
    runId: report.runId || null,
    summary: report.summary || null,
    source,
  };
}

/**
 * SearchPulse v2 digest data — parses today's log file for per-engine
 * performance (success/failure/avg/P95 duration), failure details with
 * reproduce URLs, and yesterday's avg for trend comparison.
 *
 * Per-engine SLA targets ("perfect timeline" the team is working toward):
 *   Flight Domestic      < 15s
 *   Flight International < 25s   (longer due to multi-airline result aggregation)
 *   Hotel Domestic       < 20s
 *   Hotel International  < 25s
 */
const SP_ENGINES = {
  'flight-dom':  { name: 'Flight Domestic',      slaMs: 15000 },
  'flight-intl': { name: 'Flight International', slaMs: 25000 },
  'hotel-dom':   { name: 'Hotel Domestic',       slaMs: 20000 },
  'hotel-intl':  { name: 'Hotel International',  slaMs: 25000 },
};

// 2026-06-11: CEO directive — SPF + AUTOMATION_* statuses are EQIS-side
// automation bugs (FRAKA's responsibility), NOT Etrav-side issues. They
// must NOT appear in the tech-team digest's failure list. They DO still
// appear in the per-engine pie chart (purple slice) for full transparency,
// but the actionable Etrav-side issues list is filtered to FAILURE,
// HEALTH_CHECK_FAILED, ETRAV_FORM_CRASH, AUTOSUGGEST_DOWN, ZERO_RESULTS, etc.
const EQIS_SIDE_STATUSES = new Set([
  'SPF',
  'AUTOMATION_DATE_INCOMPLETE',
  'AUTOMATION_FIELD_INCOMPLETE',
  'AUTOMATION_FORM_RESET',
]);
function _isEqisSide(status) { return EQIS_SIDE_STATUSES.has(String(status || '').toUpperCase()); }
function _isEtravSide(status) { return status && !_isEqisSide(status) && status !== 'SUCCESS'; }

function _isoDayOffset(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().split('T')[0];
}

function _scenarioToEngine(scenario, type) {
  const fallback = type === 'Flight' ? 'flight-dom' : 'hotel-dom';
  if (!scenario) return fallback;
  const u = scenario.toUpperCase();
  if (u.startsWith('HTL-L2B-DOM')  || u.startsWith('HTL-DOM'))  return 'hotel-dom';
  if (u.startsWith('HTL-L2B-INTL') || u.startsWith('HTL-INTL')) return 'hotel-intl';
  if (u.startsWith('L2B-DOM')      || u.startsWith('DOM'))      return 'flight-dom';
  if (u.startsWith('L2B-INTL')     || u.startsWith('INTL'))     return 'flight-intl';
  return fallback;
}

function _reproduceUrl(type, route) {
  if (type === 'Flight') {
    const m = String(route || '').match(/([A-Z]{3})\s*->?\s*([A-Z]{3})/);
    return 'https://new.etrav.in/flights' + (m ? '?from=' + m[1] + '&to=' + m[2] : '');
  }
  return 'https://new.etrav.in/hotels?destination=' + encodeURIComponent(String(route || '').trim());
}

function _parseSearchPulseLog(filePath) {
  const stats = {};
  Object.keys(SP_ENGINES).forEach(e => { stats[e] = { total: 0, success: 0, spf: 0, etravIssues: 0, eqisBugs: 0, durations: [], slaMet: 0, failures: [], qPerfect: 0, qMedian: 0, qDelay: 0 }; });
  if (!fs.existsSync(filePath)) return stats;
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return stats; }
  const lines = content.split('\n');

  let pendingScenario = null;
  let pendingShotPath = null;
  for (const line of lines) {
    // Track the most recent screenshot line — its scenario ID drives engine attribution.
    // Note: paths may contain spaces, so we anchor to ".png" instead of \S+.
    const shot = line.match(/\[SCREENSHOT\]\s+(?:flight|hotel)-pulse-(\S+?)\s+saved\s+to\s+(.+?\.png)\b/);
    if (shot) {
      pendingScenario = shot[1];
      pendingShotPath = shot[2];
      continue;
    }
    // PULSE outcome line: "[2026-06-11T14:35:13] [INFO] [PULSE] Flight DEL->SXR: SUCCESS | 60 results | 8572ms"
    const pulse = line.match(/^\[([^\]]+)\]\s+\[\w+\]\s+\[PULSE\]\s+(Flight|Hotel)\s+([^:]+):\s+(SUCCESS|FAILURE|SPF)(?:\s*\|\s*(\d+)\s+results)?\s*\|\s*(\d+)ms/);
    if (pulse) {
      const [, ts, type, route, status, , durMs] = pulse;
      const engine = _scenarioToEngine(pendingScenario, type);
      if (!stats[engine]) continue;
      const dur = parseInt(durMs, 10) || 0;
      stats[engine].total++;
      stats[engine].durations.push(dur);
      if (status === 'SUCCESS') {
        stats[engine].success++;
        const slaMs = SP_ENGINES[engine].slaMs;
        if (dur <= slaMs) stats[engine].slaMet++;
        // 2026-06-12: quality bucketing for the per-engine pie chart.
        // Perfect = comfortably under SLA; Median = within SLA;
        // Delay = success but breached SLA. Failure bucket comes from etravIssues.
        if (dur <= 0.7 * slaMs) stats[engine].qPerfect++;
        else if (dur <= slaMs)  stats[engine].qMedian++;
        else                    stats[engine].qDelay++;
      } else {
        stats[engine].spf++;
        if (_isEqisSide(status)) stats[engine].eqisBugs++;
        else stats[engine].etravIssues++;
        // Only push to failures (the actionable list) when it's an Etrav-side
        // issue. EQIS automation bugs are FRAKA's responsibility and don't
        // belong in the tech-team digest's failure section.
        if (_isEtravSide(status)) {
          stats[engine].failures.push({
            timestamp: ts,
            engineId: engine,
            engine: SP_ENGINES[engine].name,
            route: route.trim(),
            type,
            errorClass: status,
            error: '',
            screenshot: pendingShotPath,
            reproduceUrl: _reproduceUrl(type, route.trim()),
            durationMs: dur,
          });
        }
      }
      pendingScenario = null;
      pendingShotPath = null;
      continue;
    }
    // Also capture HEALTH CHECK FAILED — Etrav-side (their service didn't load)
    const hcf = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.\-Z]+)\][^[]*\[PULSE\]\s+HEALTH CHECK FAILED:\s+(.+?)(?:\s*Call log|$)/);
    if (hcf) {
      // HCF doesn't tell us which engine — we count it but don't attribute to one
      // Add to flight-dom as a default bucket so it shows up somewhere
      const engine = 'flight-dom';
      stats[engine].total++;
      stats[engine].spf++;
      stats[engine].etravIssues++;
      stats[engine].failures.push({
        timestamp: hcf[1],
        engineId: engine,
        engine: SP_ENGINES[engine].name,
        route: '(health check)',
        type: 'Flight',
        errorClass: 'HEALTH_CHECK_FAILED',
        error: hcf[2].slice(0, 200),
        screenshot: null,
        reproduceUrl: 'https://new.etrav.in/flights',
        durationMs: 0,
      });
    }
  }
  return stats;
}

function _avg(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function _p95(arr) {
  if (!arr || !arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.max(0, Math.floor(0.95 * (s.length - 1)))];
}

// 2026-06-11: read the rolling 48h failure ledger persisted by
// engine3-searchpulse/searchPulseEngine.js writeSearchQualitySignal(). Each
// entry carries the REAL Etrav URL the failing pulse was tracked against,
// captured from page.url() during the live Playwright session. Used to
// replace the synthetic _reproduceUrl() with the actual recorded URL.
function _loadFailureLedger() {
  try {
    const p = path.join(__dirname, '..', 'state', 'searchPulseRecentFailures.json');
    if (!fs.existsSync(p)) return [];
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return (raw && Array.isArray(raw.failures)) ? raw.failures : [];
  } catch (e) {
    logger.warn('[DIGEST] failure ledger load failed: ' + e.message);
    return [];
  }
}

function gatherSpfData() {
  const logDir = path.join(__dirname, '..', 'logs');
  // 2026-06-12: digest now covers the PREVIOUS day (sent at 9am IST about
  // the day before), so the team sees the full closed window and not a
  // half-baked still-running day. Trend comparison uses day-before-previous.
  const todayPath = path.join(logDir, 'eqis-' + _isoDayOffset(-1) + '.log');
  const yestPath  = path.join(logDir, 'eqis-' + _isoDayOffset(-2) + '.log');

  let today, yesterday;
  try { today = _parseSearchPulseLog(todayPath); }
  catch (e) { logger.warn('[DIGEST] previous-day log parse failed: ' + e.message); today = {}; }
  try { yesterday = _parseSearchPulseLog(yestPath); }
  catch (e) { logger.warn('[DIGEST] day-before-previous log parse failed: ' + e.message); yesterday = {}; }

  // 2026-06-11: enrich each engine's failures with the real Etrav URL
  // captured by the ledger. The log gives us route + class + timestamp,
  // but only the ledger has the page.url() snapshot from the live session.
  const ledger = _loadFailureLedger();
  const matchedLedgerIdx = new Set();
  if (ledger.length > 0) {
    for (const eid of Object.keys(today)) {
      const fails = today[eid] && today[eid].failures;
      if (!Array.isArray(fails)) continue;
      for (const f of fails) {
        const target = (f.route || '').toLowerCase().trim();
        if (!target) continue;
        const idx = ledger.findIndex(L => {
          const sect = String(L.sector || L.label || '').toLowerCase();
          if (!sect) return false;
          // Match by direct substring on route, OR by first pipe-separated
          // segment of the sector label (e.g. "DEL→BOM | 3,193 searches").
          if (sect.includes(target)) return true;
          const head = sect.split('|')[0].trim();
          return head && target.includes(head);
        });
        if (idx >= 0) {
          matchedLedgerIdx.add(idx);
          const match = ledger[idx];
          if (match.url) f.reproduceUrl = match.url;
          if (!f.error && match.failureReason) f.error = match.failureReason;
          if (!f.screenshot && match.screenshotPath) f.screenshot = match.screenshotPath;
        }
      }
    }
    // 2026-06-11: also surface unmatched ledger entries from the last 24h as
    // failure rows. Ensures URLs land in the email even if the log parser
    // missed a line, AND lets manually-seeded test entries appear during a
    // dry run when today's log happens to be clean.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    ledger.forEach((L, i) => {
      if (matchedLedgerIdx.has(i)) return;
      const t = new Date(L.timestamp).getTime();
      if (!isFinite(t) || t < cutoff) return;
      // 2026-06-11: prefer ledger.scenarioType ('domestic'/'international')
      // when present, since runtime scenario IDs are random hashes that
      // don't match the L2B-INTL/L2B-DOM prefixes _scenarioToEngine expects.
      let eid = _scenarioToEngine(L.scenarioId, L.engineType === 'hotel' ? 'Hotel' : 'Flight');
      if (L.scenarioType === 'international') {
        eid = L.engineType === 'hotel' ? 'hotel-intl' : 'flight-intl';
      } else if (L.scenarioType === 'domestic') {
        eid = L.engineType === 'hotel' ? 'hotel-dom' : 'flight-dom';
      }
      if (!today[eid]) return;
      const route = L.sector ? String(L.sector).split('|')[0].trim() : (L.label || '\u2014');
      const status = L.status || 'FAILURE';
      // Count toward engine totals regardless (for pie chart accuracy)
      today[eid].total++;
      today[eid].spf++;
      if (_isEqisSide(status)) today[eid].eqisBugs++;
      else today[eid].etravIssues++;
      // Only push to the actionable failure list when Etrav-side. EQIS
      // automation bugs (SPF, AUTOMATION_*) belong to FRAKA, not the tech team.
      if (_isEtravSide(status)) {
        today[eid].failures.push({
          timestamp: L.timestamp,
          engineId: eid,
          engine: SP_ENGINES[eid].name,
          route,
          type: L.engineType === 'hotel' ? 'Hotel' : 'Flight',
          errorClass: status,
          error: L.failureReason || '',
          screenshot: L.screenshotPath || null,
          reproduceUrl: L.url || _reproduceUrl(L.engineType === 'hotel' ? 'Hotel' : 'Flight', route),
          durationMs: L.loadTimeMs || 0,
        });
      }
    });
  }

  // 2026-06-12: Per-engine roll-up — EQIS automation bugs are hidden from
  // the tech team entirely (CEO directive). The visible total = success +
  // etravIssues only. eqisBugs still tracked internally for FRAKA but
  // excluded from headlines, success rate, and pie charts.
  const engines = Object.entries(SP_ENGINES).map(([id, cfg]) => {
    const t = today[id] || { total: 0, success: 0, spf: 0, etravIssues: 0, eqisBugs: 0, durations: [], slaMet: 0, failures: [] };
    const y = yesterday[id] || { durations: [] };
    const avgT = _avg(t.durations);
    const avgY = _avg(y.durations);
    let trend = 'stable';
    if (avgY > 0 && Math.abs(avgT - avgY) > 1000) trend = avgT < avgY ? 'improving' : 'degrading';
    const visibleTotal = t.success + (t.etravIssues || 0); // exclude EQIS bugs
    return {
      id, name: cfg.name, slaMs: cfg.slaMs,
      total: visibleTotal,
      success: t.success,
      spf: t.etravIssues || 0,    // "issues" column shown to tech = Etrav-side only
      etravIssues: t.etravIssues || 0,
      eqisBugs:    t.eqisBugs    || 0,  // kept for internal use, NOT shown
      // 2026-06-12: 4-slice quality split for per-engine pie chart
      qPerfect: t.qPerfect || 0,
      qMedian:  t.qMedian  || 0,
      qDelay:   t.qDelay   || 0,
      qFailure: t.etravIssues || 0,
      successRate: visibleTotal ? (t.success / visibleTotal) * 100 : 0,
      avgDurationMs: avgT,
      p95DurationMs: _p95(t.durations),
      yesterdayAvgMs: avgY,
      trend,
      slaCompliancePct: t.success ? (t.slaMet / t.success) * 100 : 0,
      failures: t.failures,
    };
  });

  // Cross-engine totals — EQIS bugs excluded from visible totals
  const totals = engines.reduce((acc, e) => {
    acc.totalSearches  += e.total;            // = success + etravIssues
    acc.totalSuccess   += e.success;
    acc.totalSpf       += e.etravIssues;      // legacy field name; now means Etrav-side only
    acc.totalEtravIssues += e.etravIssues;
    acc.totalEqisBugs    += e.eqisBugs;       // kept for internal accounting, not shown
    return acc;
  }, { totalSearches: 0, totalSuccess: 0, totalSpf: 0, totalEtravIssues: 0, totalEqisBugs: 0 });

  // All failures (sorted by time desc) capped at 15
  const failures = engines.flatMap(e => e.failures)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, 15);

  // 2026-06-11: slowest ONE per engine (not 5 across all) — gives a more
  // informative view because today's data often has the slowest engine
  // dominate the top 5 list. Returns up to 4 rows (one per engine that has
  // at least one search), sorted by duration desc.
  const slowest5 = engines
    .map(e => {
      const durs = (today[e.id] || { durations: [] }).durations;
      if (!durs.length) return null;
      return { duration: Math.max.apply(null, durs), engine: e.name, slaMs: e.slaMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.duration - a.duration);

  return {
    engines,
    failures,
    slowest5,
    totals,
    overallSuccessRate: totals.totalSearches ? (totals.totalSuccess / totals.totalSearches) * 100 : 0,
    spfRate: totals.totalSearches ? (totals.totalSpf / totals.totalSearches) * 100 : 0,
  };
}

/* ─────────────────────────── Quality gates ─────────────────────────── */

function spfQualityGate(data) {
  if (!data || !data.totals) return { passed: false, reason: 'No SearchPulse data available' };
  if (data.totals.totalSearches === 0) return { passed: false, reason: 'Zero searches in last 24h — SearchPulse may be offline' };
  // Send always when there are searches — including the "✓ all healthy" case
  return { passed: true, reason: null };
}

function ecdPromoteQualityGate(data) {
  if (!data || !Array.isArray(data.hotels)) return { passed: false, reason: 'No ECD data available' };
  if (data.hotels.length === 0) return { passed: false, reason: 'ECD cycle produced 0 hotels' };
  // Check if the underlying ECD cycle was healthy
  // 2026-06-18: infra-aware gate. Network errors and Etrav-side timeouts
  // (ERR_INTERNET_DISCONNECTED, ERR_NETWORK_CHANGED, NO_RESULTS_RENDERED,
  // page.goto: Timeout, HEALTH_CHECK_FAILED) are infrastructure issues we
  // can't fix and shouldn't block emails. Only EQIS-bug failures count.
  const allBroken = data.summary && data.summary.ecdBrokenCount || 0;
  const infraPatterns = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|page\.goto.*Timeout|HEALTH_CHECK_FAILED|NO_RESULTS_RENDERED/i;
  const brokenRows = (data.rows || data.hotels || []).filter(r => r && (r.topVerdict === 'ECD_BROKEN' || r.ecdStatus === 'NO_REDIRECT_TO_HOTELS' || r.ecdStatus === 'ECD_TAB_NOT_FOUND' || r.ecdStatus === 'DESTINATION_DROPDOWN_FAILED' || r.ecdStatus === 'CITY_DROPDOWN_FAILED' || r.ecdStatus === 'DATE_PICKER_FAILED'));
  const infraBroken = brokenRows.filter(r => infraPatterns.test((r.error || '') + ' ' + (r.ecdStatus || ''))).length;
  const engineBroken = brokenRows.length - infraBroken;
  // Only block on engine-bug failures. Infra failures are logged but not gating.
  if (engineBroken > 0) {
    return { passed: false, reason: 'ecdBrokenCount=' + allBroken + ' (engine-bugs=' + engineBroken + ', infra=' + infraBroken + ') — engine-bug failures still present' };
  }
  // If everything is infra and there are zero successful hotels, also block.
  const hotelsArr = data.hotels || [];
  if (hotelsArr.length === 0 && infraBroken > 0) {
    return { passed: false, reason: 'ecdBrokenCount=' + allBroken + ' (all ' + infraBroken + ' infra) and zero successful hotels' };
  }
  // Must have at least one ECD-cheaper hotel
  const hasPromote = data.hotels.some(h => (h.combos || []).some(c => c.verdict === 'ECD_CHEAPER'));
  if (!hasPromote) return { passed: false, reason: 'No ECD_CHEAPER combos found across all audited hotels' };
  return { passed: true, reason: null };
}

// 2026-06-12: per user — only email Sudhir once at least 3 hotels are
// flagged as renegotiate targets. Below 3 is too thin a list to warrant
// pinging the contracting team; the digest stays silent until the threshold
// is met. The count is at the HOTEL level (not combo level) to match the
// dashboard's renegotiate-table semantics.
const RENEG_HOTEL_THRESHOLD = 3;
function ecdRenegotiateQualityGate(data) {
  if (!data || !Array.isArray(data.hotels)) return { passed: false, reason: 'No ECD data available' };
  if (data.hotels.length === 0) return { passed: false, reason: 'ECD cycle produced 0 hotels' };
  // 2026-06-18: infra-aware gate. Network errors and Etrav-side timeouts
  // (ERR_INTERNET_DISCONNECTED, ERR_NETWORK_CHANGED, NO_RESULTS_RENDERED,
  // page.goto: Timeout, HEALTH_CHECK_FAILED) are infrastructure issues we
  // can't fix and shouldn't block emails. Only EQIS-bug failures count.
  const allBroken = data.summary && data.summary.ecdBrokenCount || 0;
  const infraPatterns = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|page\.goto.*Timeout|HEALTH_CHECK_FAILED|NO_RESULTS_RENDERED/i;
  const brokenRows = (data.rows || data.hotels || []).filter(r => r && (r.topVerdict === 'ECD_BROKEN' || r.ecdStatus === 'NO_REDIRECT_TO_HOTELS' || r.ecdStatus === 'ECD_TAB_NOT_FOUND' || r.ecdStatus === 'DESTINATION_DROPDOWN_FAILED' || r.ecdStatus === 'CITY_DROPDOWN_FAILED' || r.ecdStatus === 'DATE_PICKER_FAILED'));
  const infraBroken = brokenRows.filter(r => infraPatterns.test((r.error || '') + ' ' + (r.ecdStatus || ''))).length;
  const engineBroken = brokenRows.length - infraBroken;
  // Only block on engine-bug failures. Infra failures are logged but not gating.
  if (engineBroken > 0) {
    return { passed: false, reason: 'ecdBrokenCount=' + allBroken + ' (engine-bugs=' + engineBroken + ', infra=' + infraBroken + ') — engine-bug failures still present' };
  }
  // If everything is infra and there are zero successful hotels, also block.
  const hotelsArr = data.hotels || [];
  if (hotelsArr.length === 0 && infraBroken > 0) {
    return { passed: false, reason: 'ecdBrokenCount=' + allBroken + ' (all ' + infraBroken + ' infra) and zero successful hotels' };
  }
  const renegHotelCount = data.hotels.filter(h => (h.combos || []).some(c => c.verdict === 'NORMAL_CHEAPER')).length;
  if (renegHotelCount < RENEG_HOTEL_THRESHOLD) {
    return { passed: false, reason: 'Only ' + renegHotelCount + ' renegotiate hotel(s) — threshold is ' + RENEG_HOTEL_THRESHOLD };
  }
  return { passed: true, reason: null };
}

/* ─────────────────────────── Send pipeline ─────────────────────────── */

async function runForTeamReport(team, reportType, opts) {
  const o = opts || {};
  const reg = REPORT_REGISTRY[reportType];
  if (!reg) {
    return emailHistory.append({
      teamId: team.id, teamName: team.name, reportType,
      status: 'FAILED', error: 'Unknown report type', recipients: team.emails || [],
      subject: null, summaryLine: null, recordCount: 0, messageId: null, dryRun: false,
    });
  }

  // Dedupe: if we've already sent this team+report combo within 20h, skip.
  if (!o.force && emailHistory.wasSentRecently(team.id, reportType, 20)) {
    return emailHistory.append({
      teamId: team.id, teamName: team.name, reportType,
      status: 'SUPPRESSED', suppressionReason: 'Already sent in last 20h', recipients: team.emails || [],
      subject: null, summaryLine: null, recordCount: 0, messageId: null, dryRun: false,
    });
  }

  const data = await reg.gather();
  const gate = reg.gate(data);
  if (!gate.passed) {
    logger.info('[DIGEST] Suppressed ' + reportType + ' for ' + team.id + ': ' + gate.reason);
    return emailHistory.append({
      teamId: team.id, teamName: team.name, reportType,
      status: 'SUPPRESSED', suppressionReason: gate.reason, recipients: team.emails || [],
      subject: null, summaryLine: null, recordCount: 0, messageId: null, dryRun: false,
    });
  }

  const rendered = reg.render({ ...data, runId: data.runId });
  const sendRes = await mailer.send({
    to: team.emails || [],
    subject: rendered.subject,
    html: rendered.html,
  });

  return emailHistory.append({
    teamId: team.id, teamName: team.name, reportType,
    status: sendRes.ok ? (sendRes.dryRun ? 'DRY_RUN' : 'OK') : 'FAILED',
    suppressionReason: null,
    recipients: sendRes.recipients,
    subject: rendered.subject,
    summaryLine: rendered.summaryLine,
    recordCount: rendered.recordCount,
    messageId: sendRes.messageId,
    dryRun: !!sendRes.dryRun,
    error: sendRes.error,
  });
}

async function runForTeam(team, opts) {
  if (!team || !team.enabled) {
    logger.info('[DIGEST] Skipping disabled team: ' + (team && team.id));
    return [];
  }
  const results = [];
  for (const reportType of (team.reports || [])) {
    try {
      const res = await runForTeamReport(team, reportType, opts);
      results.push(res);
    } catch (err) {
      logger.error('[DIGEST] Crashed running ' + reportType + ' for ' + team.id + ': ' + err.message);
      results.push(emailHistory.append({
        teamId: team.id, teamName: team.name, reportType,
        status: 'FAILED', error: 'Crash: ' + err.message,
        recipients: team.emails || [], subject: null, summaryLine: null, recordCount: 0, messageId: null, dryRun: false,
      }));
    }
  }
  return results;
}

async function runOnce(opts) {
  const o = opts || {};
  const roster = readRoster();
  logger.info('[DIGEST] Daily run starting — ' + (roster.teams || []).length + ' teams, mailer ' + (mailer.isEnabled() ? 'LIVE' : 'DRY-RUN'));
  const all = [];
  for (const team of (roster.teams || [])) {
    if (o.onlyTeam && team.id !== o.onlyTeam) continue;
    const res = await runForTeam(team, o);
    all.push(...res);
  }
  logger.info('[DIGEST] Daily run complete — ' + all.length + ' send attempts');
  return all;
}

/* ───────────────────── Resilient daily delivery ────────────────────── */
//
// The original design relied on a single `0 9 * * *` node-cron tick. That
// tick is silently lost whenever the process isn't alive at exactly 09:00
// IST (frequent dev restarts) OR the single-threaded event loop is blocked
// at that instant (long Playwright hangs / a synchronous spawnSync in the
// recorder). node-cron does NOT replay missed ticks, so a missed 09:00 =
// no digest that day and not even a SUPPRESSED record. The helpers below
// make delivery resilient: an hourly catch-up + a boot catch-up both call
// the idempotent runDueDigests(), which sends each enabled team's digest
// once per IST day. Duplicate sends are prevented by the per-team
// "already sent today" guard plus the existing 20h dedup in
// runForTeamReport. The quality gates are unchanged — a team is only
// emailed when its data qualifies (low/empty-data days still suppress).

const DIGEST_TZ = settings.TIMEZONE || 'Asia/Kolkata';
const SEND_AFTER_MIN = 9 * 60; // earliest send: 09:00 IST

// IST calendar date ("YYYY-MM-DD") for an ISO timestamp (or now if omitted).
function _istDateFor(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString('en-CA', {
    timeZone: DIGEST_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).slice(0, 10);
}

// Current IST time as minutes-since-midnight (09:00 → 540).
function _istMinutesNow() {
  const hhmm = new Date().toLocaleString('en-GB', {
    timeZone: DIGEST_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  return ((h || 0) * 60) + (m || 0);
}

// Has this team already had a successful (OK/DRY_RUN) send today (IST)?
function _teamSentToday(teamId) {
  const today = _istDateFor();
  return emailHistory.read().sends.some((s) =>
    s && s.teamId === teamId
    && (s.status === 'OK' || s.status === 'DRY_RUN')
    && _istDateFor(s.sentAt) === today);
}

let _runningDue = false;

/**
 * Idempotent daily delivery. For each enabled team that has NOT already had a
 * successful send today (IST) and when it's at/after 09:00 IST, run its
 * subscribed digests through the normal pipeline (gather → gate → send).
 * Safe to call repeatedly and concurrently (in-flight lock + per-team guard),
 * which is what guarantees a same-day send even when the exact 09:00 cron
 * tick was missed. Quality gates are untouched: suppressed teams are retried
 * on the next hourly tick, giving same-day data a chance to qualify.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.ignoreTimeGate] skip the 09:00 floor (used by the 9am tick)
 * @param {string}  [opts.onlyTeam] restrict to a single team id
 */
async function runDueDigests(opts) {
  const o = opts || {};
  if (_runningDue) return [];
  if (!o.ignoreTimeGate && _istMinutesNow() < SEND_AFTER_MIN) return [];
  _runningDue = true;
  try {
    const roster = readRoster();
    const all = [];
    for (const team of (roster.teams || [])) {
      if (!team || !team.enabled) continue;
      if (o.onlyTeam && team.id !== o.onlyTeam) continue;
      if (_teamSentToday(team.id)) continue; // already delivered today
      const res = await runForTeam(team, o);
      all.push(...res);
    }
    if (all.length) {
      logger.info('[DIGEST] Catch-up delivery — ' + all.length + ' attempt(s) for teams not yet sent today');
    }
    return all;
  } finally {
    _runningDue = false;
  }
}

/* ─────────────────────────── Cron registration ─────────────────────── */

let _registered = false;
function register() {
  if (_registered) return false;
  // Timezone is centrally configured (Asia/Kolkata) via settings.TIMEZONE.
  try {
    // 1) Fast path — exact 09:00 IST tick. Routed through runDueDigests so it
    //    shares the in-flight lock + per-team guard with the catch-up paths.
    cron.schedule('0 9 * * *', async () => {
      logger.info('[DIGEST] 9am IST trigger fired');
      try { await runDueDigests({ ignoreTimeGate: true }); }
      catch (err) { logger.error('[DIGEST] 9am run failed: ' + err.message); }
    }, { timezone: DIGEST_TZ });

    // 2) Safety net — hourly catch-up (minute 5) so a missed 09:00 tick
    //    (process restart or a blocked event loop) still delivers the same
    //    day. No-op once every enabled team has been sent for the day.
    cron.schedule('5 * * * *', async () => {
      try { await runDueDigests(); }
      catch (err) { logger.error('[DIGEST] hourly catch-up failed: ' + err.message); }
    }, { timezone: DIGEST_TZ });

    _registered = true;
    logger.info('[DIGEST] Daily digest scheduler registered: 0 9 * * * + hourly catch-up (' + DIGEST_TZ + ') · mailer ' + (mailer.isEnabled() ? 'LIVE' : 'DRY-RUN — set GMAIL_OAUTH_* env vars or state/gmail-oauth-*.json to enable sending'));

    // 3) Boot catch-up — if EQIS starts after 09:00 IST having missed the
    //    tick, deliver shortly after boot (deferred so engines can settle).
    setTimeout(() => {
      runDueDigests().catch((err) => logger.error('[DIGEST] boot catch-up failed: ' + err.message));
    }, 60 * 1000);

    return true;
  } catch (err) {
    logger.error('[DIGEST] Failed to register daily cron: ' + err.message);
    return false;
  }
}

module.exports = {
  register,
  runOnce,
  runDueDigests,
  runForTeam,
  runForTeamReport,
  readRoster,
  _internals: { gatherEcdData, gatherSpfData, REPORT_REGISTRY, _teamSentToday, _istDateFor, _istMinutesNow },
};

// ecdApi.js — Dashboard endpoints for the ECD comparison engine.
//
// Endpoints:
//   GET  /api/ecd/status          -> engine status (paused/running, last run, totals)
//   GET  /api/ecd/latest          -> latest full comparison report (JSON)
//   GET  /api/ecd/history         -> array of recent run summaries
//   GET  /api/ecd/destinations    -> current ECD destination list + rotation pointer
//   POST /api/ecd/run-now         -> trigger one cycle now (fire-and-forget)

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const settings = require('../../config/settings');

const STATE_DIR = path.join(__dirname, '..', '..', 'state');
const REPORTS_DIR = path.join(settings.REPORT_DIR, 'ecd');

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    logger.warn('[ECD-API] read failed ' + file + ': ' + err.message);
    return fallback;
  }
}

function ecdStatusApi(req, res) {
  const engineState = readJsonSafe(path.join(STATE_DIR, 'engineState.json'), {});
  const systemState = readJsonSafe(path.join(STATE_DIR, 'systemState.json'), {});
  res.json({
    enabled: settings.ECD_ENABLED === 'true',
    intervalMinutes: settings.ECD_RUN_INTERVAL_MINUTES,
    destinationsPerRun: settings.ECD_DESTINATIONS_PER_RUN,
    topCombosPerHotel: settings.ECD_TOP_COMBOS_PER_HOTEL,
    engineStatus: engineState.ecd?.status || 'paused',
    lastRunAt: engineState.ecd?.lastRun || null,
    lastRun: systemState.lastEcdRun || null,
    totalRuns: systemState.totalEcdRuns || 0,
    currentVerdictMix: systemState.currentEcdVerdictMix || null,
  });
}

function ecdLatestApi(req, res) {
  // Find newest JSON in reports/ecd
  if (!fs.existsSync(REPORTS_DIR)) return res.json({ run: null });
  const files = fs.readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, mtime: fs.statSync(path.join(REPORTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) return res.json({ run: null });
  const data = readJsonSafe(path.join(REPORTS_DIR, files[0].file), null);
  res.json({ run: data, file: files[0].file });
}

function ecdHistoryApi(req, res) {
  const history = readJsonSafe(path.join(STATE_DIR, 'ecdHistory.json'), { runs: [] });
  const limit = parseInt(req.query.limit, 10) || 50;
  const runs = (history.runs || []).slice(-limit).reverse();
  res.json({ runs });
}

function ecdDestinationsApi(req, res) {
  const rotation = readJsonSafe(path.join(STATE_DIR, 'ecdRotation.json'), { pointer: 0, destinations: [] });
  res.json({
    pointer: rotation.pointer || 0,
    destinations: rotation.destinations || [],
    lastBatch: rotation.lastBatch || [],
    lastBatchAt: rotation.lastBatchAt || null,
  });
}

async function ecdRunNowApi(req, res) {
  try {
    const { runEcdComparisonCycle } = require('../../ecd-comparator/ecdOrchestrator');
    // Fire and forget — return immediately so dashboard isn't blocked
    runEcdComparisonCycle({ force: true })
      .then((r) => logger.info('[ECD-API] on-demand cycle complete: skipped=' + !!r.skipped))
      .catch((err) => logger.error('[ECD-API] on-demand cycle failed: ' + err.message));
    res.json({ accepted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}



function ecdProgressApi(req, res) {
  try {
    const data = require('../../utils/ecdLiveProgress').read();
    if (!data) return res.json({ run: null });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}


function ecdNotesListApi(req, res) {
  try { res.json(require('../../utils/ecdNotes').readAll()); }
  catch (err) { res.status(500).json({ error: err.message }); }
}
function ecdNotesGetApi(req, res) {
  try { res.json(require('../../utils/ecdNotes').get(req.params.hotel)); }
  catch (err) { res.status(500).json({ error: err.message }); }
}
function ecdNotesSaveApi(req, res) {
  try {
    const hotel = req.params.hotel;
    const fields = req.body || {};
    res.json(require('../../utils/ecdNotes').set(hotel, fields));
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function ecdExportCsvApi(req, res) {
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'reports', 'ecd');
    let latest = null;
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
        .map(f => ({ f, mt: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a,b)=>b.mt-a.mt);
      if (files.length) latest = JSON.parse(fs.readFileSync(path.join(dir, files[0].f), 'utf-8'));
    }
    if (!latest) return res.status(404).send('No comparison reports yet');
    const rows = [['Hotel','Stars','Destination','Dates','Pax/Rooms','Room+Meal','ECD Price','Bedbank Price','Diff %','Diff INR','Verdict']];
    for (const r of (latest.hotelComparisons || [])) {
      for (const c of (r.combos || [])) {
        const csvRow = [
          r.hotelName || '',
          r.starRating != null ? r.starRating + '-star' : 'unrated',
          r.destination || '',
          (r.checkin || '') + ' to ' + (r.checkout || ''),
          (r.pax ? r.pax.adults + 'A/' + r.pax.rooms + 'R' : ''),
          (c.roomCategory || '') + ' + ' + (c.mealPlan || ''),
          c.ecd && c.ecd.totalPrice ? c.ecd.totalPrice : '',
          c.normal && c.normal.totalPrice ? c.normal.totalPrice : '',
          c.diff && c.diff.pct != null ? c.diff.pct : '',
          c.diff && c.diff.absINR != null ? c.diff.absINR : '',
          c.verdict || '',
        ];
        rows.push(csvRow);
      }
    }
    const csv = rows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="ecd-report-' + (latest.runId || 'export') + '.csv"');
    res.send(csv);
  } catch (err) { res.status(500).send('Export failed: ' + err.message); }
}

function ecdActivityApi(req, res) {
  try {
    const act = require('../../utils/ecdActivity').get();
    res.json(act);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// PORTFOLIO — merged view of every hotel ever compared. For each hotel we
// keep its most recent comparison row, stamped with the run timestamp so the
// dashboard can show "Checked: X ago" per hotel. Results never disappear when
// a new cycle covers a different destination.
// ---------------------------------------------------------------------------
function ecdPortfolioApi(req, res) {
  try {
    if (!fs.existsSync(REPORTS_DIR)) return res.json({ run: null });

    // Only show hotels from destinations currently in the active rotation.
    // Removing a destination from state/ecdRotation.json hides its hotels
    // from the dashboard immediately. (UAE/Dubai was paused 2026-06-01.)
    const rotation = readJsonSafe(path.join(STATE_DIR, 'ecdRotation.json'), { destinations: [] });
    const activeDestinations = new Set((rotation.destinations || []).map(d => String(d).toLowerCase()));

    const files = fs.readdirSync(REPORTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(REPORTS_DIR, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime); // oldest first so newest overwrites

    const byHotel = new Map();        // hotelName -> hotelRow + metadata
    let newestTimestamp = null;
    let newestRunId = null;
    let skippedInactive = 0;

    for (const f of files) {
      const data = readJsonSafe(path.join(REPORTS_DIR, f.file), null);
      if (!data || !Array.isArray(data.hotelComparisons)) continue;
      const ts = data.timestamp || new Date(f.mtime).toISOString();
      if (!newestTimestamp || ts > newestTimestamp) {
        newestTimestamp = ts;
        newestRunId = data.runId;
      }
      for (const row of data.hotelComparisons) {
        if (!row || !row.hotelName) continue;
        const dest = String(row.destination || '').toLowerCase();
        if (activeDestinations.size > 0 && !activeDestinations.has(dest)) {
          skippedInactive++;
          continue;
        }
        // Don't let a row that's pure DEFAULT_STOCKOUT (no real comparison)
        // overwrite an existing row that DOES have a real comparison verdict.
        // This prevents fresh-but-useless data from wiping out older good data.
        const combos = row.combos || [];
        const hasUsefulVerdict = combos.some(c =>
          c && (c.verdict === 'ECD_CHEAPER' || c.verdict === 'NORMAL_CHEAPER' || c.verdict === 'EQUAL'));
        const allStockout = combos.length > 0 && combos.every(c =>
          c && c.verdict === 'DEFAULT_STOCKOUT');
        const existing = byHotel.get(row.hotelName);
        if (existing && allStockout) {
          // Skip — keep the existing good comparison
          continue;
        }
        const stamped = Object.assign({}, row, {
          lastCheckedAt: ts,
          lastCheckedRunId: data.runId,
        });
        byHotel.set(row.hotelName, stamped);    // newer iter overwrites older
      }
    }

    // Final filter: only return hotels that have at least one real comparison
    // verdict (ECD_CHEAPER, NORMAL_CHEAPER, or EQUAL). Hotels stuck on pure
    // DEFAULT_STOCKOUT or COMBO_UNMATCHED don\'t belong on the dashboard —
    // they can\'t be acted on.
    const allHotels = Array.from(byHotel.values());
    const hotels = allHotels.filter(row => {
      const combos = row.combos || [];
      return combos.some(c =>
        c && (c.verdict === 'ECD_CHEAPER' || c.verdict === 'NORMAL_CHEAPER' || c.verdict === 'EQUAL'));
    });
    const skippedNoComparison = allHotels.length - hotels.length;

    res.json({
      run: {
        runId: newestRunId,
        timestamp: newestTimestamp,
        hotelComparisons: hotels,
        summary: { totalHotels: hotels.length },
      },
      portfolioSize: hotels.length,
      sourceRuns: files.length,
      activeDestinations: Array.from(activeDestinations),
      skippedInactive,
      skippedNoComparison,
    });
  } catch (err) {
    logger.warn('[ECD-API] portfolio failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// CEO METRICS — executive view aggregator. Reads the latest comparison report
// + notes + history and rolls everything into a single payload designed for
// the CEO dashboard (portfolio position + team productivity + trend).
// ---------------------------------------------------------------------------
function _readLatestRun() {
  if (!fs.existsSync(REPORTS_DIR)) return null;
  const files = fs.readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, mtime: fs.statSync(path.join(REPORTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) return null;
  return readJsonSafe(path.join(REPORTS_DIR, files[0].file), null);
}

function _bestVerdict(row) {
  // Hotel-level verdict from its combos: NORMAL_CHEAPER wins (bad), then EQUAL,
  // then ECD_CHEAPER (good). Used to bucket hotels.
  const v = (row.combos || []).map((c) => c.verdict);
  if (v.some((x) => x === 'NORMAL_CHEAPER')) return 'NORMAL_CHEAPER';
  if (v.some((x) => x === 'EQUAL')) return 'EQUAL';
  if (v.some((x) => x === 'ECD_CHEAPER')) return 'ECD_CHEAPER';
  return 'UNKNOWN';
}

function _hotelSavings(row) {
  // Best (largest) |diff.absINR| across combos, signed:
  //   positive = bedbank cheaper (we overpay) — renegotiation value
  //   negative = ECD cheaper (we beat market) — promotion value
  let best = 0;
  for (const c of row.combos || []) {
    if (!c.diff || c.diff.absINR == null) continue;
    const signed = c.verdict === 'NORMAL_CHEAPER' ? Math.abs(c.diff.absINR)
      : c.verdict === 'ECD_CHEAPER' ? -Math.abs(c.diff.absINR) : 0;
    if (Math.abs(signed) > Math.abs(best)) best = signed;
  }
  return best;
}

function ecdCeoMetricsApi(req, res) {
  try {
    const latest = _readLatestRun();
    const history = readJsonSafe(path.join(STATE_DIR, 'ecdHistory.json'), { runs: [] });

    const hotels = (latest && latest.hotelComparisons) || [];
    const totalHotels = hotels.length;

    // ---------- Portfolio buckets ----------
    let ecdWinHotels = 0, bedbankWinHotels = 0, equalHotels = 0, brokenHotels = 0;
    let totalRenegotiateINR = 0, totalPromoteINR = 0;
    const advantagePcts = [];           // pct savings on combos where ECD beats
    const overpayPcts = [];             // pct overpayment on combos where bedbank beats
    let combosTotal = 0, combosEcdWin = 0, combosBedbankWin = 0, combosEqual = 0;
    const destAgg = {};                 // destination -> { hotels, savings, promote, ecdWins, total }
    const starAgg = {};                 // star -> { hotels, savings, promote, ecdWins, total }

    for (const row of hotels) {
      const verdict = _bestVerdict(row);
      const savings = _hotelSavings(row);
      if (verdict === 'NORMAL_CHEAPER') { bedbankWinHotels++; totalRenegotiateINR += Math.max(0, savings); }
      else if (verdict === 'ECD_CHEAPER') { ecdWinHotels++; totalPromoteINR += Math.abs(Math.min(0, savings)); }
      else if (verdict === 'EQUAL') equalHotels++;
      else brokenHotels++;

      // Per-combo aggregation
      for (const c of row.combos || []) {
        combosTotal++;
        if (c.verdict === 'ECD_CHEAPER') {
          combosEcdWin++;
          if (c.diff && c.diff.pct != null) advantagePcts.push(Math.abs(c.diff.pct));
        } else if (c.verdict === 'NORMAL_CHEAPER') {
          combosBedbankWin++;
          if (c.diff && c.diff.pct != null) overpayPcts.push(Math.abs(c.diff.pct));
        } else if (c.verdict === 'EQUAL') combosEqual++;
      }

      // Destination breakdown
      const dest = row.destination || 'Unknown';
      if (!destAgg[dest]) destAgg[dest] = { hotels: 0, renegotiateINR: 0, promoteINR: 0, ecdWins: 0, bedbankWins: 0 };
      destAgg[dest].hotels++;
      if (verdict === 'ECD_CHEAPER') { destAgg[dest].ecdWins++; destAgg[dest].promoteINR += Math.abs(Math.min(0, savings)); }
      else if (verdict === 'NORMAL_CHEAPER') { destAgg[dest].bedbankWins++; destAgg[dest].renegotiateINR += Math.max(0, savings); }

      // Star breakdown
      const star = row.starRating != null ? String(row.starRating) : 'unrated';
      if (!starAgg[star]) starAgg[star] = { hotels: 0, renegotiateINR: 0, promoteINR: 0, ecdWins: 0, bedbankWins: 0 };
      starAgg[star].hotels++;
      if (verdict === 'ECD_CHEAPER') { starAgg[star].ecdWins++; starAgg[star].promoteINR += Math.abs(Math.min(0, savings)); }
      else if (verdict === 'NORMAL_CHEAPER') { starAgg[star].bedbankWins++; starAgg[star].renegotiateINR += Math.max(0, savings); }
    }

    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const ecdWinRate = combosTotal ? combosEcdWin / combosTotal : 0;
    const bedbankWinRate = combosTotal ? combosBedbankWin / combosTotal : 0;

    // ---------- History trend ----------
    const recentRuns = (history.runs || []).slice(-10).map((r) => ({
      runId: r.runId,
      timestamp: r.timestamp,
      ecdCheaperPct: r.summary ? r.summary.ecdCheaperPct : 0,
      normalCheaperPct: r.summary ? r.summary.normalCheaperPct : 0,
      avgEcdAdvantageINR: r.summary ? r.summary.avgEcdAdvantageINR : 0,
      totalCombosCompared: r.summary ? r.summary.totalCombosCompared : 0,
    }));

    // ---------- Top mover lists ----------
    const sortedByOverpay = hotels
      .map((r) => ({ row: r, val: _hotelSavings(r) }))
      .filter((x) => x.val > 0)
      .sort((a, b) => b.val - a.val)
      .slice(0, 5)
      .map((x) => ({ hotel: x.row.hotelName, destination: x.row.destination, starRating: x.row.starRating, gapINR: x.val }));
    const sortedByAdvantage = hotels
      .map((r) => ({ row: r, val: _hotelSavings(r) }))
      .filter((x) => x.val < 0)
      .sort((a, b) => a.val - b.val)
      .slice(0, 5)
      .map((x) => ({ hotel: x.row.hotelName, destination: x.row.destination, starRating: x.row.starRating, advantageINR: Math.abs(x.val) }));

    res.json({
      runId: latest && latest.runId,
      runAt: latest && latest.timestamp,
      portfolio: {
        totalHotels,
        ecdWinHotels,
        bedbankWinHotels,
        equalHotels,
        brokenHotels,
        ecdWinRate,           // 0..1
        bedbankWinRate,       // 0..1
        avgPriceAdvantagePct: avg(advantagePcts),  // when ECD wins
        avgOverpayPct: avg(overpayPcts),           // when bedbank wins
        totalRenegotiateINR,
        totalPromoteINR,
        combosTotal,
        combosEcdWin,
        combosBedbankWin,
        combosEqual,
      },
      byDestination: destAgg,
      byStar: starAgg,
      trend: recentRuns,
      topOverpaid: sortedByOverpay,
      topAdvantaged: sortedByAdvantage,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  ecdActivityApi,
  ecdNotesListApi,
  ecdNotesGetApi,
  ecdNotesSaveApi,
  ecdExportCsvApi,
  ecdProgressApi,
  ecdCeoMetricsApi,
  ecdPortfolioApi,
  ecdStatusApi,
  ecdLatestApi,
  ecdHistoryApi,
  ecdDestinationsApi,
  ecdRunNowApi,
};

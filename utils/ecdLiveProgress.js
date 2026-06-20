// ecdLiveProgress.js — incremental, hotel-by-hotel comparison state file.
//
// While the ECD orchestrator is running, this is updated after each hotel's
// full ECD→bedbank→compare cycle so the dashboard can show results as they
// trickle in (instead of waiting for the entire 60+ minute run to finish).
//
// Shape:
//   {
//     runId, startedAt, totalExpected, finishedAt,
//     hotelComparisons: [ ... same row shape buildComparison produces ... ],
//     summary: { ... same as final report ... }
//   }

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'state', 'ecdLiveProgress.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); }
  catch { return null; }
}

function write(data) {
  try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); } catch { /* ignore */ }
}

function startRun(runId, totalExpected) {
  write({
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalExpected: totalExpected || 0,
    hotelComparisons: [],
    summary: { totalCombosCompared: 0, ecdCheaperCount: 0, normalCheaperCount: 0, equalCount: 0, defaultStockoutCount: 0, unmatchedComboCount: 0, ecdBrokenCount: 0, avgEcdAdvantageINR: 0, hotelsProcessed: 0 },
  });
}

function addHotelRow(row) {
  const cur = read() || { hotelComparisons: [], summary: {} };
  cur.hotelComparisons.push(row);
  // Recompute summary on the fly
  let total = 0, ecdCheap = 0, normCheap = 0, eq = 0, stock = 0, unmatched = 0, broken = 0;
  let advSum = 0, advCount = 0;
  for (const r of cur.hotelComparisons) {
    if (r.topVerdict === 'ECD_BROKEN') broken++;
    for (const c of (r.combos || [])) {
      total++;
      switch (c.verdict) {
        case 'ECD_CHEAPER': ecdCheap++; if (typeof c.diff?.absINR === 'number') { advSum += -c.diff.absINR; advCount++; } break;
        case 'NORMAL_CHEAPER': normCheap++; break;
        case 'EQUAL': eq++; break;
        case 'DEFAULT_STOCKOUT': stock++; break;
        case 'COMBO_UNMATCHED': unmatched++; break;
      }
    }
  }
  const pct = (n) => total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
  cur.summary = {
    totalCombosCompared: total,
    ecdCheaperCount: ecdCheap, ecdCheaperPct: pct(ecdCheap),
    normalCheaperCount: normCheap, normalCheaperPct: pct(normCheap),
    equalCount: eq, equalPct: pct(eq),
    defaultStockoutCount: stock,
    unmatchedComboCount: unmatched,
    ecdBrokenCount: broken,
    avgEcdAdvantageINR: advCount > 0 ? Math.round(advSum / advCount) : 0,
    hotelsProcessed: cur.hotelComparisons.length,
  };
  write(cur);
}

function finishRun() {
  const cur = read();
  if (cur) { cur.finishedAt = new Date().toISOString(); write(cur); }
}

function clearRun() {
  write({ runId: null, startedAt: null, finishedAt: null, totalExpected: 0, hotelComparisons: [], summary: {} });
}

module.exports = { startRun, addHotelRow, finishRun, clearRun, read };

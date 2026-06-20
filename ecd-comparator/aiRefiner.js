// aiRefiner.js — After deterministic comparison, this refiner sweeps over any
// COMBO_UNMATCHED rows and asks Claude (Haiku) whether each unmatched ECD
// room+meal description actually equals one of the bedbank combos.
//
// When Claude says match, the row is rewritten as a real price comparison.
//
// Cost-safe: one batched Claude call per run (up to 30 pairs), defaults to
// "no match" if API fails or budget is exhausted.

const logger = require('../utils/logger');
const { judgeRoomPairs } = require('../engine6-mirror/aiRoomJudge');
const { priceVerdict, VERDICTS } = require('./verdictRules');

/**
 * Walk the comparison.hotelComparisons[].combos and use AI to confirm matches
 * where deterministic matching said COMBO_UNMATCHED. Modifies comparison in place.
 *
 * @param {Object} comparison  output of buildComparison()
 * @param {Object} mirrorRun   the mirror engine run output (for full combo lists)
 * @returns {Promise<{aiCallsMade, pairsJudged, pairsMatched, rowsUpgraded}>}
 */
async function refineWithAiJudge(comparison, mirrorRun) {
  if (!comparison || !Array.isArray(comparison.hotelComparisons)) {
    return { aiCallsMade: 0, pairsJudged: 0, pairsMatched: 0, rowsUpgraded: 0 };
  }

  // Build lookup: ecdHotelName → mirror combos (full bedbank room list)
  const mirrorByHotel = new Map();
  for (const m of (mirrorRun?.mirrorResults || [])) {
    if (m.ecdHotelName && Array.isArray(m.combos) && m.combos.length > 0) {
      mirrorByHotel.set(m.ecdHotelName, m.combos);
    }
  }

  // Collect all (ECD unmatched combo, candidate bedbank combo) pairs
  // Strategy: for each unmatched ECD combo, pick the bedbank combo whose price
  // is closest (most likely to be same room product).
  const pairs = [];
  const pairRefs = []; // links back into the comparison for in-place updates

  for (const row of comparison.hotelComparisons) {
    if (!row.combos || row.combos.length === 0) continue;
    const bedbankCombos = mirrorByHotel.get(row.hotelName) || [];
    if (bedbankCombos.length === 0) continue;

    // Track which bedbank combos are already used (so we don't double-match)
    const usedBedbankIdx = new Set();
    // Mark anything already matched at deterministic stage to skip
    for (const c of row.combos) {
      if (c.normal && c.normal.totalPrice != null) {
        const i = bedbankCombos.findIndex((b) => b.totalPrice === c.normal.totalPrice
          && b.roomCategory === c.matchedNormalRoom);
        if (i >= 0) usedBedbankIdx.add(i);
      }
    }

    for (let comboIdx = 0; comboIdx < row.combos.length; comboIdx++) {
      const c = row.combos[comboIdx];
      if (c.verdict !== VERDICTS.COMBO_UNMATCHED) continue;
      const ecdPrice = c.ecd && c.ecd.totalPrice;
      if (typeof ecdPrice !== 'number') continue;

      // Pick the unused bedbank combo with smallest price gap
      let bestI = -1, bestGap = Infinity;
      for (let i = 0; i < bedbankCombos.length; i++) {
        if (usedBedbankIdx.has(i)) continue;
        const gap = Math.abs((bedbankCombos[i].totalPrice || 0) - ecdPrice);
        if (gap < bestGap) { bestGap = gap; bestI = i; }
      }
      if (bestI < 0) continue;

      const candidate = bedbankCombos[bestI];
      pairs.push({
        ecdRoom: c.roomCategory || '',
        ecdMeal: c.mealPlan || '',
        normalRoom: candidate.roomCategory || '',
        normalMeal: candidate.mealPlan || '',
      });
      pairRefs.push({ row, comboIdx, candidate, bedbankIdx: bestI, usedBedbankIdx });
    }
  }

  if (pairs.length === 0) {
    return { aiCallsMade: 0, pairsJudged: 0, pairsMatched: 0, rowsUpgraded: 0 };
  }

  logger.info('[AI-REFINE] Sending ' + pairs.length + ' uncertain room pairs to Claude');
  const verdicts = await judgeRoomPairs(pairs);

  let rowsUpgraded = 0;
  let matched = 0;
  for (let i = 0; i < verdicts.length; i++) {
    const v = verdicts[i];
    const ref = pairRefs[i];
    if (!v || !v.match) continue;

    // AI confirmed match → upgrade the COMBO_UNMATCHED row to a real price comparison
    const c = ref.row.combos[ref.comboIdx];
    const ecdPrice = c.ecd.totalPrice;
    const normalPrice = ref.candidate.totalPrice;
    const pv = priceVerdict(ecdPrice, normalPrice);

    ref.row.combos[ref.comboIdx] = {
      ...c,
      matchedNormalRoom: ref.candidate.roomCategory,
      matchedNormalMeal: ref.candidate.mealPlan,
      aiConfirmed: true,
      aiConfidence: v.confidence,
      ecd: c.ecd,
      normal: { totalPrice: normalPrice, currency: ref.candidate.currency || 'INR', matched: true },
      diff: { absINR: pv.absINR, pct: pv.pct, cheaperSide: pv.cheaperSide },
      verdict: pv.verdict,
      severity: pv.severity,
    };

    // Mark the bedbank combo as used so it can't double-match
    ref.usedBedbankIdx.add(ref.bedbankIdx);
    rowsUpgraded++;
    matched++;
  }

  // Recompute summary so totals reflect the AI upgrades
  if (rowsUpgraded > 0 && typeof comparison.summary === 'object') {
    recomputeSummary(comparison);
  }

  logger.info('[AI-REFINE] ' + matched + '/' + verdicts.length + ' pairs matched by AI; ' + rowsUpgraded + ' comparison rows upgraded');
  return { aiCallsMade: 1, pairsJudged: pairs.length, pairsMatched: matched, rowsUpgraded };
}

function recomputeSummary(comparison) {
  let total = 0, ecdCheap = 0, normalCheap = 0, equal = 0, stockout = 0, unmatched = 0, broken = 0;
  let advSum = 0, advCount = 0;
  for (const row of comparison.hotelComparisons) {
    if (row.topVerdict === VERDICTS.ECD_BROKEN) broken++;
    for (const c of (row.combos || [])) {
      total++;
      switch (c.verdict) {
        case VERDICTS.ECD_CHEAPER:
          ecdCheap++;
          if (typeof c.diff?.absINR === 'number') { advSum += -c.diff.absINR; advCount++; }
          break;
        case VERDICTS.NORMAL_CHEAPER: normalCheap++; break;
        case VERDICTS.EQUAL: equal++; break;
        case VERDICTS.DEFAULT_STOCKOUT: stockout++; break;
        case VERDICTS.COMBO_UNMATCHED: unmatched++; break;
        default: break;
      }
    }
  }
  const pct = (n) => total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
  comparison.summary = {
    totalCombosCompared: total,
    ecdCheaperCount: ecdCheap,
    normalCheaperCount: normalCheap,
    equalCount: equal,
    ecdCheaperPct: pct(ecdCheap),
    normalCheaperPct: pct(normalCheap),
    equalPct: pct(equal),
    defaultStockoutCount: stockout,
    unmatchedComboCount: unmatched,
    ecdBrokenCount: broken,
    avgEcdAdvantageINR: advCount > 0 ? Math.round(advSum / advCount) : 0,
  };
}

module.exports = { refineWithAiJudge };

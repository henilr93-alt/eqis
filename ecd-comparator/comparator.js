// comparator.js — Glue between engine5-ecd and engine6-mirror output.
// Produces the canonical run object that the report builder, dashboard API,
// and state/ecdHistory.json all consume.
//
// Pure orchestration logic — no Playwright, no I/O outside passed-in arrays.

const { findBestComboMatch } = require('../engine6-mirror/combinationMatcher');
const { priceVerdict, nonPriceVerdict, VERDICTS } = require('./verdictRules');
const settings = require('../config/settings');

/**
 * Merge ECD + mirror outputs into per-hotel comparison rows.
 *
 * @param {Object} ecdRun     output of engine5-ecd/runEcdEngine
 * @param {Object} mirrorRun  output of engine6-mirror/runMirrorEngine
 * @returns {Object} canonical ECD run record
 */
function buildComparison(ecdRun, mirrorRun) {
  const runId = ecdRun?.runId || mirrorRun?.runId || null;
  const scenario = ecdRun?.scenario || mirrorRun?.scenario || null;
  const destinations = ecdRun?.destinations || [];

  // Index mirror results by (destination + ecdHotelName)
  const mirrorIndex = new Map();
  for (const m of (mirrorRun?.mirrorResults || [])) {
    const key = (m.destination || '') + '|' + (m.ecdHotelName || '');
    mirrorIndex.set(key, m);
  }

  const hotelComparisons = [];

  for (const ecdGroup of (ecdRun?.ecdResults || [])) {
    if (!ecdGroup) continue;

    // Surface engine-level ECD failures as a visible row regardless of whether
    // hotels[] is an empty array or undefined. Anything other than searchStatus
    // === 'OK' with hotels.length > 0 means the operator needs visibility.
    const hotelsArr = Array.isArray(ecdGroup.hotels) ? ecdGroup.hotels : [];
    const ecdFailed = ecdGroup.searchStatus && ecdGroup.searchStatus !== 'OK';
    const ecdEmpty = !ecdFailed && hotelsArr.length === 0;

    if (ecdFailed || ecdEmpty) {
      hotelComparisons.push({
        destination: ecdGroup.destination || null,
        hotelName: null,
        ecdHotelId: null,
        checkin: ecdGroup.checkin || null,
        checkout: ecdGroup.checkout || null,
        pax: { adults: ecdGroup.adults || null, rooms: ecdGroup.rooms || null },
        combos: [],
        severity: ecdFailed ? 'P0' : null,
        topVerdict: ecdFailed ? VERDICTS.ECD_BROKEN : 'ZERO_RESULTS',
        ecdStatus: ecdGroup.searchStatus || 'ZERO_RESULTS',
        mirrorStatus: null,
        error: ecdGroup.error || null,
        selectedAutosuggest: ecdGroup.selectedAutosuggest || null,
        pageUrl: ecdGroup.pageUrl || null,
      });
      if (hotelsArr.length === 0) continue;
    }

    for (const ecdHotel of ecdGroup.hotels) {
      const key = ecdGroup.destination + '|' + ecdHotel.name;
      const mirror = mirrorIndex.get(key);

      const baseRow = {
        destination: ecdGroup.destination,
        hotelName: ecdHotel.name,
        starRating: ecdHotel.starRating || null,
        ecdHotelId: ecdHotel.ecdHotelId || null,
        checkin: ecdGroup.checkin,
        checkout: ecdGroup.checkout,
        pax: { adults: ecdGroup.adults, rooms: ecdGroup.rooms },
        ecdStatus: ecdGroup.searchStatus,
        mirrorStatus: mirror?.searchStatus || null,
        mirrorAutosuggest: mirror?.autosuggestPick || null,
        mirrorCardScore: mirror?.cardScore || 0,
        combos: [],
        severity: null,
        topVerdict: null,
      };

      // Mirror missing entirely or no match → DEFAULT_STOCKOUT for every ECD combo
      const mirrorOk = mirror && mirror.matched && mirror.searchStatus === 'OK' && Array.isArray(mirror.combos);

      // Prefer the enriched detailCombos (real room+meal grid scraped from
      // /hotels/room-details) when present, fall back to listing-level combos.
      const richCombos = Array.isArray(ecdHotel.detailCombos) && ecdHotel.detailCombos.length > 0
        ? ecdHotel.detailCombos
        : (ecdHotel.combos || []);
      // When using detail combos we want ALL room/meal options compared, not
      // just top-N. When falling back to listing-level, top-N still applies.
      const ecdCombos = (Array.isArray(ecdHotel.detailCombos) && ecdHotel.detailCombos.length > 0)
        ? richCombos
        : richCombos.slice(0, settings.ECD_TOP_COMBOS_PER_HOTEL);

      let worstSeverity = null;
      const sevRank = { P0: 3, P1: 2, P2: 1 };
      const bumpSeverity = (s) => {
        if (!s) return;
        if (!worstSeverity || (sevRank[s] || 0) > (sevRank[worstSeverity] || 0)) worstSeverity = s;
      };

      let topVerdict = null;

      for (const ecdCombo of ecdCombos) {
        if (!mirrorOk) {
          const v = nonPriceVerdict('DEFAULT_STOCKOUT');
          baseRow.combos.push({
            roomCategory: ecdCombo.roomCategory,
            mealPlan: ecdCombo.mealPlan,
            ecd:    { totalPrice: ecdCombo.totalPrice, currency: ecdCombo.currency },
            normal: { totalPrice: null, currency: ecdCombo.currency, matched: false },
            diff:   { absINR: null, pct: null, cheaperSide: null },
            verdict: v.verdict,
            severity: v.severity,
            stockoutReason: mirror?.stockoutReason || 'NO_MIRROR_RESULT',
          });
          bumpSeverity(v.severity);
          topVerdict = topVerdict || v.verdict;
          continue;
        }

        // Hotel-level pricing path: when both sides have a single combo with
        // empty room/meal text (ECD result page shows one price per hotel),
        // pair them directly without going through the room+meal matcher.
        let best = null;
        const isHotelLevel =
          (!ecdCombo.roomCategory || !ecdCombo.roomCategory.trim()) &&
          (!ecdCombo.mealPlan || !ecdCombo.mealPlan.trim()) &&
          mirror.combos.length === 1 &&
          (!mirror.combos[0].roomCategory || !mirror.combos[0].roomCategory.trim());
        if (isHotelLevel) {
          best = { combo: mirror.combos[0], totalScore: 1.0 };
        } else {
          best = findBestComboMatch(ecdCombo, mirror.combos);
        }
        if (!best) {
          const v = nonPriceVerdict('COMBO_UNMATCHED');
          baseRow.combos.push({
            roomCategory: ecdCombo.roomCategory,
            mealPlan: ecdCombo.mealPlan,
            ecd:    { totalPrice: ecdCombo.totalPrice, currency: ecdCombo.currency },
            normal: { totalPrice: null, currency: ecdCombo.currency, matched: false },
            diff:   { absINR: null, pct: null, cheaperSide: null },
            verdict: v.verdict,
            severity: v.severity,
          });
          bumpSeverity(v.severity);
          topVerdict = topVerdict || v.verdict;
          continue;
        }

        const pv = priceVerdict(ecdCombo.totalPrice, best.combo.totalPrice);
        baseRow.combos.push({
          roomCategory: ecdCombo.roomCategory,
          mealPlan: ecdCombo.mealPlan,
          matchedNormalRoom: best.combo.roomCategory,
          matchedNormalMeal: best.combo.mealPlan,
          matchScore: best.totalScore,
          ecd:    { totalPrice: ecdCombo.totalPrice, currency: ecdCombo.currency },
          normal: { totalPrice: best.combo.totalPrice, currency: best.combo.currency, matched: true },
          diff:   { absINR: pv.absINR, pct: pv.pct, cheaperSide: pv.cheaperSide },
          verdict: pv.verdict,
          severity: pv.severity,
        });
        bumpSeverity(pv.severity);
        // Prefer the most severe / informative verdict as "top"
        if (!topVerdict || pv.severity) topVerdict = pv.verdict;
      }

      baseRow.severity = worstSeverity;
      baseRow.topVerdict = topVerdict || (baseRow.combos.length === 0 ? VERDICTS.COMBO_UNMATCHED : VERDICTS.EQUAL);
      hotelComparisons.push(baseRow);
    }
  }

  const summary = buildSummary(hotelComparisons);

  return {
    runId,
    timestamp: new Date().toISOString(),
    durationMs: (ecdRun?.durationMs || 0) + 0, // mirror duration is included implicitly via per-row loadTimeMs
    destinations,
    scenario,
    hotelComparisons,
    summary,
  };
}

function buildSummary(rows) {
  let totalCombos = 0;
  let ecdCheaper = 0;
  let normalCheaper = 0;
  let equal = 0;
  let defaultStockout = 0;
  let unmatched = 0;
  let ecdBroken = 0;
  let ecdAdvantageSumINR = 0;
  let ecdAdvantageCount = 0;

  for (const row of rows) {
    if (row.topVerdict === VERDICTS.ECD_BROKEN) ecdBroken++;
    for (const c of row.combos) {
      totalCombos++;
      switch (c.verdict) {
        case VERDICTS.ECD_CHEAPER:
          ecdCheaper++;
          if (typeof c.diff?.absINR === 'number') {
            ecdAdvantageSumINR += -c.diff.absINR;  // negative absINR means ECD cheaper
            ecdAdvantageCount++;
          }
          break;
        case VERDICTS.NORMAL_CHEAPER:    normalCheaper++; break;
        case VERDICTS.EQUAL:             equal++; break;
        case VERDICTS.DEFAULT_STOCKOUT:  defaultStockout++; break;
        case VERDICTS.COMBO_UNMATCHED:   unmatched++; break;
        default: break;
      }
    }
  }

  const pct = (n) => totalCombos > 0 ? Math.round((n / totalCombos) * 1000) / 10 : 0;

  return {
    totalCombosCompared: totalCombos,
    ecdCheaperCount: ecdCheaper,
    normalCheaperCount: normalCheaper,
    equalCount: equal,
    ecdCheaperPct: pct(ecdCheaper),
    normalCheaperPct: pct(normalCheaper),
    equalPct: pct(equal),
    defaultStockoutCount: defaultStockout,
    unmatchedComboCount: unmatched,
    ecdBrokenCount: ecdBroken,
    avgEcdAdvantageINR: ecdAdvantageCount > 0
      ? Math.round(ecdAdvantageSumINR / ecdAdvantageCount)
      : 0,
  };
}

module.exports = { buildComparison, buildSummary };

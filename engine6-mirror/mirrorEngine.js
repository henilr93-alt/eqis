// mirrorEngine.js — Engine 6 entry point.
//
// Strategy (2026-05-31 — third iteration):
//   For each ECD hotel found by engine5, type that hotel's NAME into the
//   normal /hotels autosuggest, pick the hotel-type suggestion (autosuggest
//   tolerates spacing/casing variations), then open the detail page and
//   scrape the full room+meal+price grid.
//
//   This replaces the previous "search by city" approach which kept matching
//   ECD hotels to the wrong bedbank hotels (because they share only city
//   tokens like "Phu Quoc").
//
// ZERO IMPORTS FROM engine3-searchpulse. Uses utils/* read-only.

const logger = require('../utils/logger');
const browserModule = require('../utils/etravBrowser');
const login = require('../utils/etravLogin');
const { searchNormalByHotelName } = require('./searchNormalByHotelName');
const { openHotelDetailTab, extractRoomCombos } = require('./hotelDetailScraper');
const ecdActivity = require('../utils/ecdActivity');
const ecdLiveProgress = require('../utils/ecdLiveProgress');
const { buildComparison } = require('../ecd-comparator/comparator');

let _mirrorRunning = false;

async function runMirrorEngine(ecdRunOutput) {
  if (_mirrorRunning) {
    logger.warn('[MIRROR] Engine already running — skipping concurrent invocation');
    return { runId: ecdRunOutput.runId, mirrorResults: [], skipped: true };
  }
  _mirrorRunning = true;

  const { runId, ecdResults, scenario } = ecdRunOutput || {};
  if (!ecdResults || ecdResults.length === 0) {
    _mirrorRunning = false;
    return { runId, mirrorResults: [] };
  }

  // Flatten ECD hotels we need to mirror, preserving their date/pax context
  const hotelsToMirror = [];
  for (const ecd of ecdResults) {
    if (ecd.searchStatus !== 'OK' || !Array.isArray(ecd.hotels) || ecd.hotels.length === 0) continue;
    for (const h of ecd.hotels) {
      hotelsToMirror.push({
        destination: ecd.destination,
        city: ecd.selectedCity || ecd.destination,
        ecdHotel: h,
        checkin: ecd.checkin,
        checkout: ecd.checkout,
        adults: ecd.adults,
        rooms: ecd.rooms,
      });
    }
  }

  logger.info('[MIRROR] Run ' + runId + ' starting — ' + hotelsToMirror.length + ' ECD hotels to mirror by name');
  ecdLiveProgress.startRun(runId, hotelsToMirror.length);

  if (hotelsToMirror.length === 0) {
    _mirrorRunning = false;
    return { runId, mirrorResults: [] };
  }

  let browser, page;
  const mirrorResults = [];

  try {
    const launched = await browserModule.launch();
    browser = launched.browser;
    page = launched.page;
    const context = page.context();
    await login.authenticate(page);

    for (const item of hotelsToMirror) {
      const ecdHotel = item.ecdHotel;
      ecdActivity.set('bedbank-search', 'Searching bedbank for: ' + ecdHotel.name);
      logger.info('[MIRROR] Bedbank search for "' + ecdHotel.name + '" (via autosuggest)');

      const normal = await searchNormalByHotelName(page, {
        hotelName: ecdHotel.name,
        checkin: item.checkin,
        checkout: item.checkout,
        // 2026-06-09: pax symmetry (Fix A) — propagate the ECD scenario's
        // adults/rooms so the mirror search produces a comparable market
        // total. Without this the /hotels form silently uses whatever pax
        // was last set in the session, breaking per-room-per-night math.
        adults: item.adults,
        rooms: item.rooms,
        runId,
      });

      if (normal.status !== 'OK') {
        mirrorResults.push({
          destination: item.destination,
          city: item.city,
          ecdHotelName: ecdHotel.name,
          ecdHotelId: ecdHotel.ecdHotelId || null,
          ecdCombos: ecdHotel.combos,
          ecdDetailCombos: ecdHotel.detailCombos || [],
          matched: false,
          searchStatus: normal.status === 'AUTOSUGGEST_FAILED' ? 'DEFAULT_STOCKOUT' : normal.status,
          stockoutReason: normal.error || normal.status,
          combos: [],
          normalSearchPageUrl: normal.pageUrl,
        });
        continue;
      }

      // The listing should now have the matched hotel as the first / top result.
      // Open its detail page in a new tab.
      let detailCombos = [];
      let detailError = null;
      let matchedNormalName = null;
      ecdActivity.set('bedbank-detail', 'Reading bedbank rooms for: ' + ecdHotel.name);
      try {
        const detailOpen = await openHotelDetailTab(context, page, null); // first card on filtered list
        if (detailOpen.newPage) {
          detailCombos = await extractRoomCombos(detailOpen.newPage);
          matchedNormalName = await detailOpen.newPage.evaluate(() => {
            // Look for the hotel-title element specifically, not just any heading
            const sel = ['[class*="hotelName" i]', '[class*="hotel-name" i]', 'h1', 'h2', 'h3'];
            for (const s of sel) {
              const els = document.querySelectorAll(s);
              for (const el of els) {
                const t = (el.textContent || '').trim();
                // Reject section headings like "Facilities", "Reviews", "Policies"
                if (t.length > 5 && !/^(facilities|reviews|policies|amenities|location|gallery|rooms|book\s*now|check\s*in|check\s*out|essential)$/i.test(t)) {
                  return t;
                }
              }
            }
            return null;
          }).catch(() => null);
          logger.info('[MIRROR] ' + (matchedNormalName || ecdHotel.name) + ': ' + detailCombos.length + ' bedbank room rates');
          await detailOpen.newPage.close().catch(() => {});
        } else {
          detailError = detailOpen.error || 'unknown';
        }
      } catch (err) { detailError = err.message; }

      mirrorResults.push({
        destination: item.destination,
        city: item.city,
        ecdHotelName: ecdHotel.name,
        ecdHotelId: ecdHotel.ecdHotelId || null,
        ecdCombos: ecdHotel.combos,
        ecdDetailCombos: ecdHotel.detailCombos || [],
        matched: detailCombos.length > 0,
        matchedNormalName: matchedNormalName || normal.pickedSuggestion,
        matchScore: normal.pickScore,
        searchStatus: detailCombos.length > 0 ? 'OK' : 'NO_DETAIL_COMBOS',
        combos: detailCombos.map((c) => ({
          roomCategory: c.roomCategory,
          mealPlan: c.mealPlan,
          totalPrice: c.totalPrice,
          currency: c.currency,
          rateName: c.rateName,
          refundPolicy: c.refundPolicy,
          matched: true,
        })),
        detailError,
        normalSearchPageUrl: normal.pageUrl,
      });

      // LIVE INCREMENTAL UPDATE — build a single-hotel comparison and append to
      // state/ecdLiveProgress.json so the dashboard can show it immediately.
      try {
        const lastPushed = mirrorResults[mirrorResults.length - 1];
        const partialEcdRun = {
          runId,
          destinations: [item.destination],
          scenario: { adults: item.adults, rooms: item.rooms, checkin: item.checkin, checkout: item.checkout },
          ecdResults: [{
            destination: item.destination,
            selectedCity: item.city,
            searchStatus: 'OK',
            checkin: item.checkin,
            checkout: item.checkout,
            adults: item.adults,
            rooms: item.rooms,
            hotels: [ecdHotel],
          }],
        };
        const partialMirrorRun = { runId, mirrorResults: [lastPushed] };
        const partial = buildComparison(partialEcdRun, partialMirrorRun);
        for (const row of (partial.hotelComparisons || [])) {
          // Replace any earlier "pending" row for this hotel with the full comparison
          const cur = ecdLiveProgress.read();
          if (cur && Array.isArray(cur.hotelComparisons)) {
            const idx = cur.hotelComparisons.findIndex(r => r._pendingMirror && r.hotelName === row.hotelName && r.destination === row.destination);
            if (idx >= 0) {
              cur.hotelComparisons.splice(idx, 1);
              // Write back without the placeholder, then add the real row
              require('fs').writeFileSync(require('path').join(__dirname, '..', 'state', 'ecdLiveProgress.json'), JSON.stringify(cur, null, 2));
            }
          }
          ecdLiveProgress.addHotelRow(row);
        }
      } catch (e) {
        logger.warn('[MIRROR] live-progress write skipped: ' + e.message);
      }
    }
  } catch (err) {
    logger.error('[MIRROR] Run ' + runId + ' failed: ' + err.message);
    mirrorResults.push({ destination: null, searchStatus: 'ENGINE_ERROR', error: err.message });
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    _mirrorRunning = false;
  }

  const okCount = mirrorResults.filter((r) => r.searchStatus === 'OK').length;
  logger.info('[MIRROR] Run ' + runId + ' complete — ' + okCount + '/' + mirrorResults.length + ' matched');
  return { runId, mirrorResults, scenario };
}

module.exports = { runMirrorEngine };

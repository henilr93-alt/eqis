// ecdEngine.js — Engine 5 entry point. Searches Eagle Crest direct-contracted
// inventory (ECD) for a rotated set of destinations and produces a structured
// hotel list that engine6-mirror will use to query the normal /hotels search.
//
// ZERO IMPORTS FROM engine3-searchpulse. Uses utils/* read-only.

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const settings = require('../config/settings');
const browserModule = require('../utils/etravBrowser');
const login = require('../utils/etravLogin');
const { nextBatch } = require('./ecdDestinationRotator');
const { searchEcdDestination, listCitiesForDestination } = require('./ecdHotelSearcher');
const ecdActivity = require('../utils/ecdActivity');
const ecdLiveProgress = require('../utils/ecdLiveProgress');
const { openHotelDetailTab, extractRoomCombos } = require('../engine6-mirror/hotelDetailScraper');

let _ecdRunning = false; // own lock — independent of SearchPulse's _pulseRunning

function generateRunId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `ECD-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function defaultScenarioDates() {
  // Search rule (user 2026-06-01): randomize check-in within 30 days from
  // today, and stay length between 3-5 nights. New dates are picked on every
  // cycle so the portfolio builds price coverage across different windows
  // (weekday/weekend, peak/off-peak) over time.
  const offsetDays = 1 + Math.floor(Math.random() * 30);    // 1..30 days out
  const nights = 3 + Math.floor(Math.random() * 3);          // 3..5 nights
  const checkin = addDays(new Date(), offsetDays);
  const checkout = addDays(checkin, nights);
  return {
    checkin: checkin.toISOString().split('T')[0],
    checkout: checkout.toISOString().split('T')[0],
  };
}

/**
 * Run one ECD pulse: pick N destinations, search each on the ECD tab, return
 * the aggregated ECD hotel list. Caller (eqis.js / orchestrator) then hands
 * this off to engine6-mirror for the comparison searches.
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.destinations]  override rotation (used by manual run/recon)
 * @returns {Promise<{runId, destinations, ecdResults, durationMs}>}
 */
async function runEcdEngine(opts = {}) {
  if (_ecdRunning) {
    logger.warn('[ECD] Engine already running — skipping concurrent invocation');
    return { runId: null, destinations: [], ecdResults: [], skipped: true };
  }
  _ecdRunning = true;

  const runId = generateRunId();
  const t0 = Date.now();
  const destinations = opts.destinations && opts.destinations.length
    ? opts.destinations
    : nextBatch(settings.ECD_DESTINATIONS_PER_RUN);

  logger.info(`[ECD] Run ${runId} starting — destinations: ${destinations.join(', ') || '(none)'}`);
  ecdLiveProgress.startRun(runId, 0); // total will be filled once ECD search completes

  if (destinations.length === 0) {
    _ecdRunning = false;
    return {
      runId,
      destinations: [],
      ecdResults: [],
      durationMs: Date.now() - t0,
      error: 'ECD destination list is empty (populate state/ecdRotation.json)',
    };
  }

  const { checkin, checkout } = defaultScenarioDates();
  // Pax / rooms rule (user 2026-06-01 fix #1 — LOCKED to 1 room/2 adults):
  //   The fillHotelPax helper drifts the page to homepage when filling 2+ rooms
  //   on the /echotel form. Until that helper is fixed (audit #2 pending), we
  //   lock the scenario to 1 room / 2 adults, which lets the searcher SKIP the
  //   pax-fill step entirely (matches ECD form defaults).
  const rooms = 1;
  const adults = 2;
  const scenario = { checkin, checkout, adults, rooms };
  logger.info(`[ECD-ENGINE] Search scenario: ${rooms} room · ${adults} adults (locked) · ${checkin} → ${checkout}`);

  let browser, page;
  const ecdResults = [];

  try {
    const launched = await browserModule.launch();
    browser = launched.browser;
    page = launched.page;

    await login.authenticate(page);

    const context = page.context();
    for (const dest of destinations) {
      // Discover every city this country exposes on the ECD form, then
      // iterate them so we never miss hotels in (e.g.) Bali or Phuket while
      // only scraping Nusa Penida or Bangkok.
      ecdActivity.set('ecd-search', 'Discovering cities for ' + dest);
      const discovery = await listCitiesForDestination(page, dest);
      const cities = (discovery.cities && discovery.cities.length > 0) ? discovery.cities : [dest];
      logger.info(`[ECD-ENGINE] ${dest} has ${cities.length} cities: ${cities.join(', ')}`);

      for (const city of cities) {
        ecdActivity.set('ecd-search', 'Searching Eagle Crest for ' + dest + ' / ' + city);
        const result = await searchEcdDestination(page, {
          destination: dest,
          city,
          ...scenario,
          runId,
        });

        // After listing search, enrich each hotel with full room/meal/price grid
        // by clicking Book Now → opens detail in new tab → scrape → close.
        if (result.searchStatus === 'OK' && Array.isArray(result.hotels)) {
          for (const hotel of result.hotels) {
            ecdActivity.set('ecd-detail', 'Reading rooms for ECD: ' + hotel.name);
            try {
              const detailOpen = await openHotelDetailTab(context, page, hotel.name);
              if (detailOpen.newPage) {
                const roomCombos = await extractRoomCombos(detailOpen.newPage);
                hotel.detailCombos = roomCombos;
                hotel.detailUrl = detailOpen.newPage.url();
                logger.info('[ECD] ' + hotel.name + ': ' + roomCombos.length + ' room rates scraped');
                await detailOpen.newPage.close().catch(() => {});
                // Write an ECD-only partial row so dashboard shows this hotel right away
                try {
                  const ecdMin = roomCombos.length > 0 ? Math.min.apply(null, roomCombos.map(c => c.totalPrice || Infinity)) : null;
                  ecdLiveProgress.addHotelRow({
                    destination: dest,
                    city: result.selectedCity || city,
                    hotelName: hotel.name,
                    starRating: hotel.starRating || null,
                    ecdHotelId: hotel.ecdHotelId || null,
                    checkin: scenario.checkin,
                    checkout: scenario.checkout,
                    pax: { adults: scenario.adults, rooms: scenario.rooms },
                    topVerdict: 'PENDING_BEDBANK',
                    severity: null,
                    combos: [{
                      roomCategory: hotel.name + ' (lowest)',
                      mealPlan: '',
                      ecd: { totalPrice: ecdMin, currency: 'INR' },
                      normal: { totalPrice: null, currency: 'INR', matched: false },
                      diff: { absINR: null, pct: null, cheaperSide: null },
                      verdict: 'PENDING_BEDBANK',
                      severity: null,
                    }],
                    _pendingMirror: true,
                  });
                } catch (e) { logger.warn('[ECD] live-progress write skipped: ' + e.message); }
              } else {
                hotel.detailCombos = [];
                hotel.detailError = detailOpen.error || 'unknown';
                logger.warn('[ECD] ' + hotel.name + ': detail page failed — ' + (detailOpen.error || ''));
              }
            } catch (err) {
              hotel.detailCombos = [];
              hotel.detailError = err.message;
              logger.warn('[ECD] ' + hotel.name + ': detail scrape error — ' + err.message);
            }
          }
        }

        ecdResults.push(result);
      }
    }
  } catch (err) {
    logger.error(`[ECD] Run ${runId} failed: ${err.message}`);
    ecdResults.push({ destination: null, searchStatus: 'ENGINE_ERROR', error: err.message });
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    _ecdRunning = false;
  }

  const durationMs = Date.now() - t0;
  logger.info(`[ECD] Run ${runId} complete in ${(durationMs / 1000).toFixed(1)}s — ${ecdResults.filter(r => r.searchStatus === 'OK').length}/${ecdResults.length} OK`);

  return { runId, destinations, ecdResults, durationMs, scenario };
}

/**
 * Standalone runner for `node engine5-ecd/ecdEngine.js <destination>` (recon / dev).
 */
if (require.main === module) {
  const cliDest = process.argv[2];
  const overrides = cliDest ? { destinations: [cliDest] } : {};
  runEcdEngine(overrides)
    .then((res) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runEcdEngine };
